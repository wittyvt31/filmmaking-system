import { createReadStream, existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AssetVersionReferenceSchema,
  canonicalJsonSha256,
  compareStrings,
  RenderPolicySchema,
  ShotSchema,
  type ArtifactInspection,
  type ArtifactInspectionRequest,
  type FailedRenderReceipt,
  type RendererAdapter,
  type RendererAssetInput,
  type RendererCapabilities,
  type RendererErrorCode,
  type RendererIdentity,
  type RendererOperationResult,
  type RenderShotRequest,
  type RenderShotResult,
  type SuccessfulRenderReceipt,
} from '@filmmaking/contracts';
import { AssetRegistryError } from '@filmmaking/assets';
import { ArtifactCache } from '@filmmaking/cache';
import { compileScene, SCENE_COMPILER_VERSION } from '@filmmaking/scene';

export const EXPECTED_BLENDER_VERSION = '5.2.3';
const RENDERER_ID = 'blender';
const ENGINE_PACKAGE_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);
const WORKER_PATH = join(ENGINE_PACKAGE_DIRECTORY, 'worker', 'render_shot.py');
export const ASSET_WORKER_PATH = join(
  ENGINE_PACKAGE_DIRECTORY,
  'worker',
  'build_assets.py',
);
export const ARTWORK_WORKER_PATH = join(
  ENGINE_PACKAGE_DIRECTORY,
  'worker',
  'prepare_artwork.py',
);
const ROOT_LOCKFILE = resolve(
  ENGINE_PACKAGE_DIRECTORY,
  '..',
  '..',
  'pnpm-lock.yaml',
);
const SUPPORTED_ARTIFACTS = ['image-sequence/png'] as const;

export function defaultBlenderExecutable(): string {
  if (process.env['FILMIE_BLENDER']) return process.env['FILMIE_BLENDER'];
  if (process.platform === 'win32') {
    const candidate = join(
      process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
      'Blender Foundation',
      'Blender 5.2',
      'blender.exe',
    );
    if (existsSync(candidate)) return candidate;
  }
  return 'blender';
}

export async function runBlenderProcess(
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessResult> {
  return await spawnCapture(executable, args, options);
}

class BlenderFailure extends Error {
  constructor(
    readonly code: RendererErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'BlenderFailure';
  }
}

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  interrupted: boolean;
}

function spawnCapture(
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let interrupted = false;
    let settled = false;
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    const abort = () => {
      interrupted = true;
      child.kill();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-1_000_000);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1_000_000);
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolvePromise({ code, signal, stdout, stderr, timedOut, interrupted });
    });
  });
}

async function sha256File(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    hash.update(buffer);
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Blender output cannot contain symbolic links: ${path}`);
    if (entry.isDirectory()) paths.push(...(await listFiles(path)));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Unsupported Blender output entry: ${path}`);
  }
  return paths;
}

async function checksumsFor(directory: string) {
  const files = await listFiles(directory);
  if (files.length === 0)
    throw new BlenderFailure(
      'INCOMPLETE_OUTPUT',
      'Blender produced an empty output directory',
    );
  const checksums = [];
  for (const path of files) {
    const checksum = await sha256File(path);
    checksums.push({ path, ...checksum });
  }
  return checksums;
}

