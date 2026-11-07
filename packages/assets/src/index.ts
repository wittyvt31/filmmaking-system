import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve, win32 } from 'node:path';
import {
  compareStrings,
  AssetVersionReferenceSchema,
  StableIdSchema,
  type AssetVersionReference,
} from '@filmmaking/contracts';
import { z } from 'zod';

const sourceUriSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new URL(value);
      return true;
    } catch {
      // On POSIX, URL parsing mistakes a Windows drive letter for a URI scheme.
      // Accept native absolute paths from either platform for portable manifests.
      return (
        isAbsolute(value) ||
        win32.isAbsolute(value) ||
        !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
      );
    }
  }, 'Expected a valid absolute URI or relative URI reference');

export const AssetVersionSchema = z
  .object({
    assetId: StableIdSchema,
    version: AssetVersionReferenceSchema.shape.version,
    type: z.enum(['video', 'image', 'audio', 'font', 'graphic', 'other']),
    sourceUri: sourceUriSchema,
    contentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 hex digest'),
    metadata: z.record(z.string(), z.json()),
    license: z
      .object({
        name: z.string().min(1),
        url: z.string().url().optional(),
        restrictions: z.array(z.string().min(1)),
      })
      .strict(),
    provenance: z
      .object({
        source: z.string().min(1),
        attribution: z.string().optional(),
        acquiredAt: z.iso.datetime().optional(),
      })
      .strict(),
  })
  .strict();

export type AssetVersion = z.infer<typeof AssetVersionSchema>;
export type ResolvedAsset = AssetVersion & { localPath: string };

export type AssetRegistryErrorCode =
  | 'ASSET_VERSION_EXISTS'
  | 'ASSET_VERSION_NOT_FOUND'
  | 'ASSET_SOURCE_UNSUPPORTED'
  | 'ASSET_FILE_NOT_FOUND'
  | 'ASSET_FILE_INVALID'
  | 'ASSET_HASH_MISMATCH';

export class AssetRegistryError extends Error {
  constructor(
    readonly code: AssetRegistryErrorCode,
    message: string,
    readonly asset?: AssetVersionReference,
  ) {
    super(message);
    this.name = 'AssetRegistryError';
  }
}

function versionKey(assetId: string, version: string): string {
  return `${assetId}\u0000${version}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export class AssetRegistry {
  readonly #versions = new Map<string, AssetVersion>();

  constructor(versions: readonly unknown[] = []) {
    for (const version of versions) this.register(version);
  }

  register(input: unknown): AssetVersion {
    const version = deepFreeze(AssetVersionSchema.parse(input));
    const key = versionKey(version.assetId, version.version);
    if (this.#versions.has(key)) {
      throw new AssetRegistryError(
        'ASSET_VERSION_EXISTS',
        `Asset ${version.assetId}@${version.version} already exists and cannot be replaced`,
        { assetId: version.assetId, version: version.version },
      );
    }
    this.#versions.set(key, version);
    return version;
  }

  resolve(referenceInput: AssetVersionReference): AssetVersion {
    const reference = AssetVersionReferenceSchema.parse(referenceInput);
    const version = this.#versions.get(
      versionKey(reference.assetId, reference.version),
    );
    if (!version) {
      throw new AssetRegistryError(
        'ASSET_VERSION_NOT_FOUND',
        `Asset version ${reference.assetId}@${reference.version} is not registered`,
        reference,
      );
    }
    return version;
  }

  list(): readonly AssetVersion[] {
    return [...this.#versions.values()].sort(
      (left, right) =>
        compareStrings(left.assetId, right.assetId) ||
        compareStrings(left.version, right.version),
    );
  }
}

function localPathFor(
  sourceUri: string,
  baseDirectory: string,
  asset: AssetVersion,
): string {
  if (isAbsolute(sourceUri) || win32.isAbsolute(sourceUri)) return sourceUri;
  try {
    const url = new URL(sourceUri);
    if (url.protocol !== 'file:') {
      throw new AssetRegistryError(
        'ASSET_SOURCE_UNSUPPORTED',
        `Asset ${asset.assetId}@${asset.version} uses unsupported source scheme "${url.protocol}"`,
        { assetId: asset.assetId, version: asset.version },
      );
    }
    return fileURLToPath(url);
  } catch (error) {
    if (error instanceof AssetRegistryError) throw error;
    return resolve(baseDirectory, sourceUri);
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath))
    hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function resolveAssetFiles(
  references: readonly AssetVersionReference[],
  registry: AssetRegistry,
  baseDirectory: string,
): Promise<ResolvedAsset[]> {
  const uniqueReferences = new Map(
    references.map((reference) => [
      versionKey(reference.assetId, reference.version),
      reference,
    ]),
  );
  const resolved: ResolvedAsset[] = [];

  for (const reference of [...uniqueReferences.values()].sort(
    (left, right) =>
      compareStrings(left.assetId, right.assetId) ||
      compareStrings(left.version, right.version),
  )) {
    const asset = registry.resolve(reference);
    const localPath = localPathFor(asset.sourceUri, baseDirectory, asset);
    let fileInfo;
    try {
      fileInfo = await stat(localPath);
    } catch {
      throw new AssetRegistryError(
        'ASSET_FILE_NOT_FOUND',
        `Asset file for ${asset.assetId}@${asset.version} was not found: ${localPath}`,
        reference,
      );
    }
    if (!fileInfo.isFile()) {
      throw new AssetRegistryError(
        'ASSET_FILE_INVALID',
        `Asset source for ${asset.assetId}@${asset.version} is not a regular file: ${localPath}`,
        reference,
      );
    }
    let actualHash: string;
    try {
      actualHash = await hashFile(localPath);
    } catch {
      throw new AssetRegistryError(
        'ASSET_FILE_INVALID',
        `Asset file for ${asset.assetId}@${asset.version} could not be read: ${localPath}`,
        reference,
      );
    }
    if (actualHash !== asset.contentHash) {
      throw new AssetRegistryError(
        'ASSET_HASH_MISMATCH',
        `SHA-256 mismatch for ${asset.assetId}@${asset.version}`,
        reference,
      );
    }
    resolved.push({ ...asset, localPath });
  }

  return resolved;
}
