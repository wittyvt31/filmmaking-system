import { createReadStream } from 'node:fs';
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import {
  compareStrings,
  type RenderArtifactType,
  type RenderOutputChecksum,
} from '@filmmaking/contracts';

interface CacheFileRecord {
  relativePath: string;
  sha256: string;
  bytes: number;
}

interface CacheMetadata {
  version: 1;
  fingerprint: string;
  artifactType: RenderArtifactType;
  isDirectory: boolean;
  payloadName: string;
  files: CacheFileRecord[];
}

export interface CachedArtifact {
  path: string;
  outputPaths: string[];
  outputChecksums: RenderOutputChecksum[];
}

async function hashFile(
  filePath: string,
): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), bytes };
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) =>
    compareStrings(left.name, right.name),
  )) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Cache artifacts cannot contain symbolic links: ${path}`);
    if (entry.isDirectory()) paths.push(...(await listFiles(root, path)));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Unsupported cache artifact entry: ${path}`);
  }
  return paths;
}

async function checksumArtifact(
  path: string,
  isDirectory: boolean,
): Promise<CacheFileRecord[]> {
  const files = isDirectory ? await listFiles(path) : [path];
  if (files.length === 0) throw new Error('Cannot cache an empty artifact');
  const records: CacheFileRecord[] = [];
  for (const file of files) {
    const result = await hashFile(file);
    records.push({
      relativePath: isDirectory
        ? relative(path, file).replaceAll('\\', '/')
        : '',
      sha256: result.sha256,
      bytes: result.bytes,
    });
  }
  return records;
}

function isMetadata(value: unknown): value is CacheMetadata {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CacheMetadata>;
  return (
    candidate.version === 1 &&
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.artifactType === 'string' &&
    typeof candidate.isDirectory === 'boolean' &&
    typeof candidate.payloadName === 'string' &&
    Array.isArray(candidate.files) &&
    candidate.files.every((file) => {
      if (
        typeof file.relativePath !== 'string' ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0
      )
        return false;
      if (file.relativePath === '') return !candidate.isDirectory;
      const segments = file.relativePath.split(/[\\/]/);
      return (
        candidate.isDirectory &&
        !isAbsolute(file.relativePath) &&
        !/^[A-Za-z]:/.test(file.relativePath) &&
        segments.every(
          (segment) => segment !== '' && segment !== '.' && segment !== '..',
        )
      );
    }) &&
    basename(candidate.payloadName) === candidate.payloadName &&
    !candidate.payloadName.includes('/') &&
    !candidate.payloadName.includes('\\') &&
    (candidate.isDirectory
      ? candidate.payloadName === 'payload'
      : candidate.payloadName.startsWith('payload.') ||
        candidate.payloadName === 'payload')
  );
}

async function validEntry(
  entry: string,
  fingerprint: string,
  artifactType: RenderArtifactType,
): Promise<boolean> {
  try {
    const entryInfo = await lstat(entry);
    if (!entryInfo.isDirectory() || entryInfo.isSymbolicLink()) return false;
    const parsed: unknown = JSON.parse(
      await readFile(join(entry, 'metadata.json'), 'utf8'),
    );
    if (
      !isMetadata(parsed) ||
      parsed.fingerprint !== fingerprint ||
      parsed.artifactType !== artifactType
    )
      return false;
    const payload = join(entry, parsed.payloadName);
    const payloadInfo = await lstat(payload);
    if (payloadInfo.isSymbolicLink()) return false;
    const actual = await checksumArtifact(payload, parsed.isDirectory);
    return JSON.stringify(actual) === JSON.stringify(parsed.files);
  } catch {
    return false;
  }
}

