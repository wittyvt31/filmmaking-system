import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import {
  copyFile,
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
import { dirname, extname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import {
  RenderInternals,
  getVideoMetadata,
  makeCancelSignal,
  renderFrames,
  renderMedia,
  renderStill,
  selectComposition,
} from '@remotion/renderer';
import {
  AssetVersionReferenceSchema,
  canonicalJsonSha256,
  compareStrings,
  RenderPolicySchema,
  ShotSchema,
  type ArtifactInspection,
  type ArtifactInspectionRequest,
  type FailedRenderReceipt,
  type RenderArtifactRequest,
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
import type { PreparedShotProps, SceneElement } from './remotion/Scene.js';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const enginePackage = JSON.parse(
  readFileSync(join(packageDirectory, 'package.json'), 'utf8'),
) as { dependencies: Record<string, string> };
const RENDERER_ID = 'remotion';
const RENDERER_VERSION =
  enginePackage.dependencies['@remotion/renderer'] ?? 'unknown';
const RENDERABLE_SOURCE_DIRECTORY = join(packageDirectory, 'src', 'remotion');
const ROOT_LOCKFILE = resolve(packageDirectory, '..', '..', 'pnpm-lock.yaml');
const SUPPORTED_ARTIFACTS = [
  'video/mp4',
  'image-sequence/png',
  'image/png',
] as const;

function localBrowserExecutable(): string | undefined {
  const configured = process.env['CHROME_PATH'];
  if (configured) return configured;
  if (process.platform !== 'win32') return undefined;
  const candidates = [
    process.env['PROGRAMFILES'] &&
      join(
        process.env['PROGRAMFILES'],
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
      ),
    process.env['PROGRAMFILES(X86)'] &&
      join(
        process.env['PROGRAMFILES(X86)'],
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
      ),
    process.env['LOCALAPPDATA'] &&
      join(
        process.env['LOCALAPPDATA'],
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
      ),
    process.env['PROGRAMFILES'] &&
      join(
        process.env['PROGRAMFILES'],
        'Microsoft',
        'Edge',
        'Application',
        'msedge.exe',
      ),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find(existsSync);
}

class RenderFailure extends Error {
  constructor(
    readonly code: RendererErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RenderFailure';
  }
}

function outputPathFor(artifact: RenderArtifactRequest): string {
  return artifact.type === 'image-sequence/png'
    ? resolve(artifact.outputDirectory)
    : resolve(artifact.outputPath);
}

function expectedFrameCount(request: RenderShotRequest): number {
  return request.artifact.type === 'image/png'
    ? 1
    : request.shot.durationFrames;
}

function artifactIsDirectory(artifact: RenderArtifactRequest): boolean {
  return artifact.type === 'image-sequence/png';
}

function receiptPathFor(request: RenderShotRequest): string {
  return resolve(
    request.receiptPath ?? `${outputPathFor(request.artifact)}.receipt.json`,
  );
}

function errorDetails(error: unknown): {
  code: RendererErrorCode;
  message: string;
  retryable: boolean;
} {
  if (error instanceof RenderFailure) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof AssetRegistryError) {
    return {
      code: 'MISSING_ASSET',
      message: error.message,
      retryable: false,
    };
  }
  return {
    code: 'RENDER_CRASHED',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

async function hashFile(
  path: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Artifact cannot contain symbolic links: ${path}`);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Unsupported artifact entry: ${path}`);
  }
  return files;
}

async function checksumsFor(path: string, isDirectory: boolean) {
  const files = isDirectory ? await listFiles(path) : [path];
  if (files.length === 0)
    throw new RenderFailure(
      'INCOMPLETE_OUTPUT',
      'Renderer produced an empty artifact',
    );
  const checksums = [];
  for (const file of files) {
    const checksum = await hashFile(file);
    checksums.push({
      path: file,
      sha256: checksum.sha256,
      bytes: checksum.bytes,
    });
  }
  return checksums;
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
    });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function compositionFingerprint(): Promise<string> {
  const sourceFiles = await listFiles(RENDERABLE_SOURCE_DIRECTORY);
  const sources: Record<string, string> = {};
  for (const path of sourceFiles) {
    sources[
      path.slice(RENDERABLE_SOURCE_DIRECTORY.length + 1).replaceAll('\\', '/')
    ] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  }
  const packageVersions = Object.fromEntries(
    Object.entries(enginePackage.dependencies)
      .filter(
        ([name]) =>
          name.startsWith('@remotion/') ||
          ['remotion', 'react', 'react-dom'].includes(name),
      )
      .sort(([left], [right]) => compareStrings(left, right)),
  );
  const lockHash = createHash('sha256')
    .update(await readFile(ROOT_LOCKFILE))
    .digest('hex');
  return canonicalJsonSha256({ sources, packageVersions, lockHash });
}

function assetKey(
  asset: Pick<RendererAssetInput, 'assetId' | 'version'>,
): string {
  return `${asset.assetId}\u0000${asset.version}`;
}

async function validateAssets(
  request: RenderShotRequest,
): Promise<Map<string, RendererAssetInput>> {
  const assets = new Map<string, RendererAssetInput>();
  for (const asset of request.assets) {
    const parsedReference = AssetVersionReferenceSchema.parse({
      assetId: asset.assetId,
      version: asset.version,
    });
    if (assets.has(assetKey(parsedReference))) {
      throw new RenderFailure(
        'INVALID_INSTRUCTIONS',
        `Asset ${asset.assetId}@${asset.version} was supplied more than once`,
      );
    }
    let info;
    try {
      info = await stat(asset.localPath);
    } catch {
      throw new RenderFailure(
        'MISSING_ASSET',
        `Asset file does not exist: ${asset.localPath}`,
      );
    }
    if (!info.isFile())
      throw new RenderFailure(
        'MISSING_ASSET',
        `Asset source is not a regular file: ${asset.localPath}`,
      );
    const actual = await hashFile(asset.localPath);
    if (actual.sha256 !== asset.contentHash) {
      throw new RenderFailure(
        'MISSING_ASSET',
        `Asset content hash changed for ${asset.assetId}@${asset.version}`,
      );
    }
    assets.set(assetKey(parsedReference), asset);
  }
  for (const reference of request.shot.requiredAssets) {
    if (!assets.has(assetKey(reference))) {
      throw new RenderFailure(
        'MISSING_ASSET',
        `Required asset ${reference.assetId}@${reference.version} was not resolved`,
      );
    }
  }
  return assets;
}

function validateSettings(request: RenderShotRequest): void {
  if (request.settings.renderer.id !== RENDERER_ID) {
    throw new RenderFailure(
      'UNSUPPORTED_SETTINGS',
      `Remotion cannot execute renderer "${request.settings.renderer.id}"`,
    );
  }
  if (request.settings.renderer.config.compositionId !== 'PreparedShot') {
    throw new RenderFailure(
      'UNSUPPORTED_SETTINGS',
      'Remotion adapter only supports the PreparedShot composition',
    );
  }
  if (
    request.settings.qualityProfile !== undefined ||
    request.settings.qualityOverrides !== undefined ||
    request.shot.renderOverrides !== undefined
  ) {
    throw new RenderFailure(
      'UNSUPPORTED_SETTINGS',
      'Remotion does not implement Blender quality profiles or render overrides; use Blender or omit those settings.',
    );
  }
  const policy = request.settings;
  if (
    policy.outputDimensions.width !== 1920 ||
    policy.outputDimensions.height !== 1080 ||
    policy.frameRate.numerator !== 30 ||
    policy.frameRate.denominator !== 1 ||
    policy.codec !== 'h264' ||
    policy.container !== 'mp4' ||
    policy.pixelFormat !== 'yuv420p' ||
    policy.colorProfile !== 'bt709'
  ) {
    throw new RenderFailure(
      'UNSUPPORTED_SETTINGS',
      'The Remotion MVP requires 1920x1080, 30/1 FPS, H.264 MP4, yuv420p, and SDR Rec.709',
    );
  }
  if (
    request.artifact.type === 'video/mp4' &&
    (policy.codec !== 'h264' || policy.container !== 'mp4')
  ) {
    throw new RenderFailure(
      'UNSUPPORTED_SETTINGS',
      'MP4 video output requires H.264 in an MP4 container',
    );
  }
}

function fallbackFingerprint(request: RenderShotRequest): string {
  try {
    return canonicalJsonSha256({
      jobId: request.jobId,
      shot: request.shot,
      assets: request.assets.map(({ assetId, version, contentHash }) => ({
        assetId,
        version,
        contentHash,
      })),
      settings: request.settings,
      randomSeed: request.randomSeed,
    });
  } catch {
    return createHash('sha256')
      .update(`${request.jobId}:${request.shot?.id ?? 'invalid'}`)
      .digest('hex');
  }
}

async function makeFingerprint(
  request: RenderShotRequest,
  assets: readonly RendererAssetInput[],
  renderer: RendererIdentity,
): Promise<string> {
  const compositionHash = await compositionFingerprint();
  const resources = [...assets]
    .map((asset) => ({
      assetId: asset.assetId,
      version: asset.version,
      type: asset.type,
      contentHash: asset.contentHash,
      metadata: asset.metadata,
    }))
    .sort((left, right) => compareStrings(assetKey(left), assetKey(right)));
  return canonicalJsonSha256({
    shot: request.shot,
    assets: resources,
    renderer,
    compositionHash,
    settings: request.settings,
    resources,
    randomSeed: request.randomSeed,
  });
}

async function buildBundle(
  workDirectory: string,
  assets: readonly RendererAssetInput[],
  shot: RenderShotRequest['shot'],
): Promise<{ serveUrl: string; inputProps: PreparedShotProps }> {
  const publicDirectory = join(workDirectory, 'public');
  const bundleDirectory = join(workDirectory, 'bundle');
  const assetsDirectory = join(publicDirectory, 'assets');
  await mkdir(assetsDirectory, { recursive: true });
  const publicPathByAsset = new Map<string, string>();
  for (const asset of assets) {
    const extension = extname(asset.localPath).toLowerCase() || '.bin';
    const fileName = `${asset.contentHash}${extension}`;
    const destination = join(assetsDirectory, fileName);
    await copyFile(asset.localPath, destination);
    publicPathByAsset.set(assetKey(asset), `assets/${fileName}`);
  }

  const elements: SceneElement[] = [];
  for (const element of shot.visualElements ?? []) {
    const publicPath = publicPathByAsset.get(assetKey(element.asset));
    if (!publicPath) {
      throw new RenderFailure(
        'MISSING_ASSET',
        `Visual element asset ${element.asset.assetId}@${element.asset.version} is missing`,
      );
    }
    const asset = assets.find(
      (candidate) => assetKey(candidate) === assetKey(element.asset),
    );
    if (!asset || !['image', 'graphic'].includes(asset.type)) {
      throw new RenderFailure(
        'INVALID_INSTRUCTIONS',
        `Visual element "${element.id}" must reference an image or graphic asset`,
      );
    }
    elements.push({ ...element, src: publicPath });
  }
  const fonts = assets
    .filter((asset) => asset.type === 'font')
    .map((asset) => {
      const fontFamily = asset.metadata['fontFamily'];
      return {
        family:
          typeof fontFamily === 'string'
            ? fontFamily.replace(/[^A-Za-z0-9 _-]/g, '')
            : asset.assetId,
        src: publicPathByAsset.get(assetKey(asset)) ?? '',
      };
    });
  const inputProps: PreparedShotProps = {
    shot,
    durationInFrames: shot.durationFrames,
    fps: 30,
    width: 1920,
    height: 1080,
    elements,
    fonts,
    randomSeed: 0,
  };
  const entryPoint = join(RENDERABLE_SOURCE_DIRECTORY, 'entry.tsx');
  const serveUrl = await bundle({
    entryPoint,
    outDir: bundleDirectory,
    rootDir: packageDirectory,
    publicDir: publicDirectory,
    enableCaching: true,
    onProgress: () => undefined,
    webpackOverride: (configuration) => {
      configuration.resolve ??= {};
      configuration.resolve.extensionAlias = {
        ...configuration.resolve.extensionAlias,
        '.js': ['.js', '.ts', '.tsx'],
      };
      return configuration;
    },
  });
  return { serveUrl, inputProps };
}

function mapRemotionCodec(codec: string): string {
  if (codec === 'h264') return 'h264';
  if (codec === 'h265') return 'hevc';
  return codec;
}

async function readPngDimensions(
  path: string,
): Promise<{ width: number; height: number }> {
  const header = await readFile(path, { encoding: null, flag: 'r' });
  if (
    header.length < 24 ||
    header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
  ) {
    throw new RenderFailure(
      'INCOMPLETE_OUTPUT',
      `Not a complete PNG image: ${path}`,
    );
  }
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

async function promoteArtifact(
  temporary: string,
  outputPath: string,
  isDirectory: boolean,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await rename(temporary, outputPath);
  } catch (error) {
    if (!isDirectory) throw error;
    const backup = `${outputPath}.previous-${randomUUID()}`;
    try {
      await rename(outputPath, backup);
    } catch {
      throw error;
    }
    try {
      await rename(temporary, outputPath);
    } catch (promotionError) {
      await rename(backup, outputPath);
      throw promotionError;
    }
    await rm(backup, { recursive: true, force: true });
  }
}

export class RemotionRendererAdapter implements RendererAdapter {
  readonly identity: RendererIdentity = {
    id: RENDERER_ID,
    version: RENDERER_VERSION,
  };

  async inspectCapabilities(): Promise<
    RendererOperationResult<RendererCapabilities>
  > {
    return {
      status: 'success',
      value: {
        identity: this.identity,
        artifactTypes: SUPPORTED_ARTIFACTS,
        videoCodecs: ['h264'],
        pixelFormats: ['yuv420p'],
        colorProfiles: ['bt709'],
      },
    };
  }

  async inspectArtifact(
    request: ArtifactInspectionRequest,
  ): Promise<RendererOperationResult<ArtifactInspection>> {
    try {
      const path = resolve(request.path);
      if (request.artifactType === 'video/mp4') {
        const metadata = await getVideoMetadata(path);
        if (metadata.durationInSeconds === null) {
          throw new RenderFailure(
            'INCOMPLETE_OUTPUT',
            'Video duration could not be inspected',
          );
        }
        const frameCount = Math.round(
          metadata.durationInSeconds * metadata.fps,
        );
        const checksums = await checksumsFor(path, false);
        const inspection: ArtifactInspection = {
          artifactType: request.artifactType,
          outputChecksums: checksums,
          frameCount,
          width: metadata.width,
          height: metadata.height,
          frameRate: metadata.fps,
        };
        if (typeof metadata.codec === 'string')
          inspection.codec = mapRemotionCodec(metadata.codec);
        if (typeof metadata.pixelFormat === 'string')
          inspection.pixelFormat = metadata.pixelFormat;
        if (typeof metadata.colorSpace === 'string')
          inspection.colorProfile = metadata.colorSpace;
        if (
          request.expectedFrameCount !== undefined &&
          frameCount !== request.expectedFrameCount
        ) {
          throw new RenderFailure(
            'INCOMPLETE_OUTPUT',
            `Expected ${request.expectedFrameCount} frames but inspected ${frameCount}`,
          );
        }
        if (
          request.expectedWidth !== undefined &&
          metadata.width !== request.expectedWidth
        ) {
          throw new RenderFailure(
            'INCOMPLETE_OUTPUT',
            `Expected width ${request.expectedWidth} but inspected ${metadata.width}`,
          );
        }
        if (
          request.expectedHeight !== undefined &&
          metadata.height !== request.expectedHeight
        ) {
          throw new RenderFailure(
            'INCOMPLETE_OUTPUT',
            `Expected height ${request.expectedHeight} but inspected ${metadata.height}`,
          );
        }
        if (
          request.expectedFrameRate &&
          Math.abs(
            metadata.fps -
              request.expectedFrameRate.numerator /
                request.expectedFrameRate.denominator,
          ) > 0.0001
        ) {
          throw new RenderFailure(
            'INCOMPLETE_OUTPUT',
            `Unexpected frame rate ${metadata.fps}`,
          );
        }
        if (
          request.expectedCodec &&
          mapRemotionCodec(metadata.codec) !== request.expectedCodec
        ) {
          throw new RenderFailure(
            'INCOMPLETE_OUTPUT',
            `Expected codec ${request.expectedCodec} but inspected ${metadata.codec}`,
          );
        }
        if (
          request.expectedPixelFormat &&
          metadata.pixelFormat !== request.expectedPixelFormat
        ) {
          throw new RenderFailure(
            'INCOMPLETE_OUTPUT',
            `Expected pixel format ${request.expectedPixelFormat} but inspected ${metadata.pixelFormat}`,
          );
        }
        if (
          request.expectedColorProfile &&
          metadata.colorSpace !== request.expectedColorProfile
        ) {
          throw new RenderFailure(
            'INCOMPLETE_OUTPUT',
            `Expected color profile ${request.expectedColorProfile} but inspected ${metadata.colorSpace}`,
          );
        }
        return { status: 'success', value: inspection };
      }

      if (request.artifactType === 'image/png') {
        const dimensions = await readPngDimensions(path);
        const checksums = await checksumsFor(path, false);
        if (
          request.expectedWidth !== undefined &&
          dimensions.width !== request.expectedWidth
        ) {
          throw new RenderFailure(
            'INCOMPLETE_OUTPUT',
            `Expected width ${request.expectedWidth} but inspected ${dimensions.width}`,
          );
        }
        if (
          request.expectedHeight !== undefined &&
          dimensions.height !== request.expectedHeight
        ) {
          throw new RenderFailure(
            'INCOMPLETE_OUTPUT',
            `Expected height ${request.expectedHeight} but inspected ${dimensions.height}`,
          );
        }
        return {
          status: 'success',
          value: {
            artifactType: request.artifactType,
            outputChecksums: checksums,
            ...dimensions,
            frameCount: 1,
          },
        };
      }

      const files = await listFiles(path);
      if (files.some((file) => extname(file).toLowerCase() !== '.png')) {
        throw new RenderFailure(
          'INCOMPLETE_OUTPUT',
          'Image sequence contains a non-PNG artifact',
        );
      }
      if (
        request.expectedFrameCount !== undefined &&
        files.length !== request.expectedFrameCount
      ) {
        throw new RenderFailure(
          'INCOMPLETE_OUTPUT',
          `Expected ${request.expectedFrameCount} PNG frames but found ${files.length}`,
        );
      }
      const outputChecksums = await checksumsFor(path, true);
      let dimensions: { width: number; height: number } | undefined;
      for (const file of files) {
        const frameDimensions = await readPngDimensions(file);
        if (!dimensions) dimensions = frameDimensions;
        else if (
          frameDimensions.width !== dimensions.width ||
          frameDimensions.height !== dimensions.height
        ) {
          throw new RenderFailure(
            'INCOMPLETE_OUTPUT',
            'Image sequence frames have inconsistent dimensions',
          );
        }
      }
      if (!dimensions)
        throw new RenderFailure(
          'INCOMPLETE_OUTPUT',
          'Image sequence contains no PNG frames',
        );
      if (
        request.expectedWidth !== undefined &&
        dimensions.width !== request.expectedWidth
      ) {
        throw new RenderFailure(
          'INCOMPLETE_OUTPUT',
          `Expected width ${request.expectedWidth} but inspected ${dimensions.width}`,
        );
      }
      if (
        request.expectedHeight !== undefined &&
        dimensions.height !== request.expectedHeight
      ) {
        throw new RenderFailure(
          'INCOMPLETE_OUTPUT',
          `Expected height ${request.expectedHeight} but inspected ${dimensions.height}`,
        );
      }
      return {
        status: 'success',
        value: {
          artifactType: request.artifactType,
          outputChecksums,
          frameCount: files.length,
          ...dimensions,
        },
      };
    } catch (error) {
      const details = errorDetails(error);
      return { status: 'failure', error: details };
    }
  }

  async renderShot(request: RenderShotRequest): Promise<RenderShotResult> {
    const startedAt = new Date();
    let outputPath = '';
    let receiptPath = '';
    let fingerprint = fallbackFingerprint(request);
    const logs: string[] = [];
    const metrics: Record<string, number | string | boolean> = {};
    let workDirectory: string | undefined;
    let timeoutReached = false;
    let wasInterrupted = false;
    const fail = async (error: unknown): Promise<RenderShotResult> => {
      let details = errorDetails(error);
      if (timeoutReached)
        details = {
          code: 'TIMEOUT',
          message: 'Render exceeded its timeout',
          retryable: true,
        };
      else if (wasInterrupted)
        details = {
          code: 'INTERRUPTED',
          message: 'Render was interrupted',
          retryable: true,
        };
      const receipt: FailedRenderReceipt = {
        jobId: request.jobId,
        shotId:
          request.shot && typeof request.shot.id === 'string'
            ? request.shot.id
            : 'unknown',
        renderer: this.identity,
        fingerprint,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        status: 'failure',
        outputPaths: [outputPath],
        outputChecksums: [],
        logs,
        metrics,
        error: details,
      };
      try {
        await writeJsonAtomically(receiptPath, receipt);
      } catch (receiptError) {
        logs.push(`Unable to write failure receipt: ${String(receiptError)}`);
      }
      return { status: 'failure', receipt, error: details };
    };

    try {
      outputPath = outputPathFor(request.artifact);
      receiptPath = receiptPathFor(request);
      if (
        !['video/mp4', 'image-sequence/png', 'image/png'].includes(
          request.artifact.type,
        )
      ) {
        throw new RenderFailure(
          'INVALID_INSTRUCTIONS',
          'Unsupported render artifact type',
        );
      }
      let shot;
      let settings;
      try {
        shot = ShotSchema.parse(request.shot);
        settings = RenderPolicySchema.parse(request.settings);
      } catch (error) {
        throw new RenderFailure(
          'INVALID_INSTRUCTIONS',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!Number.isSafeInteger(request.randomSeed) || request.randomSeed < 0) {
        throw new RenderFailure(
          'INVALID_INSTRUCTIONS',
          'Random seed must be a non-negative safe integer',
        );
      }
      if (settings.renderer.id !== RENDERER_ID) {
        throw new RenderFailure(
          'UNSUPPORTED_SETTINGS',
          'Remotion adapter requires a Remotion render policy',
        );
      }
      if (shot.scene) {
        throw new RenderFailure(
          'UNSUPPORTED_SETTINGS',
          'Remotion renders visualElements instructions; structured Blender scenes, rigs, actions, and lights require the Blender renderer.',
        );
      }
      validateSettings({ ...request, shot, settings });
      if (
        request.artifact.type === 'image/png' &&
        (!Number.isSafeInteger(request.artifact.frame) ||
          request.artifact.frame < 0 ||
          request.artifact.frame >= shot.durationFrames)
      ) {
        throw new RenderFailure(
          'INVALID_INSTRUCTIONS',
          'Still frame must be inside the shot frame range',
        );
      }
      if (request.signal?.aborted) {
        wasInterrupted = true;
        throw new RenderFailure(
          'INTERRUPTED',
          'Render was interrupted before it started',
          true,
        );
      }

      const assets = await validateAssets({ ...request, shot, settings });
      fingerprint = await makeFingerprint(
        { ...request, shot, settings },
        [...assets.values()],
        this.identity,
      );
      metrics['fingerprint'] = fingerprint;
      const cache = new ArtifactCache(request.cacheDirectory);
      try {
        const cached = await cache.restore(
          fingerprint,
          request.artifact.type,
          outputPath,
        );
        if (cached) {
          const inspection = await this.inspectArtifact({
            artifactType: request.artifact.type,
            path: outputPath,
            expectedFrameCount: expectedFrameCount({ ...request, shot }),
            expectedWidth: settings.outputDimensions.width,
            expectedHeight: settings.outputDimensions.height,
            expectedFrameRate: settings.frameRate,
            ...(request.artifact.type === 'video/mp4'
              ? {
                  expectedCodec: 'h264',
                  expectedPixelFormat: 'yuv420p',
                  expectedColorProfile: 'bt709',
                }
              : {}),
          });
          if (inspection.status === 'success') {
            metrics['cacheHit'] = true;
            const receipt: SuccessfulRenderReceipt = {
              jobId: request.jobId,
              shotId: shot.id,
              renderer: this.identity,
              fingerprint,
              startedAt: startedAt.toISOString(),
              completedAt: new Date().toISOString(),
              status: 'success',
              artifactType: request.artifact.type,
              outputPaths: cached.outputPaths,
              outputChecksums: cached.outputChecksums,
              logs,
              metrics,
            };
            await writeJsonAtomically(receiptPath, receipt);
            return { status: 'success', receipt, cacheHit: true };
          }
          logs.push(
            `Cache artifact failed inspection: ${inspection.error.message}`,
          );
        }
      } catch (error) {
        logs.push(`Cache restore failed; rendering again: ${String(error)}`);
      }

      const targetDirectory = dirname(outputPath);
      await mkdir(targetDirectory, { recursive: true });
      workDirectory = await mkdtemp(join(targetDirectory, '.remotion-shot-'));
      const targetIsDirectory = artifactIsDirectory(request.artifact);
      const temporaryOutput = targetIsDirectory
        ? join(workDirectory, 'frames')
        : join(workDirectory, `render${extname(outputPath) || '.mp4'}`);
      if (targetIsDirectory) await mkdir(temporaryOutput, { recursive: true });
      const { serveUrl, inputProps } = await buildBundle(
        workDirectory,
        [...assets.values()],
        shot,
      );
      const props: PreparedShotProps = {
        ...inputProps,
        randomSeed: request.randomSeed,
      };
      const browserExecutable = localBrowserExecutable();
      const compositionId = settings.renderer.config.compositionId;
      const composition = await selectComposition({
        serveUrl,
        id: compositionId,
        inputProps: props as unknown as Record<string, unknown>,
        ...(browserExecutable ? { browserExecutable } : {}),
        logLevel: 'error',
      });
      if (
        composition.width !== 1920 ||
        composition.height !== 1080 ||
        composition.fps !== 30 ||
        composition.durationInFrames !== shot.durationFrames
      ) {
        throw new RenderFailure(
          'INVALID_INSTRUCTIONS',
          'Remotion composition metadata does not match the requested shot settings',
        );
      }

      const cancellation = makeCancelSignal();
      const timeoutMs = request.timeoutMs ?? 5 * 60 * 1000;
      const timer = setTimeout(() => {
        timeoutReached = true;
        cancellation.cancel();
      }, timeoutMs);
      const onAbort = () => {
        wasInterrupted = true;
        cancellation.cancel();
      };
      request.signal?.addEventListener('abort', onAbort, { once: true });
      const startedRenderingAt = Date.now();
      try {
        if (request.artifact.type === 'video/mp4') {
          const qualityOptions =
            settings.quality.mode === 'crf'
              ? { crf: settings.quality.value }
              : settings.quality.mode === 'lossless'
                ? { crf: 0, preferLossless: true }
                : { videoBitrate: `${settings.quality.bitsPerSecond}b` };
          await renderMedia({
            composition,
            serveUrl,
            codec: 'h264',
            outputLocation: temporaryOutput,
            inputProps: props as unknown as Record<string, unknown>,
            pixelFormat: 'yuv420p',
            imageFormat: 'png',
            colorSpace: 'bt709',
            ...qualityOptions,
            ...(settings.renderer.config.concurrency !== undefined
              ? { concurrency: settings.renderer.config.concurrency }
              : {}),
            timeoutInMilliseconds: timeoutMs,
            cancelSignal: cancellation.cancelSignal,
            onProgress: (progress) => {
              metrics['renderedFrames'] = progress.renderedFrames;
              metrics['renderProgress'] = progress.progress;
            },
            onBrowserLog: (entry) => {
              if (logs.length < 200) logs.push(`${entry.type}: ${entry.text}`);
            },
            logLevel: 'error',
            ...(browserExecutable ? { browserExecutable } : {}),
            overwrite: true,
          });
        } else if (request.artifact.type === 'image-sequence/png') {
          await renderFrames({
            composition,
            serveUrl,
            inputProps: props as unknown as Record<string, unknown>,
            outputDir: temporaryOutput,
            imageFormat: 'png',
            imageSequencePattern: 'frame_[frame].png',
            ...(settings.renderer.config.concurrency !== undefined
              ? { concurrency: settings.renderer.config.concurrency }
              : {}),
            cancelSignal: cancellation.cancelSignal,
            onStart: () => undefined,
            onFrameUpdate: (renderedFrames) => {
              metrics['renderedFrames'] = renderedFrames;
            },
            onBrowserLog: (entry) => {
              if (logs.length < 200) logs.push(`${entry.type}: ${entry.text}`);
            },
            logLevel: 'error',
            ...(browserExecutable ? { browserExecutable } : {}),
          });
        } else {
          await renderStill({
            composition,
            serveUrl,
            inputProps: props as unknown as Record<string, unknown>,
            output: temporaryOutput,
            frame: request.artifact.frame,
            imageFormat: 'png',
            cancelSignal: cancellation.cancelSignal,
            onBrowserLog: (entry) => {
              if (logs.length < 200) logs.push(`${entry.type}: ${entry.text}`);
            },
            logLevel: 'error',
            overwrite: true,
            ...(browserExecutable ? { browserExecutable } : {}),
          });
        }
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
        metrics['renderDurationMs'] = Date.now() - startedRenderingAt;
      }
      if (timeoutReached || wasInterrupted) {
        throw new RenderFailure(
          timeoutReached ? 'TIMEOUT' : 'INTERRUPTED',
          timeoutReached
            ? 'Render exceeded its timeout'
            : 'Render was interrupted',
          true,
        );
      }

      const inspection = await this.inspectArtifact({
        artifactType: request.artifact.type,
        path: temporaryOutput,
        expectedFrameCount: expectedFrameCount({ ...request, shot }),
        expectedWidth: settings.outputDimensions.width,
        expectedHeight: settings.outputDimensions.height,
        expectedFrameRate: settings.frameRate,
        ...(request.artifact.type === 'video/mp4'
          ? {
              expectedCodec: 'h264',
              expectedPixelFormat: 'yuv420p',
              expectedColorProfile: 'bt709',
            }
          : {}),
      });
      if (inspection.status === 'failure') {
        throw new RenderFailure(
          'INCOMPLETE_OUTPUT',
          inspection.error.message,
          true,
        );
      }
      await promoteArtifact(temporaryOutput, outputPath, targetIsDirectory);
      const outputChecksums = await checksumsFor(outputPath, targetIsDirectory);
      metrics['cacheHit'] = false;
      try {
        await cache.store(fingerprint, request.artifact.type, outputPath);
        metrics['cacheStored'] = true;
      } catch (error) {
        metrics['cacheStored'] = false;
        logs.push(`Could not store cache entry: ${String(error)}`);
      }
      const outputPaths = targetIsDirectory
        ? outputChecksums.map((checksum) => checksum.path)
        : [outputPath];
      const receipt: SuccessfulRenderReceipt = {
        jobId: request.jobId,
        shotId: shot.id,
        renderer: this.identity,
        fingerprint,
        startedAt: startedAt.toISOString(),
        completedAt: new Date().toISOString(),
        status: 'success',
        artifactType: request.artifact.type,
        outputPaths,
        outputChecksums,
        logs,
        metrics,
      };
      await writeJsonAtomically(receiptPath, receipt);
      return { status: 'success', receipt, cacheHit: false };
    } catch (error) {
      if (error instanceof RenderFailure && error.code === 'INTERRUPTED')
        wasInterrupted = true;
      if (error instanceof RenderFailure && error.code === 'TIMEOUT')
        timeoutReached = true;
      return fail(error);
    } finally {
      if (workDirectory)
        await rm(workDirectory, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
  }
}

export { RENDERER_ID, RENDERER_VERSION };

export function getBundledMediaExecutables(): {
  ffmpegPath: string;
  ffprobePath: string;
} {
  return {
    ffmpegPath: RenderInternals.getExecutablePath({
      type: 'ffmpeg',
      indent: false,
      logLevel: 'error',
      binariesDirectory: null,
    }),
    ffprobePath: RenderInternals.getExecutablePath({
      type: 'ffprobe',
      indent: false,
      logLevel: 'error',
      binariesDirectory: null,
    }),
  };
}
