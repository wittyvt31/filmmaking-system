import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AssetRegistry } from '@filmmaking/assets';
import { prepareProductionPlan } from '@filmmaking/planner';
import { describe, expect, it } from 'vitest';

describe('versioned semantic motion-library planning', () => {
  it('resolves a motion library asset and compiles its curves before rendering', async () => {
    const projectDirectory = resolve('examples/3d-production');
    const temporary = await mkdtemp(join(tmpdir(), 'filmie-motion-library-'));
    try {
      const manifest = JSON.parse(
        await readFile(join(projectDirectory, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      const shots = manifest['shots'] as Record<string, unknown>[];
      const shot = shots[0];
      if (!shot) throw new Error('Missing fixture shot.');
      const scene = shot['scene'] as Record<string, unknown>;
      const reference = { assetId: 'motion.father', version: '1.0.0' };
      scene['motionLibraries'] = [reference];
      const characters = scene['characters'] as Record<string, unknown>[];
      const character = characters[0];
      if (!character) throw new Error('Missing fixture character.');
      (character['actions'] as Record<string, unknown>[]).push({
        id: 'authored-look-down',
        type: 'motion-clip',
        startFrame: 0,
        endFrame: 30,
        library: reference,
        clipId: 'look-down',
        playbackRate: 1,
        blendMode: 'replace',
      });
      (shot['requiredAssets'] as Record<string, unknown>[]).push(reference);
      const library = {
        schemaVersion: '1.0.0',
        libraryId: reference.assetId,
        version: reference.version,
        clips: [
          {
            id: 'look-down',
            durationFrames: 30,
            tracks: [
              {
                control: 'head',
                channel: 'rotation',
                keyframes: [
                  { frame: 0, value: [0, 0, 0] },
                  { frame: 15, value: [0.12, 0, 0] },
                  { frame: 30, value: [0, 0, 0] },
                ],
              },
            ],
          },
        ],
      };
      const libraryPath = join(temporary, 'motions.json');
      const serialized = `${JSON.stringify(library)}\n`;
      await writeFile(libraryPath, serialized);
      const contentHash = createHash('sha256').update(serialized).digest('hex');
      const records = JSON.parse(
        await readFile(join(projectDirectory, 'assets.json'), 'utf8'),
      ) as unknown[];
      records.push({
        assetId: reference.assetId,
        version: reference.version,
        type: 'other',
        sourceUri: pathToFileURL(libraryPath).href,
        contentHash,
        metadata: { kind: 'motion-library' },
        license: { name: 'Local prepared motion library', restrictions: [] },
        provenance: { source: 'test fixture' },
      });
      const plan = await prepareProductionPlan(
        manifest,
        new AssetRegistry(records),
        projectDirectory,
      );
      expect(
        plan.compiledScenes[shot['id'] as string]?.motionCurves,
      ).toHaveLength(3);
      expect(
        plan.assets.some((asset) => asset.assetId === reference.assetId),
      ).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
