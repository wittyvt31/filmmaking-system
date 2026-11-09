import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AssetRegistry } from '@filmmaking/assets';
import { parseProjectManifest } from '@filmmaking/contracts';
import { BlenderRendererAdapter } from '@filmmaking/engine-blender';
import { prepareProductionPlan } from '@filmmaking/planner';
import { afterAll, describe, expect, it } from 'vitest';

const projectDirectory = resolve('examples/they-have-reached-blender');
const expectedBlenderPath = join(
  process.env['PROGRAMFILES'] ?? 'C:\\Program Files',
  'Blender Foundation',
  'Blender 5.2',
  'blender.exe',
);
const blenderAvailable = existsSync(
  process.env['FILMIE_BLENDER'] ?? expectedBlenderPath,
);
const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Blender EEVEE renderer adapter', () => {
  it('rejects unsafe worker counts', () => {
    expect(() => new BlenderRendererAdapter({ workers: 0 })).toThrow(
      /worker count/,
    );
    expect(() => new BlenderRendererAdapter({ workers: 1.5 })).toThrow(
      /worker count/,
    );
  });

  it.skipIf(!blenderAvailable)(
    'renders a numbered PNG sequence, saves the scene, and reuses its shot cache',
    async () => {
      const temporary = await mkdtemp(
        join(tmpdir(), 'filmie-blender-adapter-'),
      );
      temporaryDirectories.push(temporary);
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
      expect(selectedShot).toBeDefined();
      const adapter = new BlenderRendererAdapter();
      const outputDirectory = join(temporary, 'shot-output');
      const request = {
        jobId: 'test:blender-shot',
        shot: selectedShot!,
        scene: prepared.compiledScenes[selectedShot!.id],
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
        artifact: { type: 'image-sequence/png' as const, outputDirectory },
        randomSeed: 0,
        cacheDirectory: join(temporary, 'cache'),
        receiptPath: join(temporary, 'render.receipt.json'),
        timeoutMs: 180_000,
      };

      const first = await adapter.renderShot(request);
      expect(first.status).toBe('success');
      if (first.status !== 'success') throw new Error(first.error.message);
      expect(first.cacheHit).toBe(false);
      expect(
        first.receipt.outputChecksums.filter((file) =>
          /frame_\d{6}\.png$/.test(file.path),
        ),
      ).toHaveLength(3);
      expect(existsSync(join(outputDirectory, 'scene.blend'))).toBe(true);

      const inspected = await adapter.inspectArtifact({
        artifactType: 'image-sequence/png',
        path: outputDirectory,
        expectedFrameCount: 3,
        expectedWidth: 1280,
        expectedHeight: 720,
      });
      expect(inspected.status).toBe('success');

      const second = await adapter.renderShot(request);
      expect(second.status).toBe('success');
      if (second.status !== 'success') throw new Error(second.error.message);
      expect(second.cacheHit).toBe(true);
      expect(second.receipt.fingerprint).toBe(first.receipt.fingerprint);

      const flatSettings = {
        ...prepared.manifest.renderPolicy,
        qualityProfile: 'flat' as const,
      };
      const flatBase = { ...request, settings: flatSettings };
      const single = await new BlenderRendererAdapter({
        workers: 1,
      }).renderShot({
        ...flatBase,
        artifact: {
          type: 'image-sequence/png',
          outputDirectory: join(temporary, 'flat-single'),
        },
        cacheDirectory: join(temporary, 'flat-cache-single'),
        receiptPath: join(temporary, 'flat-single.receipt.json'),
      });
      const parallel = await new BlenderRendererAdapter({
        workers: 2,
      }).renderShot({
        ...flatBase,
        artifact: {
          type: 'image-sequence/png',
          outputDirectory: join(temporary, 'flat-parallel'),
        },
        cacheDirectory: join(temporary, 'flat-cache-parallel'),
        receiptPath: join(temporary, 'flat-parallel.receipt.json'),
      });
      expect(single.status).toBe('success');
      expect(parallel.status).toBe('success');
      if (single.status !== 'success' || parallel.status !== 'success')
        throw new Error('Single or parallel flat render failed');
      expect(
        single.receipt.outputChecksums
          .filter((item) => /frame_\d{6}\.png$/.test(item.path))
          .map((item) => item.sha256),
      ).toEqual(
        parallel.receipt.outputChecksums
          .filter((item) => /frame_\d{6}\.png$/.test(item.path))
          .map((item) => item.sha256),
      );
    },
    240_000,
  );
});
