import { createReadStream, existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  AssetBuildSpecificationSchema,
  canonicalJsonSha256,
} from '@filmmaking/contracts';
import { AssetVersionSchema } from '@filmmaking/assets';
import {
  CHARCOAL_HORROR_STYLE,
  resolveCharcoalHorrorStyle,
} from '@filmmaking/scene';
import {
  ASSET_WORKER_PATH,
  defaultBlenderExecutable,
  EXPECTED_BLENDER_VERSION,
  runBlenderProcess,
} from './index.js';

const AUTHORING_IMPLEMENTATION_VERSION = 'blender-procedural-assets-v2';

type AssetVersion = ReturnType<typeof AssetVersionSchema.parse>;

export interface AssetBuildResult {
  projectId: string;
  assets: AssetVersion[];
  createdAssetIds: string[];
  reusedAssetIds: string[];
  specificationSha256: string;
  blenderVersion: string;
  receiptPath: string;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function key(assetId: string, version: string): string {
  return `${assetId}\u0000${version}`;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
  });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function buildProceduralAssets(options: {
  projectDirectory: string;
  blenderPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AssetBuildResult> {
  const projectDirectory = resolve(options.projectDirectory);
  const specPath = join(projectDirectory, 'asset-spec.json');
  if (!existsSync(specPath))
    throw new Error(`Procedural asset specification not found: ${specPath}`);
  if (!existsSync(ASSET_WORKER_PATH))
    throw new Error(`Blender asset worker not found: ${ASSET_WORKER_PATH}`);

  const spec = AssetBuildSpecificationSchema.parse(
    JSON.parse(await readFile(specPath, 'utf8')) as unknown,
  );
  if (spec.style.version !== CHARCOAL_HORROR_STYLE.version)
    throw new Error(
      `Asset specification pins charcoal_horror ${spec.style.version}; available version is ${CHARCOAL_HORROR_STYLE.version}.`,
    );
  const blenderPath = options.blenderPath ?? defaultBlenderExecutable();
  const versionResult = await runBlenderProcess(blenderPath, ['--version'], {
    timeoutMs: 15_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (versionResult.code !== 0)
    throw new Error(
      `Blender version query exited ${String(versionResult.code)}: ${versionResult.stderr}`,
    );
  const version = /Blender\s+(\d+\.\d+\.\d+)/.exec(versionResult.stdout)?.[1];
  if (version !== EXPECTED_BLENDER_VERSION)
    throw new Error(
      `Asset authoring requires Blender ${EXPECTED_BLENDER_VERSION}; found ${version ?? 'unknown'}`,
    );

  const workerHash = await sha256File(ASSET_WORKER_PATH);
  const specificationSha256 = canonicalJsonSha256({
    implementationVersion: AUTHORING_IMPLEMENTATION_VERSION,
    workerHash,
    blenderVersion: version,
    specification: spec,
  });
  const registryPath = join(projectDirectory, 'assets.json');
  const existingRegistry = existsSync(registryPath)
    ? (JSON.parse(await readFile(registryPath, 'utf8')) as unknown)
    : [];
  if (!Array.isArray(existingRegistry))
    throw new Error(
      'assets.json must contain an array before generated assets can be added.',
    );
  const registry = existingRegistry.map((entry) =>
    AssetVersionSchema.parse(entry),
  );
  const registryByKey = new Map(
    registry.map((asset) => [key(asset.assetId, asset.version), asset]),
  );
  const createdAssetIds: string[] = [];
  const reusedAssetIds: string[] = [];
  const pending = [] as typeof spec.assets;

  for (const asset of spec.assets) {
    const assetFingerprint = canonicalJsonSha256({
      implementationVersion: AUTHORING_IMPLEMENTATION_VERSION,
      workerHash,
      blenderVersion: version,
      seed: spec.seed,
      style: spec.style,
      styleSettings: CHARCOAL_HORROR_STYLE,
      asset,
    });
    const existing = registryByKey.get(key(asset.assetId, asset.version));
    const sourceUri = join(
      'assets',
      'generated',
      encoded(asset.assetId),
      asset.version,
      'asset.blend',
    ).replaceAll('\\', '/');
    const finalPath = resolve(projectDirectory, sourceUri);
    if (existing) {
      if (existing.metadata['generatorFingerprint'] !== assetFingerprint)
        throw new Error(
          `Asset ${asset.assetId}@${asset.version} already exists with different generator inputs. Add a new immutable version instead of replacing it.`,
        );
      const info = await stat(finalPath).catch(() => null);
      if (
        !info?.isFile() ||
        (await sha256File(finalPath)) !== existing.contentHash
      )
        throw new Error(
          `Registered generated asset is missing or corrupt: ${finalPath}`,
        );
      reusedAssetIds.push(asset.assetId);
      continue;
    }
    if (existsSync(finalPath))
      throw new Error(
        `Unregistered asset output already exists and will not be overwritten: ${finalPath}`,
      );
    pending.push(asset);
  }

  const generatedDirectory = join(projectDirectory, 'assets', 'generated');
  await mkdir(generatedDirectory, { recursive: true });
  const staging = await mkdtemp(join(generatedDirectory, '.filmie-authoring-'));
  const receiptPath = join(projectDirectory, 'preproduction.receipt.json');
  try {
    if (pending.length > 0) {
      const workerSpecPath = join(staging, 'asset-build-spec.json');
      const workerResultPath = join(staging, 'outputs', 'worker-result.json');
      const workerSpec = {
        projectId: spec.projectId,
        seed: spec.seed,
        style: resolveCharcoalHorrorStyle(spec.style.overrides),
        assets: pending,
        outputDirectory: join(staging, 'outputs'),
      };
      await writeFile(workerSpecPath, JSON.stringify(workerSpec), {
        flag: 'wx',
      });
      const processResult = await runBlenderProcess(
        blenderPath,
        [
          '--background',
          '--factory-startup',
          '--python',
          ASSET_WORKER_PATH,
          '--',
          workerSpecPath,
        ],
        {
          timeoutMs: options.timeoutMs ?? 600_000,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (processResult.timedOut)
        throw new Error('Blender procedural asset generation timed out.');
      if (processResult.interrupted)
        throw new Error('Blender procedural asset generation was interrupted.');
      if (processResult.code !== 0)
        throw new Error(
          `Blender asset worker exited ${String(processResult.code)}: ${processResult.stderr || processResult.stdout}`,
        );
      const workerResult = JSON.parse(
        await readFile(workerResultPath, 'utf8'),
      ) as {
        status?: unknown;
        assets?: {
          assetId: string;
          version: string;
          kind: string;
          displayName: string;
          sourcePath: string;
          collection: string;
          controls: string[];
          semanticControls: Record<string, string>;
          sha256: string;
        }[];
      };
      if (
        workerResult.status !== 'success' ||
        !Array.isArray(workerResult.assets)
      )
        throw new Error('Blender asset worker returned an invalid result.');

      for (const built of workerResult.assets) {
        const assetSpec = pending.find(
          (asset) =>
            asset.assetId === built.assetId && asset.version === built.version,
        );
        if (!assetSpec)
          throw new Error(`Worker returned unexpected asset ${built.assetId}.`);
        const assetFingerprint = canonicalJsonSha256({
          implementationVersion: AUTHORING_IMPLEMENTATION_VERSION,
          workerHash,
          blenderVersion: version,
          seed: spec.seed,
          style: spec.style,
          styleSettings: resolveCharcoalHorrorStyle(spec.style.overrides),
          asset: assetSpec,
        });
        const sourcePath = resolve(built.sourcePath);
        const actualHash = await sha256File(sourcePath);
        if (actualHash !== built.sha256)
          throw new Error(
            `Generated asset checksum mismatch for ${built.assetId}.`,
          );
        const sourceUri = join(
          'assets',
          'generated',
          encoded(built.assetId),
          built.version,
          'asset.blend',
        ).replaceAll('\\', '/');
        const destination = resolve(projectDirectory, sourceUri);
        await mkdir(dirname(destination), { recursive: true });
        await rename(sourcePath, destination);
        const record = AssetVersionSchema.parse({
          assetId: built.assetId,
          version: built.version,
          type: 'other',
          sourceUri,
          contentHash: actualHash,
          metadata: {
            generator: AUTHORING_IMPLEMENTATION_VERSION,
            generatorFingerprint: assetFingerprint,
            assetKind: built.kind,
            displayName: built.displayName,
            blenderCollection: built.collection,
            blenderControls: built.controls,
            ...(Object.keys(built.semanticControls ?? {}).length > 0
              ? {
                  rigSchemaVersion: 2,
                  semanticControls: built.semanticControls,
                }
              : {}),
            stylePreset: spec.style.id,
            styleVersion: spec.style.version,
          },
          license: {
            name: 'Procedurally authored in-house with Blender',
            restrictions: [],
          },
          provenance: { source: 'Filmie Blender procedural asset worker' },
        });
        registry.push(record);
        registryByKey.set(key(record.assetId, record.version), record);
        createdAssetIds.push(record.assetId);
      }
    }

    await writeJsonAtomic(registryPath, registry);
    const receipt = {
      projectId: spec.projectId,
      specificationSha256,
      implementationVersion: AUTHORING_IMPLEMENTATION_VERSION,
      blenderVersion: version,
      workerHash,
      status: 'success',
      createdAssetIds,
      reusedAssetIds,
      completedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(receiptPath, receipt);
    return {
      projectId: spec.projectId,
      assets: registry.filter((asset) =>
        spec.assets.some(
          (entry) =>
            key(entry.assetId, entry.version) ===
            key(asset.assetId, asset.version),
        ),
      ),
      createdAssetIds,
      reusedAssetIds,
      specificationSha256,
      blenderVersion: version,
      receiptPath,
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
