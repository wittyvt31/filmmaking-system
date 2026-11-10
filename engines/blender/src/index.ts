import { createReadStream, existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
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

function validatePngStructure(buffer: Buffer): void {
  let offset = 8;
  let hasImageData = false;
  let hasEnd = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length)
      throw new BlenderFailure(
        'INCOMPLETE_OUTPUT',
        'PNG contains a truncated chunk',
      );
    if (type === 'IDAT') hasImageData = true;
    if (type === 'IEND') {
      hasEnd = length === 0 && end === buffer.length;
      break;
    }
    offset = end;
  }
  if (!hasImageData || !hasEnd)
    throw new BlenderFailure(
      'INCOMPLETE_OUTPUT',
      'PNG is missing image data or a complete end chunk',
    );
}

async function validateSequence(
  directory: string,
  expected: {
    frames: number;
    width: number;
    height: number;
    startFrame?: number;
  },
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
    const expectedName = `frame_${String(index + (expected.startFrame ?? 1)).padStart(6, '0')}.png`;
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
    const png = await readFile(path);
    validatePngStructure(png);
    const size = pngSize(png.subarray(0, 24));
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
  readonly defaultSamples: number | undefined;
  readonly workers: number;
  #versionPromise: Promise<string> | undefined;

  constructor(
    config: {
      executablePath?: string | undefined;
      samples?: number | undefined;
      workers?: number | undefined;
    } = {},
  ) {
    this.executablePath = config.executablePath ?? defaultBlenderExecutable();
    this.defaultSamples = config.samples;
    this.workers = config.workers ?? 1;
    if (
      !Number.isSafeInteger(this.workers) ||
      this.workers < 1 ||
      this.workers > 16
    )
      throw new RangeError(
        'Blender worker count must be an integer from 1 to 16',
      );
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
    let requestedRenderer = 'unknown';
    let actualRenderer = 'unknown';
    let fallbackUsed = false;
    let degraded = false;
    let lastProcessResult: Awaited<ReturnType<typeof spawnCapture>> | undefined;
    let lastWorkerResult: Record<string, unknown> | null = null;
    let workDirectoryToClean: string | undefined;
    let retainPartialWork = false;
    const finishFailure = async (error: unknown): Promise<RenderShotResult> => {
      const failure = errorInfo(error);
      const workerMetrics = lastWorkerResult?.['metrics'];
      if (workerMetrics && typeof workerMetrics === 'object') {
        const recorded = workerMetrics as Record<string, unknown>;
        metrics['constantInterpolationCurves'] = Number(
          recorded['constantInterpolationCurves'] ?? 0,
        );
        metrics['constantInterpolationFailures'] = Number(
          recorded['constantInterpolationFailures'] ?? 0,
        );
      }
      if (lastWorkerResult?.['error'])
        metrics['workerFailure'] = String(lastWorkerResult['error']);
      if (lastProcessResult) {
        metrics['exitCode'] = lastProcessResult.code ?? -1;
        metrics['signal'] = lastProcessResult.signal ?? '';
        metrics['timedOut'] = lastProcessResult.timedOut;
        metrics['interrupted'] = lastProcessResult.interrupted;
      }
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
        requestedRenderer,
        actualRenderer,
        fallbackUsed,
        degraded,
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
      const profileSamples = {
        draft: 4,
        preview: 16,
        final: 64,
        flat: 1,
      } as const;
      const renderOverrides = {
        ...settings.qualityOverrides,
        ...shot.renderOverrides,
      };
      const finalScale = Math.max(
        1,
        1920 / settings.outputDimensions.width,
        1080 / settings.outputDimensions.height,
      );
      const profileDimensions =
        settings.qualityProfile === 'draft' ||
        settings.qualityProfile === 'flat'
          ? { width: 854, height: 480 }
          : settings.qualityProfile === 'preview'
            ? { width: 1280, height: 720 }
            : settings.qualityProfile === 'final'
              ? {
                  width:
                    Math.ceil(
                      (settings.outputDimensions.width * finalScale) / 2,
                    ) * 2,
                  height:
                    Math.ceil(
                      (settings.outputDimensions.height * finalScale) / 2,
                    ) * 2,
                }
              : settings.outputDimensions;
      const scaleOverride = renderOverrides.width
        ? renderOverrides.width / profileDimensions.width
        : renderOverrides.height
          ? renderOverrides.height / profileDimensions.height
          : 1;
      const renderDimensions = {
        width:
          renderOverrides.width ??
          Math.ceil((profileDimensions.width * scaleOverride) / 2) * 2,
        height:
          renderOverrides.height ??
          Math.ceil((profileDimensions.height * scaleOverride) / 2) * 2,
      };
      const renderConfig = {
        engine:
          settings.qualityProfile === 'flat'
            ? 'BLENDER_WORKBENCH'
            : settings.renderer.config.engine,
        device: settings.renderer.config.device,
        samples:
          renderOverrides.samples ??
          settings.renderer.config.samples ??
          this.defaultSamples ??
          profileSamples[settings.qualityProfile ?? 'preview'],
        denoising:
          renderOverrides.denoising ?? settings.renderer.config.denoising,
        shadows:
          settings.qualityProfile === 'flat' ||
          (settings.qualityProfile === 'draft' &&
            shot.scene?.styleVersion === '2.0.0')
            ? 'off'
            : (renderOverrides.shadows ?? 'high'),
        textures:
          settings.qualityProfile === 'flat'
            ? 'low'
            : (renderOverrides.textures ?? 'high'),
        compositing: false,
        frameRate: renderOverrides.frameRate ?? settings.frameRate,
        width: renderDimensions.width,
        height: renderDimensions.height,
      };
      requestedRenderer = renderConfig.engine;
      actualRenderer = renderConfig.engine;
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
        'facial-variant',
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
      const requiredControls: Record<string, readonly string[]> = {
        breathing: ['chest'],
        'head-turn': ['head'],
        blink: ['left-eye', 'right-eye'],
        expression: ['left-brow', 'right-brow'],
        celebrate: ['chest', 'left-arm', 'right-arm'],
        walk: ['left-leg', 'right-leg'],
        run: ['left-leg', 'right-leg'],
        kick: [],
        reach: [],
        grasp: [],
        lift: [],
        place: [],
        interaction: ['head'],
        'facial-variant': [],
        'motion-clip': [],
        jump: [],
        'lip-sync': ['mouth'],
        sit: ['chest', 'left-leg', 'right-leg'],
        stand: ['chest', 'left-leg', 'right-leg'],
      };
      for (const { characterId, action } of compiledScene.actions) {
        const character = compiledScene.characters.find(
          (candidate) => candidate.id === characterId,
        );
        const rig = character
          ? assetMap.get(assetKey(character.artwork))
          : undefined;
        if (!character || !rig)
          throw new BlenderFailure(
            'MISSING_ASSET',
            `Character artwork could not be resolved for action "${action.id}"`,
          );
        const controls = (rig.metadata['semanticControls'] ?? {}) as Record<
          string,
          unknown
        >;
        for (const control of requiredControls[action.type] ?? []) {
          if (typeof controls[control] !== 'string')
            throw new BlenderFailure(
              'INVALID_INSTRUCTIONS',
              `Action "${action.id}" requires semantic rig control "${control}" on character "${characterId}"; map it in the prepared artwork specification.`,
            );
        }
        if (action.type === 'facial-variant') {
          const definitions = (rig.metadata['variantDefinitions'] ??
            {}) as Record<string, { variants?: unknown } | undefined>;
          const variants = definitions[action.slotId]?.variants;
          if (!Array.isArray(variants) || !variants.includes(action.variantId))
            throw new BlenderFailure(
              'INVALID_INSTRUCTIONS',
              `Action "${action.id}" requests undeclared facial variant ${action.slotId}=${action.variantId} on "${characterId}".`,
            );
        }
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
          outputDimensions: renderDimensions,
          frameRate: settings.frameRate,
          engine: settings.renderer.config.engine,
          qualityProfile: settings.qualityProfile ?? null,
          qualityOverrides: settings.qualityOverrides ?? null,
          shotOverrides: shot.renderOverrides ?? null,
          renderConfig,
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
          width: renderDimensions.width,
          height: renderDimensions.height,
        });
        const cachedWorker = JSON.parse(
          await readFile(join(outputDirectory, 'worker-result.json'), 'utf8'),
        ) as {
          backend?: string;
          engine?: string;
          samples?: number;
          sourceFraming?: Record<string, number | boolean>;
        };
        const recoveryPath = join(
          outputDirectory,
          'diagnostics',
          'range-attempts.json',
        );
        const recoveredAttempts = existsSync(recoveryPath)
          ? (
              JSON.parse(await readFile(recoveryPath, 'utf8')) as {
                recoveredAttemptCount: number;
              }
            ).recoveredAttemptCount
          : 0;
        const cacheWarnings = recoveredAttempts
          ? [
              `Cached artifact originated from a render that recovered ${recoveredAttempts} failed or incomplete Blender attempt(s); see diagnostics/range-attempts.json.`,
            ]
          : [];
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
          metrics: {
            cacheHit: true,
            frameCount: shot.durationFrames,
            renderEngine: renderConfig.engine,
            requestedBackend: renderConfig.device,
            selectedBackend: cachedWorker.backend ?? 'unknown',
            samples: renderConfig.samples,
            denoising: renderConfig.denoising,
            width: renderDimensions.width,
            height: renderDimensions.height,
            nativeRenderWidth: renderDimensions.width,
            nativeRenderHeight: renderDimensions.height,
            upscaled:
              settings.outputDimensions.width > renderDimensions.width ||
              settings.outputDimensions.height > renderDimensions.height,
            frameRate: `${renderConfig.frameRate.numerator}/${renderConfig.frameRate.denominator}`,
            shadows: renderConfig.shadows,
            textures: renderConfig.textures,
            compositing: renderConfig.compositing,
            qualityProfile: settings.qualityProfile ?? 'custom',
            recoveredAttemptCount: recoveredAttempts,
            ...cachedWorker.sourceFraming,
          },
          ...(cacheWarnings.length > 0
            ? { warnings: cacheWarnings, completedWithWarning: true }
            : {}),
        };
        await writeReceipt(receiptPath, receipt);
        return { status: 'success', receipt, cacheHit: true };
      }
      const parent = dirname(outputDirectory);
      await mkdir(parent, { recursive: true });
      const workDirectory = join(
        parent,
        `.${basename(outputDirectory)}.${fingerprint.slice(0, 16)}.partial`,
      );
      await mkdir(workDirectory, { recursive: true });
      workDirectoryToClean = workDirectory;
      const stagedDirectory = join(workDirectory, 'artifact');
      const frameDirectory = join(stagedDirectory, 'frames');
      await mkdir(frameDirectory, { recursive: true });
      const specPath = join(workDirectory, 'worker-spec.json');
      const scene = compiledScene;
      const workerSpec = {
        durationFrames: shot.durationFrames,
        frameRate: settings.frameRate,
        width: renderDimensions.width,
        height: renderDimensions.height,
        samples: renderConfig.samples,
        renderConfig,
        randomSeed: request.randomSeed,
        chunkFrames: 12,
        outputDirectory: stagedDirectory,
        style: {
          ...scene.style,
          boilFps: shot.scene?.styleOverrides?.boilFps ?? 12,
        },
        renderOverrides,
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
      await writeFile(specPath, JSON.stringify(workerSpec));
      retainPartialWork = true;
      const warnings: string[] = [];
      const workerResultPath = join(stagedDirectory, 'worker-result.json');
      type WorkerResult = {
        status?: unknown;
        frameCount?: unknown;
        backend?: string;
        engine?: string;
        samples?: number;
        renderedFrames?: number;
        sourceFraming?: Record<string, number | boolean>;
        blenderVersion?: string;
        metrics?: {
          constantInterpolationCurves?: number;
          constantInterpolationFailures?: number;
        };
      };
      const readWorkerResult = async (
        directory = stagedDirectory,
      ): Promise<WorkerResult | null> => {
        try {
          return JSON.parse(
            await readFile(join(directory, 'worker-result.json'), 'utf8'),
          ) as WorkerResult;
        } catch {
          return null;
        }
      };
      const preserveWorkerFailure = async (resumable = false) => {
        const partialDirectory = resumable
          ? stagedDirectory
          : `${outputDirectory}.failed-attempt-${randomUUID()}`;
        if (!resumable) {
          await mkdir(dirname(partialDirectory), { recursive: true });
          await rename(stagedDirectory, partialDirectory);
          retainPartialWork = false;
        }
        const crashReport = lastProcessResult?.stderr
          .split(/\r?\n/)
          .find((line) => /crash\.txt|Writing:.*crash/i.test(line));
        if (crashReport) {
          const source = crashReport.replace(/^.*Writing:\s*/, '').trim();
          if (existsSync(source))
            await copyFile(source, join(partialDirectory, 'blender-crash.txt'));
        }
        logs.push(`Failed render artifacts preserved at ${partialDirectory}`);
        if (lastWorkerResult)
          logs.push(`Worker result: ${JSON.stringify(lastWorkerResult)}`);
        metrics['partialFrameCount'] = (
          await readdir(join(partialDirectory, 'frames'))
        ).filter((name) => /^frame_\d{6}\.png$/.test(name)).length;
      };
      const validateStaged = async () => {
        try {
          return await validateSequence(stagedDirectory, {
            frames: shot.durationFrames,
            width: renderDimensions.width,
            height: renderDimensions.height,
          });
        } catch {
          return null;
        }
      };
      const spawnWorker = async (workerSpecPath = specPath) => {
        const result = await spawnCapture(
          this.executablePath,
          [
            '--background',
            '--factory-startup',
            '--python',
            WORKER_PATH,
            '--',
            workerSpecPath,
          ],
          {
            timeoutMs: request.timeoutMs ?? 600_000,
            ...(request.signal ? { signal: request.signal } : {}),
          },
        );
        if (result.stdout.trim())
          logs.push(...result.stdout.trim().split(/\r?\n/).slice(-500));
        if (result.stderr.trim())
          logs.push(...result.stderr.trim().split(/\r?\n/).slice(-500));
        return result;
      };
      const startedRender = Date.now();
      let processResult: ProcessResult;
      let workerResult: WorkerResult | null;
      if (this.workers === 1) {
        processResult = await spawnWorker();
        workerResult = await readWorkerResult();
      } else {
        const rangeCount = Math.min(this.workers, shot.durationFrames);
        const ranges = Array.from({ length: rangeCount }, (_, index) => {
          const start =
            Math.floor((index * shot.durationFrames) / rangeCount) + 1;
          const end = Math.floor(
            ((index + 1) * shot.durationFrames) / rangeCount,
          );
          return { index, start, end };
        });
        const results = await Promise.all(
          ranges.map(async (range) => {
            const rangeRoot = join(workDirectory, `range-${range.index}`);
            const rangeDirectory = join(rangeRoot, 'artifact');
            const rangeFrameDirectory = join(rangeDirectory, 'frames');
            await mkdir(rangeFrameDirectory, { recursive: true });
            const rangeSpecPath = join(rangeRoot, 'worker-spec.json');
            await writeFile(
              rangeSpecPath,
              JSON.stringify({
                ...workerSpec,
                outputDirectory: rangeDirectory,
                frameRange: { start: range.start, end: range.end },
              }),
            );
            let rangeProcess: ProcessResult | undefined;
            let rangeChecksums: Awaited<
              ReturnType<typeof validateSequence>
            > | null = null;
            const attempts: {
              rangeStart: number;
              rangeEnd: number;
              attempt: number;
              exitCode: number | null;
              signal: string | null;
              timedOut: boolean;
              interrupted: boolean;
              partialFrameCount: number;
              complete: boolean;
              crashReport: string | null;
            }[] = [];
            for (let attempt = 0; attempt < 2; attempt += 1) {
              rangeProcess = await spawnWorker(rangeSpecPath);
              const crashLine = rangeProcess.stderr
                .split(/\r?\n/)
                .find((line) => /Writing:\s*.*crash\.txt/i.test(line));
              let crashReport: string | null = null;
              if (crashLine) {
                const source = crashLine.replace(/^.*Writing:\s*/, '').trim();
                if (existsSync(source)) {
                  crashReport = join(
                    rangeRoot,
                    `crash-attempt-${attempt + 1}.txt`,
                  );
                  await copyFile(source, crashReport);
                } else {
                  logs.push(`Blender crash report was unavailable: ${source}`);
                }
              }
              try {
                rangeChecksums = await validateSequence(rangeDirectory, {
                  frames: range.end - range.start + 1,
                  width: renderDimensions.width,
                  height: renderDimensions.height,
                  startFrame: range.start,
                });
              } catch {
                rangeChecksums = null;
              }
              const partialFrameCount = (
                await readdir(rangeFrameDirectory)
              ).filter((name) => /^frame_\d{6}\.png$/.test(name)).length;
              attempts.push({
                rangeStart: range.start,
                rangeEnd: range.end,
                attempt: attempt + 1,
                exitCode: rangeProcess.code,
                signal: rangeProcess.signal,
                timedOut: rangeProcess.timedOut,
                interrupted: rangeProcess.interrupted,
                partialFrameCount,
                complete: rangeChecksums !== null,
                crashReport,
              });
              if (rangeChecksums) break;
              if (attempt === 1) {
                lastProcessResult = rangeProcess;
                lastWorkerResult = await readWorkerResult(rangeDirectory);
                metrics['partialFrameCount'] = partialFrameCount;
                logs.push(`Failed range artifacts preserved at ${rangeRoot}`);
                throw new BlenderFailure(
                  'RENDER_CRASHED',
                  `Frame range ${range.start}-${range.end} failed twice: ${rangeProcess.stderr.split(/\r?\n/).slice(-6).join(' | ')}`,
                  true,
                );
              }
            }
            const result = await readWorkerResult(rangeDirectory);
            return {
              range,
              rangeDirectory,
              rangeProcess: rangeProcess!,
              checksums: rangeChecksums!,
              workerResult: result,
              attempts,
            };
          }),
        );
        for (const item of results.sort(
          (a, b) => a.range.start - b.range.start,
        )) {
          for (
            let frame = item.range.start;
            frame <= item.range.end;
            frame += 1
          )
            await copyFile(
              join(
                item.rangeDirectory,
                'frames',
                `frame_${String(frame).padStart(6, '0')}.png`,
              ),
              join(
                frameDirectory,
                `frame_${String(frame).padStart(6, '0')}.png`,
              ),
            );
        }
        const firstRange = results[0];
        if (!firstRange)
          throw new BlenderFailure(
            'RENDER_CRASHED',
            'Parallel Blender rendering produced no ranges',
          );
        await copyFile(
          join(firstRange.rangeDirectory, 'scene.blend'),
          join(stagedDirectory, 'scene.blend'),
        );
        const allAttempts = results.flatMap((item) => item.attempts);
        const recoveredAttempts = allAttempts.filter(
          (item) =>
            item.exitCode !== 0 ||
            item.signal !== null ||
            item.timedOut ||
            item.interrupted ||
            !item.complete,
        );
        metrics['retryCount'] = results.reduce(
          (count, item) => count + item.attempts.length - 1,
          0,
        );
        metrics['recoveredAttemptCount'] = recoveredAttempts.length;
        if (recoveredAttempts.length > 0) {
          const diagnosticsDirectory = join(stagedDirectory, 'diagnostics');
          await mkdir(diagnosticsDirectory, { recursive: true });
          for (const item of allAttempts) {
            if (!item.crashReport) continue;
            await copyFile(
              item.crashReport,
              join(
                diagnosticsDirectory,
                `range-${item.rangeStart}-${item.rangeEnd}-attempt-${item.attempt}.crash.txt`,
              ),
            );
          }
          await writeFile(
            join(diagnosticsDirectory, 'range-attempts.json'),
            JSON.stringify({
              recoveredAttemptCount: recoveredAttempts.length,
              attempts: allAttempts.map(({ crashReport, ...item }) => ({
                ...item,
                crashReportPreserved: crashReport !== null,
              })),
            }),
          );
          for (const item of recoveredAttempts)
            warnings.push(
              `Blender range ${item.rangeStart}-${item.rangeEnd} attempt ${item.attempt} exited ${String(item.exitCode)} with ${item.partialFrameCount} frame(s) and ${item.complete ? 'a valid' : 'an incomplete'} sequence; recovered with the same renderer.`,
            );
          metrics['partialFrameCountAtRetry'] = Math.max(
            ...recoveredAttempts.map((item) => item.partialFrameCount),
          );
          const firstAbnormal = recoveredAttempts[0];
          if (firstAbnormal)
            metrics['firstFailedExitCode'] = firstAbnormal.exitCode ?? -1;
        }
        processResult = results.at(-1)!.rangeProcess;
        workerResult = firstRange.workerResult
          ? {
              ...firstRange.workerResult,
              frameCount: shot.durationFrames,
              renderedFrames: results.reduce(
                (sum, item) =>
                  sum +
                  (item.workerResult?.renderedFrames ??
                    item.range.end - item.range.start + 1),
                0,
              ),
            }
          : null;
        await writeFile(
          workerResultPath,
          JSON.stringify(
            workerResult ?? {
              status: 'success',
              frameCount: shot.durationFrames,
            },
          ),
        );
      }
      lastProcessResult = processResult;
      metrics['renderDurationMs'] = Date.now() - startedRender;
      lastWorkerResult = workerResult;
      const stagedChecksums = await validateStaged();
      if (processResult.timedOut || processResult.interrupted) {
        await preserveWorkerFailure(true);
        throw new BlenderFailure(
          processResult.timedOut ? 'TIMEOUT' : 'INTERRUPTED',
          processResult.timedOut
            ? `Blender timed out after ${request.timeoutMs ?? 600_000} ms`
            : 'Blender render was interrupted',
          true,
        );
      }
      if (stagedChecksums === null) {
        await preserveWorkerFailure();
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
      }
      if (stagedChecksums === null) {
        throw new BlenderFailure(
          'RENDER_CRASHED',
          `Blender ${processResult.code !== 0 ? `exited with code ${String(processResult.code)}` : 'exited cleanly'} but produced no valid ${shot.durationFrames}-frame sequence${processResult.signal ? ` (${processResult.signal})` : ''}: ${(processResult.stderr || processResult.stdout).split(/\r?\n/).slice(-8).join(' | ')}`,
          processResult.code !== 0,
        );
      }
      actualRenderer = workerResult?.engine ?? renderConfig.engine;
      if (actualRenderer !== requestedRenderer) {
        fallbackUsed = true;
        degraded = true;
        await preserveWorkerFailure();
        throw new BlenderFailure(
          'RENDER_CRASHED',
          `Renderer mismatch: requested ${requestedRenderer}, actual ${actualRenderer}; rejecting degraded output.`,
        );
      }
      if (processResult.code !== 0) {
        warnings.push(
          `Blender exited non-zero (code ${String(processResult.code)}${processResult.signal ? `, signal ${processResult.signal}` : ''}) but produced a complete verified frame sequence; accepting the shot.`,
        );
        const faulting = (processResult.stderr || processResult.stdout)
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .slice(-12);
        if (faulting.length > 0)
          warnings.push(
            `Faulting output (last ${faulting.length} lines): ${faulting.join(' | ')}`,
          );
      }
      await promoteDirectory(stagedDirectory, outputDirectory);
      retainPartialWork = false;
      const checksums = stagedChecksums.map((item) => ({
        ...item,
        path: item.path.replace(stagedDirectory, outputDirectory),
      }));
      metrics['frameCount'] = shot.durationFrames;
      metrics['renderedFrames'] =
        workerResult?.renderedFrames ?? shot.durationFrames;
      metrics['resumedFrames'] =
        shot.durationFrames - Number(metrics['renderedFrames']);
      Object.assign(metrics, workerResult?.sourceFraming);
      metrics['cacheHit'] = false;
      metrics['renderEngine'] = workerResult?.engine ?? renderConfig.engine;
      metrics['selectedBackend'] = workerResult?.backend ?? 'unknown';
      metrics['samples'] = workerResult?.samples ?? renderConfig.samples;
      metrics['renderWidth'] = renderDimensions.width;
      metrics['renderHeight'] = renderDimensions.height;
      metrics['nativeRenderWidth'] = renderDimensions.width;
      metrics['nativeRenderHeight'] = renderDimensions.height;
      metrics['upscaled'] =
        settings.outputDimensions.width > renderDimensions.width ||
        settings.outputDimensions.height > renderDimensions.height;
      metrics['qualityProfile'] = settings.qualityProfile ?? 'custom';
      metrics['frameRate'] =
        `${renderConfig.frameRate.numerator}/${renderConfig.frameRate.denominator}`;
      metrics['shadows'] = renderConfig.shadows;
      metrics['textures'] = renderConfig.textures;
      metrics['compositing'] = renderConfig.compositing;
      metrics['blenderVersion'] =
        workerResult?.blenderVersion ?? this.identity.version;
      metrics['exitCode'] = processResult.code ?? 0;
      metrics['completedWithWarning'] = warnings.length > 0;
      metrics['constantInterpolationCurves'] =
        workerResult?.metrics?.constantInterpolationCurves ?? 0;
      metrics['constantInterpolationFailures'] =
        workerResult?.metrics?.constantInterpolationFailures ?? 0;
      metrics['fallbackUsed'] = fallbackUsed;
      metrics['degraded'] = degraded;
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
        requestedRenderer,
        actualRenderer,
        fallbackUsed,
        degraded,
        ...(warnings.length > 0
          ? { warnings, completedWithWarning: true }
          : {}),
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
      if (workDirectoryToClean && !retainPartialWork)
        await rm(workDirectoryToClean, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
  }
}
