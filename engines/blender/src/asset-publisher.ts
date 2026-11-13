import { createHash, randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import {
  AssetDescriptorSchema,
  AssetRegistry,
  AssetVersionSchema,
  type AssetVersion,
} from '@filmmaking/assets';
import {
  assetFactoryFormat,
  convertAssetToGlb,
  type AssetFactoryReport,
} from './asset-factory.js';

export interface AssetPublishReport {
  status: 'published' | 'reused' | 'rejected';
  assetId?: string;
  version?: string;
  artifactPath?: string;
  registryPath: string;
  reportPath?: string;
  sourceSha256?: string;
  conversionSha256?: string | undefined;
  diagnostics: AssetFactoryReport['errors'];
  warnings: AssetFactoryReport['warnings'];
  losses: string[];
  message?: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function diagnostic(
  code: string,
  path: string,
  message: string,
): AssetFactoryReport['errors'][number] {
  return { severity: 'error', code, path, message };
}

function relativeUri(from: string, to: string): string {
  return relative(from, to).split('\\').join('/');
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function descriptorSha256(descriptor: unknown): string {
  return sha256(new TextEncoder().encode(stableJson(descriptor)));
}

function validateInspection(report: AssetFactoryReport) {
  const inspection = report.after;
  const errors = [...report.errors];
  if (!inspection) {
    errors.push(
      diagnostic(
        'INSPECTION_MISSING',
        'after',
        'A converted asset must include a verified post-conversion inspection.',
      ),
    );
    return errors;
  }
  if (inspection.nodes.length === 0)
    errors.push(
      diagnostic(
        'GEOMETRY_MISSING',
        'after.nodes',
        'Published model assets must contain at least one node.',
      ),
    );
  if (
    inspection.meshes.length === 0 ||
    inspection.meshes.every((mesh) => mesh.primitives.length === 0)
  )
    errors.push(
      diagnostic(
        'GEOMETRY_MISSING',
        'after.meshes',
        'Published model assets must contain mesh geometry.',
      ),
    );
  const descriptor = inspection.descriptor;
  if (descriptor) {
    for (const [index, handle] of descriptor.handles.entries()) {
      if (
        descriptor.capabilities.verified.length > 0 &&
        handle.kind !== 'material' &&
        typeof handle.target === 'string'
      )
        errors.push(
          diagnostic(
            'NON_DETERMINISTIC_HANDLE_TARGET',
            `descriptor.handles[${index}].target`,
            'Published semantic handles must use a nodeIndex target instead of a runtime object name.',
          ),
        );
    }
  }
  for (const [index, node] of inspection.nodes.entries()) {
    const transform = [
      ...(node.translation ?? []),
      ...(node.rotation ?? []),
      ...(node.scale ?? []),
      ...(node.matrix ?? []),
    ];
    if (transform.some((value) => !Number.isFinite(value)))
      errors.push(
        diagnostic(
          'INVALID_TRANSFORM',
          `after.nodes[${index}]`,
          'Node transforms must contain only finite numbers.',
        ),
      );
  }
  return errors;
}

async function writeJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function publishAsset(options: {
  inputPath: string;
  descriptor: unknown;
  registryPath: string;
  artifactDirectory?: string;
  reportDirectory?: string;
  blenderPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
  license: {
    name: string;
    url?: string;
    restrictions: string[];
  };
}): Promise<AssetPublishReport> {
  const registryPath = resolve(options.registryPath);
  const registryDirectory = dirname(registryPath);
  const base = {
    registryPath,
    diagnostics: [] as AssetFactoryReport['errors'],
    warnings: [] as AssetFactoryReport['warnings'],
    losses: [] as string[],
  };
  const descriptorResult = AssetDescriptorSchema.safeParse(options.descriptor);
  if (!descriptorResult.success)
    return {
      ...base,
      status: 'rejected',
      message: `Descriptor validation failed: ${descriptorResult.error.message}`,
      diagnostics: [
        diagnostic(
          'DESCRIPTOR_INVALID',
          'descriptor',
          descriptorResult.error.message,
        ),
      ],
    };
  const descriptor = descriptorResult.data;
  if (!descriptor.assetId || !descriptor.assetVersion)
    return {
      ...base,
      status: 'rejected',
      message:
        'Descriptor must declare assetId and assetVersion for publishing.',
      diagnostics: [
        diagnostic(
          'IDENTITY_MISSING',
          'descriptor',
          'assetId and assetVersion are required for an immutable publication.',
        ),
      ],
    };
  const sourceFormat = assetFactoryFormat(options.inputPath);
  if (!sourceFormat)
    return {
      ...base,
      status: 'rejected',
      message: 'Source format is not supported by the Asset Factory.',
      diagnostics: [
        diagnostic(
          'UNSUPPORTED_SOURCE_FORMAT',
          'inputPath',
          'Expected GLB, glTF, FBX, OBJ, or .blend input.',
        ),
      ],
    };

  const artifactDirectory = resolve(
    options.artifactDirectory ?? resolve(registryDirectory, 'artifacts'),
  );
  const reportDirectory = resolve(
    options.reportDirectory ?? resolve(registryDirectory, 'reports'),
  );
  const stagingDirectory = resolve(registryDirectory, '.publishing');
  const stagingPath = resolve(
    stagingDirectory,
    `${descriptor.assetId}.${descriptor.assetVersion}.${randomUUID()}.glb`,
  );
  await mkdir(stagingDirectory, { recursive: true });
  let conversion: AssetFactoryReport;
  try {
    conversion = await convertAssetToGlb({
      inputPath: options.inputPath,
      outputPath: stagingPath,
      descriptor,
      ...(options.blenderPath === undefined
        ? {}
        : { blenderPath: options.blenderPath }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const errors = validateInspection(conversion);
    const losses = conversion.losses;
    if (losses.length)
      errors.push(
        diagnostic(
          'UNSUPPORTED_CONVERSION_LOSS',
          'conversion.losses',
          `Conversion losses are not permitted for publishing: ${losses.join(', ')}`,
        ),
      );
    if (conversion.status === 'rejected' || errors.length) {
      return {
        ...base,
        status: 'rejected',
        sourceSha256: conversion.sourceSha256,
        conversionSha256: conversion.outputSha256,
        diagnostics: errors,
        warnings: conversion.warnings,
        losses,
        message: 'Asset failed publishing validation.',
      };
    }
    const bytes = await readFile(stagingPath);
    const conversionSha256 = sha256(bytes);
    if (conversion.outputSha256 !== conversionSha256)
      return {
        ...base,
        status: 'rejected',
        sourceSha256: conversion.sourceSha256,
        conversionSha256,
        diagnostics: [
          diagnostic(
            'CONVERSION_HASH_MISMATCH',
            'conversion.outputSha256',
            'The converted artifact changed before publication.',
          ),
        ],
        warnings: conversion.warnings,
        losses,
      };
    const artifactPath = resolve(artifactDirectory, `${conversionSha256}.glb`);
    await mkdir(artifactDirectory, { recursive: true });
    const existingArtifact = await stat(artifactPath).catch(() => undefined);
    if (existingArtifact && !existingArtifact.isFile())
      return {
        ...base,
        status: 'rejected',
        sourceSha256: conversion.sourceSha256,
        conversionSha256,
        diagnostics: [
          diagnostic(
            'ARTIFACT_PATH_CONFLICT',
            'artifactPath',
            'The content-addressed artifact path is not a regular file.',
          ),
        ],
        warnings: conversion.warnings,
        losses,
      };
    if (!existingArtifact) await copyFile(stagingPath, artifactPath);

    let registryInput: unknown[] = [];
    try {
      registryInput = JSON.parse(
        await readFile(registryPath, 'utf8'),
      ) as unknown[];
      if (!Array.isArray(registryInput))
        throw new Error('Registry must be an array.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        return {
          ...base,
          status: 'rejected',
          sourceSha256: conversion.sourceSha256,
          conversionSha256,
          diagnostics: [
            diagnostic(
              'REGISTRY_INVALID',
              'registryPath',
              error instanceof Error ? error.message : String(error),
            ),
          ],
          warnings: conversion.warnings,
          losses,
        };
    }
    const registry = new AssetRegistry(registryInput);
    const resolvedHandles =
      conversion.after?.descriptorValidation?.resolvedHandles ?? [];
    const publishedDescriptor = {
      ...descriptor,
      resolvedHandles,
    };
    const descriptorHash = descriptorSha256(publishedDescriptor);
    const reference = {
      assetId: descriptor.assetId,
      version: descriptor.assetVersion,
    };
    const existing = registry
      .list()
      .find(
        (asset) =>
          asset.assetId === reference.assetId &&
          asset.version === reference.version,
      );
    if (existing) {
      if (
        existing.contentHash !== conversionSha256 ||
        existing.metadata['descriptorSha256'] !== descriptorHash
      )
        return {
          ...base,
          status: 'rejected',
          assetId: descriptor.assetId,
          version: descriptor.assetVersion,
          sourceSha256: conversion.sourceSha256,
          conversionSha256,
          diagnostics: [
            diagnostic(
              'ASSET_VERSION_CONFLICT',
              'descriptor',
              'The immutable asset version is already registered with different content or descriptor data.',
            ),
          ],
          warnings: conversion.warnings,
          losses,
        };
      return {
        ...base,
        status: 'reused',
        assetId: existing.assetId,
        version: existing.version,
        artifactPath,
        sourceSha256: conversion.sourceSha256,
        conversionSha256,
        warnings: conversion.warnings,
        losses,
        message: 'Identical asset version is already published.',
      };
    }
    const asset = AssetVersionSchema.parse({
      assetId: descriptor.assetId,
      version: descriptor.assetVersion,
      type: 'model',
      sourceUri: relativeUri(registryDirectory, artifactPath),
      contentHash: conversionSha256,
      metadata: {
        ...(options.metadata ?? {}),
        sourceFormat,
        sourceSha256: conversion.sourceSha256,
        conversionSha256,
        descriptorSha256: descriptorHash,
        semanticHandles: resolvedHandles,
        capabilities: publishedDescriptor.capabilities,
        diagnosticReport: relativeUri(
          registryDirectory,
          resolve(
            reportDirectory,
            `${descriptor.assetId}.${descriptor.assetVersion}.json`,
          ),
        ),
      },
      license: options.license,
      provenance: {
        source: descriptor.provenance.source,
        ...(descriptor.provenance.importedAt
          ? { acquiredAt: descriptor.provenance.importedAt }
          : {}),
      },
      descriptor: publishedDescriptor,
    });
    const nextRegistry = [...registry.list(), asset];
    await mkdir(registryDirectory, { recursive: true });
    const reportPath = resolve(
      reportDirectory,
      `${descriptor.assetId}.${descriptor.assetVersion}.json`,
    );
    await mkdir(reportDirectory, { recursive: true });
    await writeJsonAtomically(reportPath, {
      status: 'published',
      asset,
      conversion,
      validation: { geometry: true, transforms: true, resources: true },
    });
    await writeJsonAtomically(registryPath, nextRegistry);
    return {
      ...base,
      status: 'published',
      assetId: asset.assetId,
      version: asset.version,
      artifactPath,
      reportPath,
      sourceSha256: conversion.sourceSha256,
      conversionSha256,
      warnings: conversion.warnings,
      losses,
      message: 'Asset published successfully.',
    };
  } finally {
    await rm(stagingPath, { force: true });
  }
}