export class ArtifactCache {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  private entryPath(fingerprint: string): string {
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new TypeError(
        'Cache fingerprints must be lowercase SHA-256 hex digests',
      );
    }
    return join(this.directory, fingerprint);
  }

  async restore(
    fingerprint: string,
    artifactType: RenderArtifactType,
    outputPath: string,
  ): Promise<CachedArtifact | null> {
    const entry = this.entryPath(fingerprint);
    let metadata: CacheMetadata;
    try {
      const entryInfo = await lstat(entry);
      if (!entryInfo.isDirectory() || entryInfo.isSymbolicLink()) return null;
      const parsed: unknown = JSON.parse(
        await readFile(join(entry, 'metadata.json'), 'utf8'),
      );
      if (!isMetadata(parsed)) return null;
      metadata = parsed;
    } catch {
      return null;
    }
    if (
      metadata.fingerprint !== fingerprint ||
      metadata.artifactType !== artifactType
    )
      return null;
    const payload = join(entry, metadata.payloadName);
    let actual: CacheFileRecord[];
    try {
      const payloadInfo = await lstat(payload);
      if (payloadInfo.isSymbolicLink()) return null;
      actual = await checksumArtifact(payload, metadata.isDirectory);
    } catch {
      return null;
    }
    if (JSON.stringify(actual) !== JSON.stringify(metadata.files)) return null;

    const destination = resolve(outputPath);
    const isDirectory = metadata.isDirectory;
    try {
      const info = await stat(destination);
      if (
        (isDirectory && info.isDirectory()) ||
        (!isDirectory && info.isFile())
      ) {
        const current = await checksumArtifact(destination, isDirectory);
        if (JSON.stringify(current) === JSON.stringify(metadata.files)) {
          return this.toCachedArtifact(destination, metadata);
        }
      }
    } catch {
      // A missing destination is the common cache restore path.
    }

    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.cache-${randomUUID()}${isDirectory ? '' : extname(destination)}`;
    try {
      await cp(payload, temporary, {
        recursive: isDirectory,
        force: false,
        errorOnExist: true,
      });
      try {
        await rename(temporary, destination);
      } catch (error) {
        const backup = `${destination}.previous-${randomUUID()}`;
        try {
          await rename(destination, backup);
        } catch {
          throw error;
        }
        try {
          await rename(temporary, destination);
        } catch (promotionError) {
          await rename(backup, destination);
          throw promotionError;
        }
        await rm(backup, { recursive: true, force: true });
      }
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
    return this.toCachedArtifact(destination, metadata);
  }

  async store(
    fingerprint: string,
    artifactType: RenderArtifactType,
    sourcePath: string,
  ): Promise<CachedArtifact> {
    const entry = this.entryPath(fingerprint);
    const source = resolve(sourcePath);
    const sourceInfo = await lstat(source);
    if (!sourceInfo.isFile() && !sourceInfo.isDirectory()) {
      throw new Error(`Artifact is not a file or directory: ${source}`);
    }
    const isDirectory = sourceInfo.isDirectory();
    const files = await checksumArtifact(source, isDirectory);
    const payloadName = isDirectory ? 'payload' : `payload${extname(source)}`;
    await mkdir(this.directory, { recursive: true });
    const staging = join(
      this.directory,
      `.stage-${fingerprint}-${randomUUID()}`,
    );
    await mkdir(staging, { recursive: true });
    try {
      await cp(source, join(staging, payloadName), {
        recursive: isDirectory,
        force: false,
        errorOnExist: true,
      });
      const metadata: CacheMetadata = {
        version: 1,
        fingerprint,
        artifactType,
        isDirectory,
        payloadName,
        files,
      };
      await writeFile(
        join(staging, 'metadata.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
        {
          flag: 'wx',
        },
      );
      try {
        await rename(staging, entry);
      } catch (error) {
        if (await validEntry(entry, fingerprint, artifactType)) {
          await rm(staging, { recursive: true, force: true });
        } else {
          // Cache entries are disposable. Replace a corrupt collision so the
          // same fingerprint can recover instead of rerendering forever.
          try {
            await rm(entry, { recursive: true, force: true });
            await rename(staging, entry);
          } catch {
            throw error;
          }
        }
      }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw error;
    }
    return this.toCachedArtifact(source, {
      version: 1,
      fingerprint,
      artifactType,
      isDirectory,
      payloadName,
      files,
    });
  }

  private toCachedArtifact(
    path: string,
    metadata: CacheMetadata,
  ): CachedArtifact {
    const outputPaths = metadata.isDirectory
      ? metadata.files.map((file) => join(path, file.relativePath))
      : [path];
    return {
      path,
      outputPaths,
      outputChecksums: metadata.files.map((file, index) => ({
        path: outputPaths[index] ?? path,
        sha256: file.sha256,
        bytes: file.bytes,
      })),
    };
  }
}
