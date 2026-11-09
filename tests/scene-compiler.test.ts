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
  it('compiles prepared cutout actions and time-addressed facial variants', async () => {
    const manifest = parseProjectManifest(
      JSON.parse(
        await readFile(
          resolve('examples/artwork-preparation-proof/manifest.json'),
          'utf8',
        ),
      ) as unknown,
    );
    const shot = manifest.shots[0];
    if (!shot) throw new Error('Missing animated cutout proof shot.');
    const compiled = compileScene(shot, manifest.video.frameRate);
    expect(compiled.actions.map(({ action }) => action.type)).toContain(
      'facial-variant',
    );
    expect(compiled.actions.map(({ action }) => action.id)).toContain(
      'father.lifts',
    );
    expect(compiled.durationFrames).toBe(150);
  });

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

  it('resolves registered charcoal versions and rejects unknown style identifiers', async () => {
    const input = await proofManifest();
    const shots = input['shots'] as Record<string, unknown>[];
    const scene = shots[0]?.['scene'] as Record<string, unknown>;
    scene['styleVersion'] = '2.0.0';
    const parsed = parseProjectManifest(input);
    expect(
      compileScene(parsed.shots[0]!, parsed.video.frameRate).style,
    ).toMatchObject({
      id: 'charcoal_horror',
      version: '2.0.0',
      edgeBreakup: 0.24,
      shadowSmudge: 0.18,
      paperWhitePoint: 0.78,
    });
    scene['stylePreset'] = 'unregistered_style';
    expect(() =>
      compileScene(
        parseProjectManifest(input).shots[0]!,
        parsed.video.frameRate,
      ),
    ).toThrow(/Unknown style/);
    scene['stylePreset'] = 'charcoal_horror';
    scene['styleOverrides'] = { unexpected: true };
    expect(() => parseProjectManifest(input)).toThrow(/unexpected/i);
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

  it('compiles pan and optical zoom as deterministic camera paths', async () => {
    const input = await proofManifest();
    const shots = input['shots'] as Record<string, unknown>[];
    const shotInput = shots[0];
    if (!shotInput) throw new Error('Missing camera proof shot.');
    const scene = shotInput['scene'] as Record<string, unknown>;
    scene['camera'] = {
      type: 'pan',
      startFrame: 0,
      durationFrames: 150,
      distance: 6,
      fromTarget: { x: -0.5, y: 0, z: 0 },
      toTarget: { x: 0.75, y: 0, z: 0.2 },
    };
    const panManifest = parseProjectManifest(input);
    const shot = panManifest.shots[0];
    if (!shot) throw new Error('Missing parsed camera proof shot.');
    const pan = compileScene(shot, panManifest.video.frameRate);
    expect(pan.cameraKeyframes.map((keyframe) => keyframe.target)).toEqual([
      { x: -0.5, y: 0, z: 0 },
      { x: 0.75, y: 0, z: 0.2 },
    ]);

    scene['camera'] = {
      type: 'zoom',
      startFrame: 0,
      durationFrames: 150,
      distance: 6,
      target: { x: 0, y: 0, z: 0 },
      fromFocalLength: 35,
      toFocalLength: 60,
    };
    const zoomManifest = parseProjectManifest(input);
    const zoomShot = zoomManifest.shots[0];
    if (!zoomShot) throw new Error('Missing parsed zoom proof shot.');
    expect(
      compileScene(zoomShot, zoomManifest.video.frameRate).cameraKeyframes.map(
        (keyframe) => keyframe.focalLength,
      ),
    ).toEqual([35, 60]);
  });

  it('validates artwork parents, pivots, opacity, and deterministic draw order', async () => {
    const input = await proofManifest();
    const shots = input['shots'] as Record<string, unknown>[];
    const shotInput = shots[0];
    if (!shotInput) throw new Error('Missing artwork proof shot.');
    const scene = shotInput['scene'] as Record<string, unknown>;
    scene['groups'] = [
      {
        id: 'group.character',
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotationDegrees: { x: 0, y: 0, z: 0 },
          scale: 1,
        },
      },
    ];
    scene['layers'] = [
      {
        id: 'layer.character',
        asset: { assetId: 'background.interior-wide', version: '1.0.0' },
        role: 'character',
        parentId: 'group.character',
        transform: {
          position: { x: 0.4, y: -0.5, z: 0.3 },
          rotationDegrees: { x: 0, y: 0, z: 0 },
          scale: 1,
        },
        pivot: { x: 0.5, y: 0.12 },
        opacity: 0.8,
        order: 10,
      },
    ];
    const parsed = parseProjectManifest(input);
    const shot = parsed.shots[0];
    if (!shot) throw new Error('Missing parsed artwork proof shot.');
    const compiled = compileScene(shot, parsed.video.frameRate);
    expect(compiled.groups.map((group) => group.id)).toEqual([
      'group.character',
    ]);
    expect(compiled.layers[0]).toMatchObject({
      id: 'layer.character',
      parentId: 'group.character',
      pivot: { x: 0.5, y: 0.12 },
      opacity: 0.8,
      order: 10,
    });

    scene['groups'] = [
      {
        id: 'group.character',
        parentId: 'layer.character',
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotationDegrees: { x: 0, y: 0, z: 0 },
          scale: 1,
        },
      },
    ];
    expect(() => parseProjectManifest(input)).toThrow(/cycle/i);
  });
});
