import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AssetRegistry } from '@filmmaking/assets';
import { parseProjectManifest } from '@filmmaking/contracts';
import { BlenderRendererAdapter } from '@filmmaking/engine-blender';
import { prepareProductionPlan } from '@filmmaking/planner';
import { afterAll, describe, expect, it } from 'vitest';

const projectDirectory = resolve('examples/they-have-reached-blender');
const cscCandidates = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v2.0.50727\\csc.exe',
];
const cscPath =
  process.env['CSC'] ??
  cscCandidates.find((candidate) => existsSync(candidate));

function compileFakeBlender(): string | null {
  if (!cscPath) return null;
  const directory = mkdtempSync(join(tmpdir(), 'filmie-fake-blender-'));
  temporaryDirectories.push(directory);
  const sourcePath = join(directory, 'fake-blender.cs');
  writeFileSync(
    sourcePath,
    readFileSync(resolve('tests/fixtures/fake-blender.cs')),
  );
  const executablePath = join(directory, 'fake-blender.exe');
  const compiled = spawnSync(
    cscPath,
    ['/nologo', `/out:${executablePath}`, sourcePath],
    { encoding: 'utf8', windowsHide: true },
  );
  if (compiled.status !== 0 || !existsSync(executablePath)) {
    return null;
  }
  return executablePath;
}

const temporaryDirectories: string[] = [];
const fakeBlenderPath = compileFakeBlender();

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(!fakeBlenderPath)('Blender crash tolerance', () => {
  it('accepts a non-zero exit when every frame validates and marks the receipt completedWithWarning', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'filmie-crash-valid-'));
    temporaryDirectories.push(temporary);
    process.env['FILMIE_FAKE_BLENDER_MODE'] = 'valid';
    process.env['FILMIE_FAKE_DURATION_FRAMES'] = '3';
    process.env['FILMIE_FAKE_WIDTH'] = '1280';
    process.env['FILMIE_FAKE_HEIGHT'] = '720';
    try {
      const { adapter, request } = await buildRequest(temporary);
      const result = await adapter.renderShot(request);
      expect(result.status).toBe('success');
      if (result.status !== 'success') throw new Error(result.error.message);
      expect(result.receipt.completedWithWarning).toBe(true);
      expect(result.receipt.metrics['exitCode']).toBe(3);
      expect(result.receipt.warnings?.join('\n')).toContain(
        'exited non-zero (code 3)',
      );
      expect(
        result.receipt.outputChecksums.filter((file) =>
          /frame_\d{6}\.png$/.test(file.path),
        ),
      ).toHaveLength(3);
    } finally {
      delete process.env['FILMIE_FAKE_BLENDER_MODE'];
      delete process.env['FILMIE_FAKE_DURATION_FRAMES'];
      delete process.env['FILMIE_FAKE_WIDTH'];
      delete process.env['FILMIE_FAKE_HEIGHT'];
    }
  }, 120_000);

  it('retries once on a fallback engine and fails clearly when frames are missing', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'filmie-crash-missing-'));
    temporaryDirectories.push(temporary);
    process.env['FILMIE_FAKE_BLENDER_MODE'] = 'missing';
    process.env['FILMIE_FAKE_DURATION_FRAMES'] = '3';
    process.env['FILMIE_FAKE_WIDTH'] = '1280';
    process.env['FILMIE_FAKE_HEIGHT'] = '720';
    try {
      const { adapter, request } = await buildRequest(temporary);
      const result = await adapter.renderShot(request);
      expect(result.status).toBe('failure');
      if (result.status !== 'failure') throw new Error('Expected failure');
      expect(result.error.code).toBe('RENDER_CRASHED');
      expect(result.receipt.logs.join('\n')).toContain('retrying once on');
      expect(result.error.message).toMatch(/no valid 3-frame sequence/);
    } finally {
      delete process.env['FILMIE_FAKE_BLENDER_MODE'];
      delete process.env['FILMIE_FAKE_DURATION_FRAMES'];
      delete process.env['FILMIE_FAKE_WIDTH'];
      delete process.env['FILMIE_FAKE_HEIGHT'];
    }
  }, 120_000);
});

async function buildRequest(temporary: string) {
  const rawManifest = JSON.parse(
    await readFile(join(projectDirectory, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  const shots = rawManifest['shots'] as Record<string, unknown>[];
  const shot = shots[0];
  const shotScene = shot?.['scene'] as Record<string, unknown>;
  const camera = shotScene['camera'] as Record<string, unknown>;
  shot!['durationFrames'] = 3;
  camera['durationFrames'] = 3;
  const timeline = rawManifest['timeline'] as Record<string, unknown>;
  timeline['durationFrames'] = 3;

  const registryJson = JSON.parse(
    await readFile(join(projectDirectory, 'assets.json'), 'utf8'),
  ) as unknown[];
  const manifest = parseProjectManifest(rawManifest);
  const prepared = await prepareProductionPlan(
    manifest,
    new AssetRegistry(registryJson),
    projectDirectory,
  );
  const selectedShot = prepared.manifest.shots[0];
  if (!selectedShot) throw new Error('Missing crash-tolerance shot.');
  const adapter = new BlenderRendererAdapter({
    executablePath: fakeBlenderPath ?? undefined,
  });
  const request = {
    jobId: 'test:fake-blender',
    shot: selectedShot,
    scene: prepared.compiledScenes[selectedShot.id],
    assets: prepared.assets.map((asset) => ({
      assetId: asset.assetId,
      version: asset.version,
      type: asset.type,
      sourceUri: asset.sourceUri,
      localPath: asset.localPath,
      contentHash: asset.contentHash,
      metadata: asset.metadata,
    })),
    settings: prepared.manifest.renderPolicy,
    artifact: {
      type: 'image-sequence/png' as const,
      outputDirectory: join(temporary, 'shot-output'),
    },
    randomSeed: 0,
    cacheDirectory: join(temporary, 'cache'),
    receiptPath: join(temporary, 'render.receipt.json'),
    timeoutMs: 60_000,
  };
  return { adapter, request };
}