function pngSize(header: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    header.length < 24 ||
    !header.subarray(0, 8).equals(signature) ||
    header.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new BlenderFailure(
      'INCOMPLETE_OUTPUT',
      'Renderer output is not a valid PNG image',
    );
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

async function validateSequence(
  directory: string,
  expected: { frames: number; width: number; height: number },
) {
  const frameDirectory = join(directory, 'frames');
  const entries = await readdir(frameDirectory, { withFileTypes: true });
  const pngs = entries
    .filter((entry) => entry.isFile() && /^frame_\d{6}\.png$/.test(entry.name))
    .sort((left, right) => compareStrings(left.name, right.name));
  if (pngs.length !== expected.frames) {
    throw new BlenderFailure(
      'INCOMPLETE_OUTPUT',
      `Expected ${expected.frames} PNG frames, found ${pngs.length}`,
    );
  }
  for (let index = 0; index < pngs.length; index += 1) {
    const entry = pngs[index];
    const expectedName = `frame_${String(index + 1).padStart(6, '0')}.png`;
    if (!entry || entry.name !== expectedName) {
      throw new BlenderFailure(
        'INCOMPLETE_OUTPUT',
        `Expected consecutive frame ${expectedName}`,
      );
    }
    const path = join(frameDirectory, entry.name);
    const info = await stat(path);
    if (!info.isFile() || info.size === 0)
      throw new BlenderFailure('INCOMPLETE_OUTPUT', `Frame is empty: ${path}`);
    const header = await readFile(path).then((buffer) =>
      buffer.subarray(0, 24),
    );
    const size = pngSize(header);
    if (size.width !== expected.width || size.height !== expected.height) {
      throw new BlenderFailure(
        'INCOMPLETE_OUTPUT',
        `Frame ${entry.name} is ${size.width}x${size.height}; expected ${expected.width}x${expected.height}`,
      );
    }
  }
  const scenePath = join(directory, 'scene.blend');
  const sceneInfo = await stat(scenePath).catch(() => null);
  if (!sceneInfo?.isFile() || sceneInfo.size === 0)
    throw new BlenderFailure(
      'INCOMPLETE_OUTPUT',
      'Blender did not save a non-empty scene.blend file',
    );
  const workerResult = JSON.parse(
    await readFile(join(directory, 'worker-result.json'), 'utf8'),
  ) as { status?: unknown; frameCount?: unknown };
  if (
    workerResult.status !== 'success' ||
    workerResult.frameCount !== expected.frames
  ) {
    throw new BlenderFailure(
      'INCOMPLETE_OUTPUT',
      'Blender worker did not report successful completion with the expected frame count',
    );
  }
  return await checksumsFor(directory);
}

async function promoteDirectory(
  staged: string,
  destination: string,
): Promise<void> {
  try {
    await rename(staged, destination);
  } catch (error) {
    const backup = `${destination}.previous-${randomUUID()}`;
    try {
      await rename(destination, backup);
    } catch {
      throw error;
    }
    try {
      await rename(staged, destination);
    } catch (promotionError) {
      await rename(backup, destination);
      throw promotionError;
    }
    await rm(backup, { recursive: true, force: true });
  }
}

async function writeReceipt(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function errorInfo(error: unknown): {
  code: RendererErrorCode;
  message: string;
  retryable: boolean;
} {
  if (error instanceof BlenderFailure)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  if (error instanceof AssetRegistryError)
    return { code: 'MISSING_ASSET', message: error.message, retryable: false };
  return {
    code: 'RENDER_CRASHED',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function assetKey(
  asset: Pick<RendererAssetInput, 'assetId' | 'version'>,
): string {
  return `${asset.assetId}\u0000${asset.version}`;
}

export class BlenderRendererAdapter implements RendererAdapter {
  readonly identity: RendererIdentity = {
    id: RENDERER_ID,
    version: EXPECTED_BLENDER_VERSION,
  };
  readonly executablePath: string;
  readonly samples: number;
  #versionPromise: Promise<string> | undefined;

  constructor(
    config: {
      executablePath?: string | undefined;
      samples?: number | undefined;
    } = {},
  ) {
    this.executablePath = config.executablePath ?? defaultBlenderExecutable();
    this.samples = config.samples ?? 8;
  }

  async #inspectVersion(timeoutMs = 15_000): Promise<string> {
    this.#versionPromise ??= spawnCapture(this.executablePath, ['--version'], {
      timeoutMs,
    })
      .then((result) => {
        if (result.code !== 0)
          throw new BlenderFailure(
            'RENDER_CRASHED',
            `Blender version check exited ${result.code}: ${result.stderr || result.stdout}`,
          );
        const match = /Blender\s+(\d+\.\d+\.\d+)/.exec(result.stdout);
        if (!match?.[1])
          throw new BlenderFailure(
            'RENDER_CRASHED',
            'Could not identify Blender version from --version output',
          );
        if (match[1] !== EXPECTED_BLENDER_VERSION)
          throw new BlenderFailure(
            'UNSUPPORTED_SETTINGS',
            `Expected Blender ${EXPECTED_BLENDER_VERSION}, found ${match[1]}`,
          );
        return match[1];
      })
      .catch((error: unknown) => {
        this.#versionPromise = undefined;
        throw error;
      });
    return this.#versionPromise;
  }

  async inspectCapabilities(): Promise<
    RendererOperationResult<RendererCapabilities>
  > {
    try {
      const version = await this.#inspectVersion();
      return {
        status: 'success',
        value: {
          identity: { id: RENDERER_ID, version },
          artifactTypes: SUPPORTED_ARTIFACTS,
          videoCodecs: [],
          pixelFormats: ['rgba'],
          colorProfiles: ['linear'],
        },
      };
    } catch (error) {
      const info = errorInfo(error);
      return { status: 'failure', error: info };
    }
  }

  async inspectArtifact(
    request: ArtifactInspectionRequest,
  ): Promise<RendererOperationResult<ArtifactInspection>> {
    try {
      if (request.artifactType !== 'image-sequence/png')
        throw new BlenderFailure(
          'UNSUPPORTED_ARTIFACT',
          `Blender adapter cannot inspect ${request.artifactType}`,
        );
      const path = resolve(request.path);
      const checksums = await validateSequence(path, {
        frames: request.expectedFrameCount ?? 1,
        width: request.expectedWidth ?? 1,
        height: request.expectedHeight ?? 1,
      });
      return {
        status: 'success',
        value: {
          artifactType: 'image-sequence/png',
          outputChecksums: checksums,
          ...(request.expectedFrameCount !== undefined
            ? { frameCount: request.expectedFrameCount }
            : {}),
        },
      };
    } catch (error) {
      return { status: 'failure', error: errorInfo(error) };
    }
  }

  async renderShot(request: RenderShotRequest): Promise<RenderShotResult> {
    const started = new Date();
    let fingerprint = canonicalJsonSha256({
      renderer: this.identity,
      shot: request.shot,
      assets: request.assets.map((asset) => ({
        assetId: asset.assetId,
        version: asset.version,
        contentHash: asset.contentHash,
        metadata: asset.metadata,
      })),
      settings: request.settings,
    });
    const logs: string[] = [];
    const outputDirectory =
      request.artifact.type === 'image-sequence/png'
        ? resolve(request.artifact.outputDirectory)
        : resolve(
            request.artifact.type === 'video/mp4'
              ? request.artifact.outputPath
              : request.artifact.outputPath,
          );
    const receiptPath = resolve(
      request.receiptPath ?? `${outputDirectory}.receipt.json`,
    );
    const metrics: Record<string, number | string | boolean> = {};
    let workDirectoryToClean: string | undefined;
    const finishFailure = async (error: unknown): Promise<RenderShotResult> => {
      const failure = errorInfo(error);
      const receipt: FailedRenderReceipt = {
        jobId: request.jobId,
        shotId: request.shot.id,
        renderer: this.identity,
        fingerprint,
        startedAt: started.toISOString(),
        completedAt: new Date().toISOString(),
        status: 'failure',
        outputPaths: [],
        outputChecksums: [],
        logs,
        metrics,
        error: failure,
      };
      await writeReceipt(receiptPath, receipt).catch((writeError: unknown) =>
        logs.push(`Failure receipt write failed: ${String(writeError)}`),
      );
      return { status: 'failure', receipt, error: failure };
    };
    try {
      if (request.artifact.type !== 'image-sequence/png')
        throw new BlenderFailure(
          'UNSUPPORTED_ARTIFACT',
          'Blender renders verified PNG sequences; shot MP4 encoding is owned by the media engine',
        );
      const shot = ShotSchema.parse(request.shot);
      const settings = RenderPolicySchema.parse(request.settings);
      if (settings.renderer.id !== 'blender')
        throw new BlenderFailure(
          'UNSUPPORTED_SETTINGS',
          'Manifest render policy does not select Blender',
        );
      if (!shot.scene)
        throw new BlenderFailure(
          'INVALID_INSTRUCTIONS',
          'Blender rendering requires structured shot.scene instructions',
        );
      if (request.randomSeed < 0 || !Number.isSafeInteger(request.randomSeed))
        throw new BlenderFailure(
          'INVALID_INSTRUCTIONS',
          'Random seed must be a non-negative safe integer',
        );
      await this.#inspectVersion(request.timeoutMs ?? 15_000);
      if (!existsSync(WORKER_PATH))
        throw new BlenderFailure(
          'RENDER_CRASHED',
          `Blender worker was not found at ${WORKER_PATH}`,
        );
      const compiledScene =
        request.scene ?? compileScene(shot, settings.frameRate);
      if (
        compiledScene.shotId !== shot.id ||
        compiledScene.durationFrames !== shot.durationFrames
      )
        throw new BlenderFailure(
          'INVALID_INSTRUCTIONS',
          'Compiled scene does not match the requested shot and duration',
        );
      const supportedActions = new Set([
        'breathing',
        'head-turn',
        'blink',
        'expression',
        'walk',
        'run',
        'jump',
        'kick',
        'celebrate',
        'sit',
        'stand',
        'lip-sync',
        'reach',
        'grasp',
        'lift',
        'place',
        'interaction',
        'motion-clip',
      ]);
      const unsupportedAction = compiledScene.actions.find(
        ({ action }) => !supportedActions.has(action.type),
      );
      if (unsupportedAction)
        throw new BlenderFailure(
          'INVALID_INSTRUCTIONS',
          `Blender does not yet implement the "${unsupportedAction.action.type}" action`,
        );

      const assetMap = new Map<string, RendererAssetInput>();
      for (const asset of request.assets) {
        const reference = AssetVersionReferenceSchema.parse({
          assetId: asset.assetId,
          version: asset.version,
        });
        if (assetMap.has(assetKey(reference)))
          throw new BlenderFailure(
            'INVALID_INSTRUCTIONS',
            `Asset ${asset.assetId}@${asset.version} was supplied more than once`,
          );
        const actual = await sha256File(asset.localPath);
        if (actual.sha256 !== asset.contentHash)
          throw new BlenderFailure(
            'MISSING_ASSET',
            `Asset content hash changed for ${asset.assetId}@${asset.version}`,
          );
        assetMap.set(assetKey(reference), asset);
      }
      const resolveAsset = (reference: {
        assetId: string;
        version: string;
      }) => {
        const asset = assetMap.get(assetKey(reference));
        if (!asset)
          throw new BlenderFailure(
            'MISSING_ASSET',
            `Missing scene asset ${reference.assetId}@${reference.version}`,
          );
        return {
          assetId: asset.assetId,
          version: asset.version,
          localPath: asset.localPath,
          contentHash: asset.contentHash,
          metadata: asset.metadata,
        };
      };
      const workerHash = createHash('sha256')
        .update(await readFile(WORKER_PATH))
        .digest('hex');
      const lockHash = createHash('sha256')
        .update(await readFile(ROOT_LOCKFILE))
        .digest('hex');
      const dependenciesHash = canonicalJsonSha256({
        workerHash,
        lockHash,
        compilerVersion: SCENE_COMPILER_VERSION,
      });
      fingerprint = canonicalJsonSha256({
        shot,
        compiledScene,
        assets: request.assets
          .map((asset) => ({
            assetId: asset.assetId,
            version: asset.version,
            contentHash: asset.contentHash,
            metadata: asset.metadata,
          }))
          .sort((left, right) =>
            compareStrings(
              `${left.assetId}@${left.version}`,
              `${right.assetId}@${right.version}`,
            ),
          ),
        renderer: { id: RENDERER_ID, version: await this.#inspectVersion() },
        dependenciesHash,
        renderSettings: {
          outputDimensions: settings.outputDimensions,
          frameRate: settings.frameRate,
          engine: settings.renderer.config.engine,
          samples: settings.renderer.config.samples ?? this.samples,
          randomSeed: request.randomSeed,
        },
        fonts: [],
      });
      const cache = new ArtifactCache(request.cacheDirectory);
      const cached = await cache.restore(
        fingerprint,
        'image-sequence/png',
        outputDirectory,
      );
      if (cached) {
        const checksums = await validateSequence(outputDirectory, {
          frames: shot.durationFrames,
          width: settings.outputDimensions.width,
          height: settings.outputDimensions.height,
        });
        const receipt: SuccessfulRenderReceipt = {
          jobId: request.jobId,
          shotId: shot.id,
          renderer: this.identity,
          fingerprint,
          startedAt: started.toISOString(),
          completedAt: new Date().toISOString(),
          status: 'success',
          artifactType: 'image-sequence/png',
          outputPaths: checksums.map((item) => item.path),
          outputChecksums: checksums,
          logs: ['Blender PNG sequence cache hit'],
          metrics: { cacheHit: true, frameCount: shot.durationFrames },
        };
        await writeReceipt(receiptPath, receipt);
        return { status: 'success', receipt, cacheHit: true };
      }
      const parent = dirname(outputDirectory);
      await mkdir(parent, { recursive: true });
      const workDirectory = await mkdtemp(join(parent, '.blender-work-'));
      workDirectoryToClean = workDirectory;
      const stagedDirectory = join(workDirectory, 'artifact');
      const frameDirectory = join(stagedDirectory, 'frames');
      await mkdir(frameDirectory, { recursive: true });
      const specPath = join(workDirectory, 'worker-spec.json');
      const scene = compiledScene;
      const workerSpec = {
        durationFrames: shot.durationFrames,
        frameRate: settings.frameRate,
        width: settings.outputDimensions.width,
        height: settings.outputDimensions.height,
        samples: settings.renderer.config.samples ?? this.samples,
        randomSeed: request.randomSeed,
        outputDirectory: stagedDirectory,
        style: scene.style,
        animationLibraryVersion: scene.animationLibraryVersion,
        environment: resolveAsset(scene.environment),
        groups: scene.groups,
        layers: scene.layers.map((layer) => ({
          ...layer,
          asset: resolveAsset(layer.asset),
        })),
        characters: scene.characters.map((character) => ({
          ...character,
          artwork: resolveAsset(character.artwork),
          rig: character.rig ? resolveAsset(character.rig) : null,
        })),
        props: scene.props.map((prop) => ({
          ...prop,
          artwork: resolveAsset(prop.artwork),
        })),
        lights: scene.lights,
        camera: scene.camera,
        cameraKeyframes: scene.cameraKeyframes,
        actions: scene.actions,
        motionCurves: scene.motionCurves,
      };
      await writeFile(specPath, JSON.stringify(workerSpec), { flag: 'wx' });
      const startedRender = Date.now();
      const processResult = await spawnCapture(
        this.executablePath,
        [
          '--background',
          '--factory-startup',
          '--python',
          WORKER_PATH,
          '--',
          specPath,
        ],
        {
          timeoutMs: request.timeoutMs ?? 600_000,
          ...(request.signal ? { signal: request.signal } : {}),
        },
      );
      metrics['renderDurationMs'] = Date.now() - startedRender;
      if (processResult.stdout.trim())
        logs.push(...processResult.stdout.trim().split(/\r?\n/).slice(-500));
      if (processResult.stderr.trim())
        logs.push(...processResult.stderr.trim().split(/\r?\n/).slice(-500));
      if (processResult.timedOut)
        throw new BlenderFailure(
          'TIMEOUT',
          `Blender timed out after ${request.timeoutMs ?? 600_000} ms`,
          true,
        );
      if (processResult.interrupted)
        throw new BlenderFailure(
          'INTERRUPTED',
          'Blender render was interrupted',
          true,
        );
      if (processResult.code !== 0)
        throw new BlenderFailure(
          'RENDER_CRASHED',
          `Blender exited with code ${String(processResult.code)}${processResult.signal ? ` (${processResult.signal})` : ''}: ${processResult.stderr || processResult.stdout}`,
          true,
        );
      const stagedChecksums = await validateSequence(stagedDirectory, {
        frames: shot.durationFrames,
        width: settings.outputDimensions.width,
        height: settings.outputDimensions.height,
      });
      await promoteDirectory(stagedDirectory, outputDirectory);
      const checksums = stagedChecksums.map((item) => ({
        ...item,
        path: item.path.replace(stagedDirectory, outputDirectory),
      }));
      metrics['frameCount'] = shot.durationFrames;
      metrics['cacheHit'] = false;
      const receipt: SuccessfulRenderReceipt = {
        jobId: request.jobId,
        shotId: shot.id,
        renderer: this.identity,
        fingerprint,
        startedAt: started.toISOString(),
        completedAt: new Date().toISOString(),
        status: 'success',
        artifactType: 'image-sequence/png',
        outputPaths: checksums.map((item) => item.path),
        outputChecksums: checksums,
        logs,
        metrics,
      };
      try {
        await cache.store(fingerprint, 'image-sequence/png', outputDirectory);
      } catch (error) {
        logs.push(
          `Could not store Blender shot cache: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await writeReceipt(receiptPath, receipt);
      await rm(workDirectory, { recursive: true, force: true });
      workDirectoryToClean = undefined;
      return { status: 'success', receipt, cacheHit: false };
    } catch (error) {
      return await finishFailure(error);
    } finally {
      if (workDirectoryToClean)
        await rm(workDirectoryToClean, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
  }
}
