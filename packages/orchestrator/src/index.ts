import { randomUUID } from 'node:crypto';
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { AssetRegistry, type ResolvedAsset } from '@filmmaking/assets';
import { ArtifactCache } from '@filmmaking/cache';
import {
  canonicalJsonSha256,
  compareStrings,
  ProductionPackageSchema,
  type ProductionPackage,
  type ArtifactInspectionRequest,
  type RendererAdapter,
} from '@filmmaking/contracts';
import {
  prepareProductionPlan,
  type PreparedProductionPlan,
  type RenderJob,
} from '@filmmaking/planner';
import {
  createAssemblyFingerprint,
  type MediaAssemblyRequest,
  type MediaEngine,
  type MediaInspection,
} from '@filmmaking/media';

export type ProductionStage =
  | 'load-project'
  | 'validate-project'
  | 'resolve-assets'
  | 'compile-timeline'
  | 'render-shots'
  | 'encode-shots'
  | 'assemble'
  | 'verify-final';

export class ProductionError extends Error {
  constructor(
    readonly stage: ProductionStage,
    message: string,
    causeValue?: unknown,
  ) {
    super(`${stage}: ${message}`, { cause: causeValue });
    this.name = 'ProductionError';
  }
}

export interface ProductionOptions {
  projectDirectory: string;
  outputDirectory?: string;
  cacheDirectory?: string;
  manifestFileName?: string;
  registryFileName?: string;
  renderer: RendererAdapter;
  media: MediaEngine;
  randomSeed?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLog?: (line: string) => void;
}

export interface ProductionResult {
  status: 'success';
  projectId: string;
  masterPath: string;
  timelinePath: string;
  renderPlanPath: string;
  productionReceiptPath: string;
  assemblyReceiptPath: string;
  summaryPath: string;
  cacheHits: { shots: number; assembly: boolean };
  inspection: MediaInspection;
}

export interface LoadedProductionPlan {
  projectDirectory: string;
  registry: AssetRegistry;
  prepared: PreparedProductionPlan;
}

