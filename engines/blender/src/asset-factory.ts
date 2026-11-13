import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeGlbFile,
  type GlbAssetInspection,
  type GlbDiagnostic,
  type GlbNormalizationReport,
} from '@filmmaking/assets';
import { defaultBlenderExecutable, runBlenderProcess } from './index.js';

const WORKER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'worker',
  'asset_factory.py',
);
const supportedExtensions = new Set([
  '.glb',
  '.gltf',
  '.fbx',
  '.obj',
  '.blend',
]);

export interface AssetFactoryReport {
  status: 'converted' | 'rejected';
  inputPath: string;
  outputPath: string;
  sourceFormat: string;
  sourceSha256: string;
  outputSha256?: string | undefined;
  detectedContents?: Record<string, unknown> | undefined;
  before?: GlbAssetInspection | undefined;
  after?: GlbAssetInspection | undefined;
  actions: string[];
  warnings: GlbDiagnostic[];
  errors: GlbDiagnostic[];
  losses: string[];
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function errorDiagnostic(
  code: string,
  path: string,
  message: string,
): GlbDiagnostic {
  return { severity: 'error', code, path, message };
}

function warningDiagnostic(
  code: string,
  path: string,
  message: string,
): GlbDiagnostic {
  return { severity: 'warning', code, path, message };
}

function parseMarker(stdout: string): Record<string, unknown> | undefined {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith('FILMIE_ASSET_FACTORY='));
  if (!line) return undefined;
  try {
    return JSON.parse(line.slice('FILMIE_ASSET_FACTORY='.length)) as Record<
      string,
      unknown
    >;
  } catch {
    return undefined;
  }
}

function parseErrorMarker(stdout: string): string | undefined {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith('FILMIE_ASSET_FACTORY_ERROR='));
  if (!line) return undefined;
  try {
    const value = JSON.parse(
      line.slice('FILMIE_ASSET_FACTORY_ERROR='.length),
    ) as { message?: unknown };
    return typeof value.message === 'string' ? value.message : undefined;
  } catch {
    return undefined;
  }
}

export function assetFactoryFormat(path: string): string | undefined {
  const extension = extname(path).toLowerCase();
  return supportedExtensions.has(extension) ? extension.slice(1) : undefined;
}

export async function convertAssetToGlb(options: {
  inputPath: string;
  outputPath: string;
  descriptor?: unknown;
  blenderPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AssetFactoryReport> {
  const inputPath = resolve(options.inputPath);
  const outputPath = resolve(options.outputPath);
  const sourceFormat = assetFactoryFormat(inputPath);
  const source = await readFile(inputPath);
  const base = {
    inputPath,
    outputPath,
    sourceFormat: sourceFormat ?? extname(inputPath).toLowerCase(),
    sourceSha256: hash(source),
    actions: [] as string[],
    warnings: [] as GlbDiagnostic[],
    errors: [] as GlbDiagnostic[],
    losses: [] as string[],
  };
  if (!sourceFormat)
    return {
      ...base,
      status: 'rejected',
      errors: [
        errorDiagnostic(
          'UNSUPPORTED_SOURCE_FORMAT',
          'inputPath',
          'Expected GLB, glTF, FBX, OBJ, or .blend input.',
        ),
      ],
    };
  if (inputPath === outputPath)
    return {
      ...base,
      status: 'rejected',
      errors: [
        errorDiagnostic(
          'INPUT_OUTPUT_SAME_PATH',
          'outputPath',
          'Input and output paths must be different.',
        ),
      ],
    };
  if (sourceFormat === 'glb') {
    const normalized = await normalizeGlbFile(
      inputPath,
      outputPath,
      options.descriptor,
    );
    return {
      ...base,
      status: normalized.status === 'normalized' ? 'converted' : 'rejected',
      outputSha256: normalized.outputSha256,
      before: normalized.before,
      after: normalized.after,
      actions: normalized.actions,
      warnings: normalized.warnings,
      errors: normalized.diagnostics.filter(
        (item) => item.severity === 'error',
      ),
      losses: [],
    };
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${randomUUID()}.partial`;
  const specDirectory = `${temporary}.work`;
  const specPath = resolve(specDirectory, 'spec.json');
  try {
    await mkdir(specDirectory, { recursive: true });
    await writeFile(
      specPath,
      JSON.stringify({ sourcePath: inputPath, outputPath: temporary }),
      { flag: 'wx' },
    );
    const process = await runBlenderProcess(
      options.blenderPath ?? defaultBlenderExecutable(),
      [
        '--background',
        '--factory-startup',
        '--python-exit-code',
        '1',
        '--python',
        WORKER_PATH,
        '--',
        specPath,
      ],
      {
        ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const marker = parseMarker(process.stdout);
    const contents =
      marker?.['contents'] && typeof marker['contents'] === 'object'
        ? (marker['contents'] as Record<string, unknown>)
        : undefined;
    const losses = Array.isArray(contents?.['losses'])
      ? contents['losses'].filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    const workerWarnings = Array.isArray(contents?.['warnings'])
      ? contents['warnings'].filter(
          (value): value is string => typeof value === 'string',
        )
      : [];
    base.losses.push(...losses);
    base.warnings.push(
      ...workerWarnings.map((message) =>
        warningDiagnostic('CONVERSION_LOSS', 'conversion', message),
      ),
    );
    if (process.code !== 0 || !existsSync(temporary)) {
      base.errors.push(
        errorDiagnostic(
          'BLENDER_CONVERSION_FAILED',
          'conversion',
          parseErrorMarker(process.stdout) ??
            (process.stderr.trim() ||
              `Blender exited with code ${process.code ?? 'unknown'}.`),
        ),
      );
      return { ...base, status: 'rejected', detectedContents: contents };
    }
    const normalized: GlbNormalizationReport = await normalizeGlbFile(
      temporary,
      outputPath,
      options.descriptor,
    );
    base.actions.push('imported-with-blender', ...normalized.actions);
    base.warnings.push(...normalized.warnings);
    base.errors.push(
      ...normalized.diagnostics.filter((item) => item.severity === 'error'),
    );
    return {
      ...base,
      status: normalized.status === 'normalized' ? 'converted' : 'rejected',
      outputSha256: normalized.outputSha256,
      detectedContents: contents,
      before: normalized.before,
      after: normalized.after,
    };
  } finally {
    await rm(temporary, { force: true });
    await rm(specDirectory, { recursive: true, force: true });
  }
}
