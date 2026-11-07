import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseProjectManifest } from '@filmmaking/contracts';
import { compileScene } from '@filmmaking/scene';
import { describe, expect, it } from 'vitest';

async function proofManifest(): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(
      resolve('examples/they-have-reached-blender/manifest.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
}

describe('renderer-independent scene compiler', () => {
  it('produces identical frame instructions and hashes for an unchanged scene', async () => {
    const manifest = parseProjectManifest(await proofManifest());
    const shot = manifest.shots[0];
    expect(shot).toBeDefined();
    const first = compileScene(shot!, manifest.video.frameRate);
    const second = compileScene(shot!, manifest.video.frameRate);

    expect(first).toEqual(second);
    expect(first.durationFrames).toBe(150);
    expect(first.camera.startFrame).toBe(0);
    expect(first.camera.durationFrames).toBe(150);
    expect(first.style.id).toBe('charcoal_horror');
  });

  it('rejects a push-in whose endpoint is not closer than its start', async () => {
    const manifest = await proofManifest();
    const shots = manifest['shots'] as Record<string, unknown>[];
    const firstShot = shots[0];
    const scene = firstShot?.['scene'] as Record<string, unknown>;
    const camera = scene['camera'] as Record<string, unknown>;
    camera['toDistance'] = camera['fromDistance'];

    expect(() => parseProjectManifest(manifest)).toThrow(/push-in/i);
  });
});