function safeProjectName(projectId: string): string {
  // Base64URL is injective; replacing percent escapes can collide with literal IDs.
  return Buffer.from(projectId, 'utf8').toString('base64url');
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

const PRODUCTION_PACKAGE_FILE = 'production-package.json';

function packageContent(
  projectId: string,
  manifest: LoadedProductionPlan['prepared']['manifest'],
  assets: readonly ResolvedAsset[],
) {
  const dependencies = assets
    .map(
      ({
        assetId,
        version,
        contentHash,
        type,
        sourceUri,
        metadata,
        license,
        provenance,
      }) => ({
        assetId,
        version,
        contentHash,
        assetRecordSha256: canonicalJsonSha256({
          type,
          sourceUri,
          contentHash,
          metadata,
          license,
          provenance,
        }),
      }),
    )
    .sort((left, right) =>
      compareStrings(
        `${left.assetId}@${left.version}`,
        `${right.assetId}@${right.version}`,
      ),
    );
  const manifestSha256 = canonicalJsonSha256(manifest);
  const dependencySha256 = canonicalJsonSha256(dependencies);
  const fingerprint = canonicalJsonSha256({
    packageVersion: '1.0.0',
    projectId,
    manifestSha256,
    dependencySha256,
  });
  return { manifestSha256, dependencySha256, fingerprint, dependencies };
}

export async function loadProductionPlan(options: {
  projectDirectory: string;
  manifestFileName?: string;
  registryFileName?: string;
  allowUnapprovedPackage?: boolean;
  skipPackageValidation?: boolean;
}): Promise<LoadedProductionPlan> {
  const projectDirectory = resolve(options.projectDirectory);
  const manifestPath = join(
    projectDirectory,
    options.manifestFileName ?? 'manifest.json',
  );
  const registryPath = join(
    projectDirectory,
    options.registryFileName ?? 'assets.json',
  );
  let manifestInput: unknown;
  let registryInput: unknown;
  try {
    [manifestInput, registryInput] = await Promise.all([
      readJson(manifestPath),
      readJson(registryPath),
    ]);
  } catch (error) {
    throw new ProductionError(
      'load-project',
      `Could not read ${manifestPath} and ${registryPath}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  if (!Array.isArray(registryInput))
    throw new ProductionError(
      'load-project',
      `${registryPath} must contain an array of immutable asset versions.`,
    );
  let registry: AssetRegistry;
  try {
    registry = new AssetRegistry(registryInput);
  } catch (error) {
    throw new ProductionError(
      'validate-project',
      `Asset registry validation failed: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  let prepared: PreparedProductionPlan;
  try {
    prepared = await prepareProductionPlan(
      manifestInput,
      registry,
      projectDirectory,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stage: ProductionStage =
      /not found|not registered|SHA-256 mismatch|source scheme/i.test(message)
        ? 'resolve-assets'
        : 'validate-project';
    throw new ProductionError(stage, message, error);
  }
  if (!options.skipPackageValidation) {
    const packagePath = join(projectDirectory, PRODUCTION_PACKAGE_FILE);
    try {
      const packageInput = await readJson(packagePath);
      const productionPackage = ProductionPackageSchema.parse(packageInput);
      const expected = packageContent(
        prepared.manifest.projectId,
        prepared.manifest,
        prepared.assets,
      );
      if (
        productionPackage.projectId !== prepared.manifest.projectId ||
        productionPackage.manifestSha256 !== expected.manifestSha256 ||
        productionPackage.dependencySha256 !== expected.dependencySha256 ||
        productionPackage.fingerprint !== expected.fingerprint ||
        canonicalJsonSha256(productionPackage.dependencies) !==
          expected.dependencySha256
      ) {
        throw new Error(
          'Production package is stale: manifest or resolved asset dependencies changed. Prepare and approve it again.',
        );
      }
      if (
        productionPackage.status !== 'approved' &&
        !options.allowUnapprovedPackage
      )
        throw new Error(
          'Production package is not approved. Run `filmie package approve` after human review.',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Existing projects without package locks remain runnable for compatibility.
      } else {
        throw new ProductionError(
          'validate-project',
          `Production package validation failed: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    }
  }
  return { projectDirectory, registry, prepared };
}

export async function prepareProductionPackage(options: {
  projectDirectory: string;
  replace?: boolean;
}): Promise<{ path: string; fingerprint: string; dependencyCount: number }> {
  const loaded = await loadProductionPlan({
    projectDirectory: options.projectDirectory,
    skipPackageValidation: true,
  });
  const path = join(loaded.projectDirectory, PRODUCTION_PACKAGE_FILE);
  if (!options.replace) {
    try {
      await stat(path);
      throw new Error(
        `Production package already exists at ${path}; pass replace only when intentionally regenerating and revoking any approval.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const content = packageContent(
    loaded.prepared.manifest.projectId,
    loaded.prepared.manifest,
    loaded.prepared.assets,
  );
  const productionPackage: ProductionPackage = ProductionPackageSchema.parse({
    packageVersion: '1.0.0',
    projectId: loaded.prepared.manifest.projectId,
    status: 'prepared',
    ...content,
  });
  await writeJson(path, productionPackage);
  return {
    path,
    fingerprint: productionPackage.fingerprint,
    dependencyCount: productionPackage.dependencies.length,
  };
}

export async function approveProductionPackage(options: {
  projectDirectory: string;
  approvedBy: string;
}): Promise<{ path: string; fingerprint: string }> {
  const loaded = await loadProductionPlan({
    projectDirectory: options.projectDirectory,
    allowUnapprovedPackage: true,
  });
  const path = join(loaded.projectDirectory, PRODUCTION_PACKAGE_FILE);
  const existing = ProductionPackageSchema.parse(await readJson(path));
  const approved: ProductionPackage = ProductionPackageSchema.parse({
    ...existing,
    status: 'approved',
    approval: {
      approvedBy: options.approvedBy,
      approvedAt: new Date().toISOString(),
    },
  });
  await writeJson(path, approved);
  return { path, fingerprint: approved.fingerprint };
}

function rendererAsset(asset: ResolvedAsset) {
  return {
    assetId: asset.assetId,
    version: asset.version,
    type: asset.type,
    sourceUri: asset.sourceUri,
    localPath: asset.localPath,
    contentHash: asset.contentHash,
    metadata: asset.metadata,
  };
}

function audioAssets(prepared: PreparedProductionPlan) {
  const audioReferences = prepared.manifest.shots.flatMap((shot) =>
    (shot.audioCues ?? []).map((cue) => cue.asset),
  );
  const keys = new Set(
    audioReferences.map(
      (reference) => `${reference.assetId}\u0000${reference.version}`,
    ),
  );
  return prepared.assets
    .filter((asset) => keys.has(`${asset.assetId}\u0000${asset.version}`))
    .map((asset) => ({
      assetId: asset.assetId,
      version: asset.version,
      contentHash: asset.contentHash,
    }));
}

function mediaAssets(assets: readonly ResolvedAsset[]) {
  return assets.map((asset) => ({
    assetId: asset.assetId,
    version: asset.version,
    localPath: asset.localPath,
    contentHash: asset.contentHash,
  }));
}

async function promoteFile(
  stagedPath: string,
  destination: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(stagedPath, destination);
  } catch (error) {
    const backupPath = `${destination}.previous-${randomUUID()}`;
    try {
      const existing = await lstat(destination);
      if (!existing.isFile() || existing.isSymbolicLink()) throw error;
      await rename(destination, backupPath);
    } catch {
      throw new Error(
        `Could not promote verified output to ${destination}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    try {
      await rename(stagedPath, destination);
    } catch (promotionError) {
      await rename(backupPath, destination);
      throw new Error(
        `Could not promote verified output to ${destination}: ${promotionError instanceof Error ? promotionError.message : String(promotionError)}`,
        { cause: promotionError },
      );
    }
    await rm(backupPath, { force: true });
  }
}

function asShotJob(
  job: PreparedProductionPlan['renderPlan']['jobs'][number],
): job is RenderJob {
  return job.kind === 'render-shot';
}

export async function executeProduction(
  options: ProductionOptions,
): Promise<ProductionResult> {
  const outputDirectory = resolve(options.outputDirectory ?? 'dist');
  const cacheDirectory = resolve(options.cacheDirectory ?? '.cache/production');
  const startedAt = new Date().toISOString();
  let loaded: LoadedProductionPlan | undefined;
  let productionDirectory = '';
  let logPath = '';
  const log = async (message: string) => {
    options.onLog?.(message);
    if (logPath)
      await appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`);
  };
  try {
    loaded = await loadProductionPlan(options);
    const { prepared } = loaded;
    productionDirectory = join(
      outputDirectory,
      'production',
      safeProjectName(prepared.manifest.projectId),
    );
    logPath = join(productionDirectory, 'production.log');
    await mkdir(join(productionDirectory, 'shots'), { recursive: true });
    await log(
      `Loaded project ${prepared.manifest.projectId}@${prepared.manifest.version}.`,
    );
    await log(
      `Validated ${prepared.manifest.shots.length} shots and resolved ${prepared.assets.length} assets.`,
    );
    await log(
      `Compiled timeline ${prepared.timeline.sha256} (${prepared.timeline.durationFrames} frames).`,
    );
    const timelinePath = join(productionDirectory, 'compiled-timeline.json');
    const renderPlanPath = join(productionDirectory, 'render-plan.json');
    await writeJson(timelinePath, prepared.timeline);
    await writeJson(renderPlanPath, prepared.renderPlan);

    const shotArtifacts: Record<string, string> = {};
    const shotReceipts: {
      shotId: string;
      fingerprint: string;
      receiptPath: string;
      outputPath: string;
      checksum: string;
      cacheHit: boolean;
      verifyWithMedia: boolean;
    }[] = [];
    for (const job of prepared.renderPlan.jobs.filter(asShotJob)) {
      const shot = prepared.manifest.shots.find(
        (candidate) => candidate.id === job.shotId,
      );
      if (!shot)
        throw new ProductionError(
          'render-shots',
          `Render plan refers to unknown shot ${job.shotId}.`,
        );
      const outputPath = join(
        productionDirectory,
        'shots',
        `${encodeURIComponent(shot.id)}.mp4`,
      );
      const usesImageSequence = job.renderer.id === 'blender';
      const sequenceDirectory = join(
        productionDirectory,
        'shots',
        `${encodeURIComponent(shot.id)}.blender`,
      );
      const receiptPath = usesImageSequence
        ? `${outputPath}.render.receipt.json`
        : `${outputPath}.receipt.json`;
      const refs = new Set(
        job.inputAssets.map(
          (reference) => `${reference.assetId}\u0000${reference.version}`,
        ),
      );
      const assets = prepared.assets.filter((asset) =>
        refs.has(`${asset.assetId}\u0000${asset.version}`),
      );
      await log(`Rendering shot ${shot.id} (${shot.durationFrames} frames).`);
      const result = await options.renderer.renderShot({
        jobId: job.id,
        shot,
        ...(prepared.compiledScenes[shot.id]
          ? { scene: prepared.compiledScenes[shot.id] }
          : {}),
        assets: assets.map(rendererAsset),
        settings: prepared.manifest.renderPolicy,
        artifact: usesImageSequence
          ? { type: 'image-sequence/png', outputDirectory: sequenceDirectory }
          : { type: 'video/mp4', outputPath },
        randomSeed: options.randomSeed ?? 0,
        cacheDirectory: join(
          cacheDirectory,
          safeProjectName(prepared.manifest.projectId),
          'shots',
        ),
        receiptPath,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (result.status === 'failure') {
        await log(
          `Shot ${shot.id} failed (${result.error.code}): ${result.error.message}`,
        );
        throw new ProductionError(
          'render-shots',
          `Shot ${shot.id} failed: ${result.error.message}`,
        );
      }
      if (
        result.receipt.status !== 'success' ||
        result.receipt.outputChecksums.length === 0
      ) {
        throw new ProductionError(
          'render-shots',
          `Shot ${shot.id} did not produce a verified artifact.`,
        );
      }
      let shotChecksum = result.receipt.outputChecksums[0]?.sha256 ?? '';
      if (usesImageSequence) {
        const frameChecksums = result.receipt.outputChecksums
          .filter((item) =>
            /[\\/]frames[\\/]frame_\d{6}\.png$/i.test(item.path),
          )
          .map((item) => ({
            path: item.path.replace(sequenceDirectory, ''),
            sha256: item.sha256,
          }))
          .sort((left, right) => left.path.localeCompare(right.path));
        if (frameChecksums.length !== shot.durationFrames) {
          throw new ProductionError(
            'render-shots',
            `Shot ${shot.id} PNG sequence has ${frameChecksums.length} frame checksums; expected ${shot.durationFrames}.`,
          );
        }
        const encodeFingerprint = canonicalJsonSha256({
          frames: frameChecksums,
          policy: prepared.manifest.renderPolicy,
          implementationVersion: options.media.identity.version,
        });
        const encodingCache = new ArtifactCache(
          join(
            cacheDirectory,
            safeProjectName(prepared.manifest.projectId),
            'shot-videos',
          ),
        );
        let encoded = await encodingCache.restore(
          encodeFingerprint,
          'video/mp4',
          outputPath,
        );
        let encodedCacheHit = Boolean(encoded);
        if (encoded) {
          const cachedInspection = await options.media.inspect(outputPath, {
            frames: shot.durationFrames,
            policy: prepared.manifest.renderPolicy,
          });
          if (cachedInspection.status === 'success') {
            shotChecksum = cachedInspection.value.sha256;
          } else {
            await rm(outputPath, { force: true });
            encoded = null;
            encodedCacheHit = false;
          }
        }
        if (!encoded) {
          await log(`Encoding shot ${shot.id} PNG sequence with FFmpeg.`);
          const converted = await options.media.encodeImageSequence({
            inputDirectory: join(sequenceDirectory, 'frames'),
            outputPath,
            frameCount: shot.durationFrames,
            policy: prepared.manifest.renderPolicy,
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
          });
          if (converted.status === 'failure') {
            throw new ProductionError(
              'encode-shots',
              `Shot ${shot.id} PNG sequence encoding failed: ${converted.error.message}`,
            );
          }
          shotChecksum = converted.value.sha256;
          try {
            await encodingCache.store(
              encodeFingerprint,
              'video/mp4',
              outputPath,
            );
          } catch (error) {
            await log(
              `Could not cache encoded shot ${shot.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        await log(
          `Shot ${shot.id} video ${encodedCacheHit ? 'encoding cache hit' : 'encoded'}; SHA-256 ${shotChecksum}.`,
        );
      }
      shotArtifacts[shot.id] = outputPath;
      shotReceipts.push({
        shotId: shot.id,
        fingerprint: result.receipt.fingerprint,
        receiptPath,
        outputPath,
        checksum: shotChecksum,
        cacheHit: result.cacheHit,
        verifyWithMedia: usesImageSequence,
      });
      await log(
        `Shot ${shot.id} ${result.cacheHit ? 'cache hit' : 'rendered'}; SHA-256 ${shotChecksum || 'missing'}.`,
      );
    }

    const assemblyFingerprint = createAssemblyFingerprint({
      timeline: prepared.timeline,
      manifest: prepared.manifest,
      shotArtifacts: shotReceipts.map((receipt) => ({
        shotId: receipt.shotId,
        sha256: receipt.checksum,
      })),
      audioAssets: audioAssets(prepared),
      implementationVersion: options.media.identity.version,
    });
    for (const receipt of shotReceipts) {
      const shot = prepared.manifest.shots.find(
        (candidate) => candidate.id === receipt.shotId,
      );
      if (!shot)
        throw new ProductionError(
          'render-shots',
          `Shot receipt refers to unknown shot ${receipt.shotId}.`,
        );
      const inspectionRequest: ArtifactInspectionRequest = {
        artifactType: 'video/mp4',
        path: receipt.outputPath,
        expectedFrameCount: shot.durationFrames,
        expectedWidth: prepared.manifest.renderPolicy.outputDimensions.width,
        expectedHeight: prepared.manifest.renderPolicy.outputDimensions.height,
        expectedFrameRate: prepared.manifest.renderPolicy.frameRate,
        expectedCodec: 'h264',
        expectedPixelFormat: 'yuv420p',
        expectedColorProfile: 'bt709',
      };
      const verifiedShot = receipt.verifyWithMedia
        ? await options.media
            .inspect(receipt.outputPath, {
              frames: shot.durationFrames,
              policy: prepared.manifest.renderPolicy,
            })
            .then((result) =>
              result.status === 'success'
                ? {
                    status: 'success' as const,
                    value: {
                      outputChecksums: [{ sha256: result.value.sha256 }],
                    },
                  }
                : { status: 'failure' as const, error: result.error },
            )
        : await options.renderer.inspectArtifact(inspectionRequest);
      if (verifiedShot.status === 'failure')
        throw new ProductionError(
          'render-shots',
          `Shot ${receipt.shotId} failed pre-assembly verification: ${verifiedShot.error.message}`,
        );
      if (verifiedShot.value.outputChecksums[0]?.sha256 !== receipt.checksum)
        throw new ProductionError(
          'render-shots',
          `Shot ${receipt.shotId} changed after its successful receipt was written.`,
        );
    }
    const masterPath = join(outputDirectory, 'master.mp4');
    const assemblyReceiptPath = join(
      productionDirectory,
      'assembly.receipt.json',
    );
    const assemblyCache = new ArtifactCache(
      join(
        cacheDirectory,
        safeProjectName(prepared.manifest.projectId),
        'assembly',
      ),
    );
    const stagedMaster = join(outputDirectory, `.master-${randomUUID()}.mp4`);
    let assemblyCacheHit = false;
    const assemblyStartedAt = new Date().toISOString();
    let inspection: MediaInspection | undefined;
    let assemblyLogs: string[] = [];
    let assemblyDurationMs = 0;
    const cachedAssembly = await assemblyCache.restore(
      assemblyFingerprint,
      'video/mp4',
      stagedMaster,
    );
    if (cachedAssembly) {
      const cachedInspection = await options.media.inspect(stagedMaster, {
        frames: prepared.timeline.durationFrames,
        policy: prepared.manifest.renderPolicy,
      });
      if (cachedInspection.status === 'success') {
        inspection = cachedInspection.value;
        assemblyCacheHit = true;
        await log(`Assembly cache hit ${assemblyFingerprint}.`);
      } else {
        await rm(stagedMaster, { force: true });
        await log(
          `Cached assembly failed FFprobe validation; rebuilding: ${cachedInspection.error.message}`,
        );
      }
    }
    if (!inspection) {
      await log(`Assembling ${shotReceipts.length} shots with FFmpeg.`);
      const assemblyRequest: MediaAssemblyRequest = {
        manifest: prepared.manifest,
        timeline: prepared.timeline,
        shotArtifacts,
        assets: mediaAssets(prepared.assets),
        outputPath: stagedMaster,
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      };
      const assembled = await options.media.assemble(assemblyRequest);
      if (assembled.status === 'failure') {
        await log(
          `Assembly failed (${assembled.error.code}): ${assembled.error.message}`,
        );
        throw new ProductionError('assemble', assembled.error.message);
      }
      assemblyLogs = assembled.value.logs;
      assemblyDurationMs = assembled.value.durationMs;
      const verified = await options.media.inspect(stagedMaster, {
        frames: prepared.timeline.durationFrames,
        policy: prepared.manifest.renderPolicy,
      });
      if (verified.status === 'failure')
        throw new ProductionError('verify-final', verified.error.message);
      inspection = verified.value;
      await log(
        `FFprobe verified master: ${inspection.frameCount} frames, ${inspection.width}x${inspection.height}, ${inspection.frameRate} FPS, ${inspection.codec}, ${inspection.pixelFormat}, ${inspection.colorProfile}.`,
      );
    }
    if (!inspection)
      throw new ProductionError(
        'verify-final',
        'Final video was not verified.',
      );
    await promoteFile(stagedMaster, masterPath);
    let cacheStored = false;
    try {
      await assemblyCache.store(assemblyFingerprint, 'video/mp4', masterPath);
      cacheStored = true;
    } catch (error) {
      await log(
        `Could not store assembly cache: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const assemblyReceipt = {
      jobId: `assemble-project:${prepared.manifest.projectId}@${prepared.manifest.version}`,
      projectId: prepared.manifest.projectId,
      renderer: options.media.identity,
      fingerprint: assemblyFingerprint,
      startedAt: assemblyStartedAt,
      completedAt: new Date().toISOString(),
      status: 'success' as const,
      cacheHit: assemblyCacheHit,
      cacheStored,
      dependencies: shotReceipts.map((receipt) => ({
        shotId: receipt.shotId,
        sha256: receipt.checksum,
      })),
      outputPath: masterPath,
      outputChecksum: inspection.sha256,
      outputBytes: inspection.bytes,
      inspection,
      logs: assemblyLogs,
      metrics: { durationMs: assemblyDurationMs, cacheHit: assemblyCacheHit },
    };
    await writeJson(assemblyReceiptPath, assemblyReceipt);
    const receiptPath = join(productionDirectory, 'production.receipt.json');
    const productionReceipt = {
      projectId: prepared.manifest.projectId,
      projectVersion: prepared.manifest.version,
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'success' as const,
      manifestSha256: prepared.renderPlan.manifestSha256,
      timelineSha256: prepared.timeline.sha256,
      renderPlanSha256: prepared.renderPlan.sha256,
      assemblyFingerprint,
      masterPath,
      shotReceipts,
      assemblyReceiptPath,
      inspection,
    };
    await writeJson(receiptPath, productionReceipt);
    const summaryPath = join(productionDirectory, 'summary.md');
    await atomicWrite(
      summaryPath,
      `# Production summary: ${prepared.manifest.projectId}\n\n- Status: success\n- Project version: ${prepared.manifest.version}\n- Shots: ${shotReceipts.length}\n- Duration: ${((inspection.frameCount * prepared.manifest.video.frameRate.denominator) / prepared.manifest.video.frameRate.numerator).toFixed(2)} seconds\n- Output: ${masterPath}\n- Video: ${inspection.width} × ${inspection.height}, ${inspection.frameRate} FPS, ${inspection.codec}, ${inspection.pixelFormat}, ${inspection.colorProfile}\n- Shot cache hits: ${shotReceipts.filter((receipt) => receipt.cacheHit).length}/${shotReceipts.length}\n- Assembly cache hit: ${assemblyCacheHit}\n- Master SHA-256: ${inspection.sha256}\n`,
    );
    await log(`Production completed successfully: ${masterPath}.`);
    return {
      status: 'success',
      projectId: prepared.manifest.projectId,
      masterPath,
      timelinePath,
      renderPlanPath,
      productionReceiptPath: receiptPath,
      assemblyReceiptPath,
      summaryPath,
      cacheHits: {
        shots: shotReceipts.filter((receipt) => receipt.cacheHit).length,
        assembly: assemblyCacheHit,
      },
      inspection,
    };
  } catch (error) {
    if (error instanceof ProductionError) {
      await log(`Production failed at ${error.stage}: ${error.message}`).catch(
        () => undefined,
      );
      if (loaded && productionDirectory) {
        await writeJson(join(productionDirectory, 'production.receipt.json'), {
          projectId: loaded.prepared.manifest.projectId,
          projectVersion: loaded.prepared.manifest.version,
          startedAt,
          completedAt: new Date().toISOString(),
          status: 'failure',
          stage: error.stage,
          error: error.message,
          manifestSha256: canonicalJsonSha256(loaded.prepared.manifest),
          timelineSha256: loaded.prepared.timeline.sha256,
        }).catch(() => undefined);
        await atomicWrite(
          join(productionDirectory, 'summary.md'),
          `# Production summary: ${loaded.prepared.manifest.projectId}\n\n- Status: failure\n- Stage: ${error.stage}\n- Error: ${error.message}\n`,
        ).catch(() => undefined);
      }
      throw error;
    }
    const wrapped = new ProductionError(
      loaded ? 'assemble' : 'load-project',
      error instanceof Error ? error.message : String(error),
      error,
    );
    await log(
      `Production failed at ${wrapped.stage}: ${wrapped.message}`,
    ).catch(() => undefined);
    throw wrapped;
  }
}

export async function inspectProductionProject(options: {
  projectDirectory: string;
  outputDirectory?: string;
  cacheDirectory?: string;
  manifestFileName?: string;
  registryFileName?: string;
}): Promise<{
  loaded: LoadedProductionPlan;
  productionDirectory: string;
  cacheDirectory: string;
}> {
  const loaded = await loadProductionPlan(options);
  const productionDirectory = join(
    resolve(options.outputDirectory ?? 'dist'),
    'production',
    safeProjectName(loaded.prepared.manifest.projectId),
  );
  return {
    loaded,
    productionDirectory,
    cacheDirectory: join(
      resolve(options.cacheDirectory ?? '.cache/production'),
      safeProjectName(loaded.prepared.manifest.projectId),
    ),
  };
}

export async function cleanProductionFiles(
  outputDirectory: string,
  cacheDirectory: string,
  projectId: string,
): Promise<void> {
  const safeId = safeProjectName(projectId);
  const outputRoot = resolve(outputDirectory);
  const productionPath = join(outputRoot, 'production', safeId);
  let ownsMaster = false;
  try {
    const receipt = (await readJson(
      join(productionPath, 'production.receipt.json'),
    )) as {
      projectId?: unknown;
      masterPath?: unknown;
    };
    ownsMaster =
      receipt.projectId === projectId &&
      typeof receipt.masterPath === 'string' &&
      resolve(receipt.masterPath) === join(outputRoot, 'master.mp4');
  } catch {
    // Without a valid ownership receipt, preserve the shared master output.
  }
  await Promise.all([
    rm(productionPath, {
      recursive: true,
      force: true,
    }),
    rm(join(resolve(cacheDirectory), safeId), { recursive: true, force: true }),
    ...(ownsMaster
      ? [rm(join(outputRoot, 'master.mp4'), { force: true })]
      : []),
  ]);
}
