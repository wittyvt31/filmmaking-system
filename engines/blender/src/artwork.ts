import { createReadStream, existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rmdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import {
  ArtworkPreparationSpecificationSchema,
  canonicalJsonSha256,
} from '@filmmaking/contracts';
import {
  AssetRegistry,
  AssetVersionSchema,
  resolveAssetFiles,
} from '@filmmaking/assets';
import {
  CHARCOAL_HORROR_STYLE,
  resolveCharcoalHorrorStyle,
} from '@filmmaking/scene';
import {
  ARTWORK_WORKER_PATH,
  defaultBlenderExecutable,
  EXPECTED_BLENDER_VERSION,
  runBlenderProcess,
} from './index.js';

const IMPLEMENTATION_VERSION = 'layered-artwork-preparation-v2';
type AssetVersion = ReturnType<typeof AssetVersionSchema.parse>;

export interface ArtworkPreparationResult {
  projectId: string;
  assets: AssetVersion[];
  createdAssetIds: string[];
  reusedAssetIds: string[];
  specificationSha256: string;
  blenderVersion: string;
  receiptPath: string;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function versionKey(assetId: string, version: string): string {
  return `${assetId}\u0000${version}`;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function prepareLayeredArtwork(options: {
  projectDirectory: string;
  blenderPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ArtworkPreparationResult> {
  const projectDirectory = resolve(options.projectDirectory);
  const specPath = join(projectDirectory, 'artwork-spec.json');
  const registryPath = join(projectDirectory, 'assets.json');
  if (!existsSync(specPath))
    throw new Error(`Artwork preparation specification not found: ${specPath}`);
  if (!existsSync(registryPath))
    throw new Error(`Asset registry not found: ${registryPath}`);
  if (!existsSync(ARTWORK_WORKER_PATH))
    throw new Error(`Blender artwork worker not found: ${ARTWORK_WORKER_PATH}`);

  const specification = ArtworkPreparationSpecificationSchema.parse(
    JSON.parse(await readFile(specPath, 'utf8')) as unknown,
  );
  if (specification.style.version !== CHARCOAL_HORROR_STYLE.version)
    throw new Error(
      `Artwork specification pins charcoal_horror ${specification.style.version}; available version is ${CHARCOAL_HORROR_STYLE.version}.`,
    );

  const rawRegistry = JSON.parse(
    await readFile(registryPath, 'utf8'),
  ) as unknown;
  if (!Array.isArray(rawRegistry))
    throw new Error('assets.json must contain an array.');
  const registry = new AssetRegistry(rawRegistry);
  const references = specification.assets.flatMap((asset) =>
    asset.layers.map((layer) => layer.source),
  );
  const resolvedSources = await resolveAssetFiles(
    references,
    registry,
    projectDirectory,
  );
  const sourceByKey = new Map(
    resolvedSources.map((asset) => [
      versionKey(asset.assetId, asset.version),
      asset,
    ]),
  );
  for (const asset of resolvedSources) {
    if (!['image', 'graphic'].includes(asset.type))
      throw new Error(
        `Artwork layer ${asset.assetId}@${asset.version} must reference an image or graphic asset, not ${asset.type}.`,
      );
    if (!asset.localPath.toLowerCase().endsWith('.png'))
      throw new Error(
        `Artwork layer ${asset.assetId}@${asset.version} must be a PNG with alpha support: ${asset.localPath}`,
      );
  }

  const blenderPath = options.blenderPath ?? defaultBlenderExecutable();
  const versionResult = await runBlenderProcess(blenderPath, ['--version'], {
    timeoutMs: 15_000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (versionResult.code !== 0)
    throw new Error(
      `Blender version query exited ${String(versionResult.code)}: ${versionResult.stderr}`,
    );
  const blenderVersion = /Blender\s+(\d+\.\d+\.\d+)/.exec(
    versionResult.stdout,
  )?.[1];
  if (blenderVersion !== EXPECTED_BLENDER_VERSION)
    throw new Error(
      `Layered artwork preparation requires Blender ${EXPECTED_BLENDER_VERSION}; found ${blenderVersion ?? 'unknown'}.`,
    );

  const workerHash = await hashFile(ARTWORK_WORKER_PATH);
  const inputAssets = specification.assets.map((asset) => ({
    ...asset,
    layers: asset.layers.map((layer) => {
      const source = sourceByKey.get(
        versionKey(layer.source.assetId, layer.source.version),
      );
      if (!source)
        throw new Error(
          `Unresolved artwork layer source ${layer.source.assetId}@${layer.source.version}`,
        );
      return {
        ...layer,
        source: {
          assetId: source.assetId,
          version: source.version,
          localPath: source.localPath,
          contentHash: source.contentHash,
        },
      };
    }),
  }));
  const fingerprintFor = (asset: (typeof inputAssets)[number]) =>
    canonicalJsonSha256({
      implementationVersion: IMPLEMENTATION_VERSION,
      workerHash,
      blenderVersion,
      style: specification.style,
      styleSettings: resolveCharcoalHorrorStyle(specification.style.overrides),
      asset: {
        ...asset,
        layers: asset.layers.map((layer) => ({
          ...layer,
          source: {
            assetId: layer.source.assetId,
            version: layer.source.version,
            contentHash: layer.source.contentHash,
          },
        })),
      },
    });
  const specificationSha256 = canonicalJsonSha256({
    implementationVersion: IMPLEMENTATION_VERSION,
    workerHash,
    blenderVersion,
    specification,
    sources: resolvedSources.map(({ assetId, version, contentHash }) => ({
      assetId,
      version,
      contentHash,
    })),
  });
  const registryRecords = rawRegistry.map((entry) =>
    AssetVersionSchema.parse(entry),
  );
  const registryByKey = new Map(
    registryRecords.map((asset) => [
      versionKey(asset.assetId, asset.version),
      asset,
    ]),
  );
  const createdAssetIds: string[] = [];
  const reusedAssetIds: string[] = [];
  const pending: typeof inputAssets = [];
  for (const asset of inputAssets) {
    const prior = registryByKey.get(versionKey(asset.assetId, asset.version));
    const sourceUri = join(
      'assets',
      'generated',
      encodeURIComponent(asset.assetId),
      asset.version,
      'asset.blend',
    ).replaceAll('\\', '/');
    const outputPath = resolve(projectDirectory, sourceUri);
    if (prior) {
      if (prior.metadata['generatorFingerprint'] !== fingerprintFor(asset))
        throw new Error(
          `Asset ${asset.assetId}@${asset.version} already exists with different artwork inputs. Add a new immutable version instead of replacing it.`,
        );
      const fileInfo = await stat(outputPath).catch(() => null);
      if (
        !fileInfo?.isFile() ||
        (await hashFile(outputPath)) !== prior.contentHash
      )
        throw new Error(
          `Registered prepared artwork is missing or corrupt: ${outputPath}`,
        );
      reusedAssetIds.push(asset.assetId);
      continue;
    }
    if (existsSync(outputPath))
      throw new Error(
        `Unregistered artwork package exists and will not be overwritten: ${outputPath}`,
      );
    pending.push(asset);
  }

  const generatedDirectory = join(projectDirectory, 'assets', 'generated');
  await mkdir(generatedDirectory, { recursive: true });
  const staging = await mkdtemp(join(generatedDirectory, '.filmie-artwork-'));
  const workerOutput = join(staging, 'outputs');
  const receiptPath = join(
    projectDirectory,
    'artwork-preparation.receipt.json',
  );
  try {
    if (pending.length > 0) {
      const workerSpecPath = join(staging, 'artwork-build-spec.json');
      const workerResultPath = join(workerOutput, 'worker-result.json');
      await writeFile(
        workerSpecPath,
        JSON.stringify({
          style: resolveCharcoalHorrorStyle(specification.style.overrides),
          assets: pending,
          outputDirectory: workerOutput,
        }),
        { flag: 'wx' },
      );
      const workerResult = await runBlenderProcess(
        blenderPath,
        [
          '--background',
          '--factory-startup',
          '--python',
          ARTWORK_WORKER_PATH,
          '--',
          workerSpecPath,
        ],
        {
          timeoutMs: options.timeoutMs ?? 600_000,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (workerResult.timedOut)
        throw new Error('Blender layered artwork preparation timed out.');
      if (workerResult.interrupted)
        throw new Error('Blender layered artwork preparation was interrupted.');
      if (workerResult.code !== 0)
        throw new Error(
          `Blender artwork worker exited ${String(workerResult.code)}: ${workerResult.stderr || workerResult.stdout}`,
        );
      const result = JSON.parse(await readFile(workerResultPath, 'utf8')) as {
        status?: unknown;
        assets?: {
          assetId: string;
          version: string;
          kind: string;
          displayName: string;
          collection: string;
          sourcePath: string;
          sha256: string;
        }[];
      };
      if (result.status !== 'success' || !Array.isArray(result.assets))
        throw new Error('Blender artwork worker returned an invalid result.');
      if (result.assets.length !== pending.length)
        throw new Error(
          `Blender artwork worker returned ${result.assets.length} packages for ${pending.length} requested assets.`,
        );
      const builtKeys = new Set<string>();
      const newRecords: AssetVersion[] = [];
      const promotions: { from: string; to: string }[] = [];
      for (const built of result.assets) {
        const builtKey = versionKey(built.assetId, built.version);
        if (builtKeys.has(builtKey))
          throw new Error(
            `Blender artwork worker returned duplicate package ${built.assetId}@${built.version}.`,
          );
        builtKeys.add(builtKey);
        const asset = pending.find(
          (item) =>
            item.assetId === built.assetId && item.version === built.version,
        );
        if (!asset)
          throw new Error(
            `Blender worker returned unexpected asset ${built.assetId}@${built.version}.`,
          );
        const actualHash = await hashFile(built.sourcePath);
        if (actualHash !== built.sha256)
          throw new Error(
            `Generated package checksum mismatch for ${built.assetId}@${built.version}.`,
          );
        const sourceUri = join(
          'assets',
          'generated',
          encodeURIComponent(asset.assetId),
          asset.version,
          'asset.blend',
        ).replaceAll('\\', '/');
        const destination = resolve(projectDirectory, sourceUri);
        if (existsSync(destination))
          throw new Error(
            `Refusing to overwrite immutable artwork package: ${destination}`,
          );
        const sourceArtwork = asset.layers.map((layer) => ({
          assetId: layer.source.assetId,
          version: layer.source.version,
          contentHash: layer.source.contentHash,
        }));
        const sourceRestrictions = sourceArtwork.flatMap(
          (source) =>
            registryByKey.get(versionKey(source.assetId, source.version))
              ?.license.restrictions ?? [],
        );
        newRecords.push(
          AssetVersionSchema.parse({
            assetId: asset.assetId,
            version: asset.version,
            type: 'other',
            sourceUri,
            contentHash: actualHash,
            metadata: {
              generator: IMPLEMENTATION_VERSION,
              generatorFingerprint: fingerprintFor(asset),
              assetKind: built.kind,
              displayName: built.displayName,
              blenderCollection: built.collection,
              artworkLayers: sourceArtwork,
              layerCount: asset.layers.length,
              groupCount: asset.groups.length,
              variantSlots: asset.variantSlots.map((slot) => slot.id),
              anchors: asset.anchors.map((anchor) => anchor.id),
              stylePreset: specification.style.id,
              styleVersion: specification.style.version,
            },
            license: {
              name: 'Composite artwork package; source licenses apply',
              restrictions: [...new Set(sourceRestrictions)],
            },
            provenance: {
              source: `Filmie layered artwork preparation; inputs ${sourceArtwork.map((source) => `${source.assetId}@${source.version}`).join(', ')}`,
            },
          }),
        );
        promotions.push({ from: built.sourcePath, to: destination });
      }
      for (const promotion of promotions) {
        const versionDirectory = dirname(promotion.to);
        const assetDirectory = dirname(versionDirectory);
        await mkdir(assetDirectory, { recursive: true });
        try {
          await mkdir(versionDirectory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST')
            throw new Error(
              `Immutable artwork version directory already exists and will not be replaced: ${versionDirectory}`,
              { cause: error },
            );
          throw error;
        }
        try {
          await rename(promotion.from, promotion.to);
        } catch (error) {
          await rmdir(versionDirectory).catch(() => undefined);
          throw error;
        }
      }
      registryRecords.push(...newRecords);
      for (const record of newRecords)
        registryByKey.set(versionKey(record.assetId, record.version), record);
      createdAssetIds.push(...newRecords.map((asset) => asset.assetId));
    }
    if (createdAssetIds.length > 0)
      await writeJsonAtomic(registryPath, registryRecords);
    const receipt = {
      projectId: specification.projectId,
      specificationSha256,
      implementationVersion: IMPLEMENTATION_VERSION,
      blenderVersion,
      workerHash,
      status: 'success',
      createdAssetIds,
      reusedAssetIds,
      completedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(receiptPath, receipt);
    return {
      projectId: specification.projectId,
      assets: registryRecords.filter((asset) =>
        specification.assets.some(
          (specAsset) =>
            versionKey(specAsset.assetId, specAsset.version) ===
            versionKey(asset.assetId, asset.version),
        ),
      ),
      createdAssetIds,
      reusedAssetIds,
      specificationSha256,
      blenderVersion,
      receiptPath,
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
