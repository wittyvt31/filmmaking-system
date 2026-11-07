import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  AssetBuildSpecificationSchema,
  CharacterActionSchema,
  MotionClipLibrarySchema,
  parseProjectManifest,
} from '@filmmaking/contracts';
import { compileScene } from '@filmmaking/scene';
import { describe, expect, it } from 'vitest';

describe('procedural pre-production contracts', () => {
  it('accepts the complete They Have Reached procedural asset specification', async () => {
    const input = JSON.parse(
      await readFile(
        resolve('examples/they-have-reached-procedural/asset-spec.json'),
        'utf8',
      ),
    ) as unknown;
    const specification = AssetBuildSpecificationSchema.parse(input);
    expect(specification.assets.map((asset) => asset.kind)).toEqual([
      'character',
      'environment',
      'furniture',
      'furniture',
      'prop',
      'prop',
    ]);
  });

  it('rejects duplicate stable IDs and unsupported procedural categories', async () => {
    const input = JSON.parse(
      await readFile(
        resolve('examples/they-have-reached-procedural/asset-spec.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const assets = input['assets'] as Record<string, unknown>[];
    assets[1] = { ...assets[1], assetId: assets[0]?.['assetId'] };
    expect(() => AssetBuildSpecificationSchema.parse(input)).toThrow(
      /Duplicate procedural asset ID/,
    );
    const unsupported = structuredClone(input) as Record<string, unknown>;
    const unsupportedAssets = unsupported['assets'] as Record<
      string,
      unknown
    >[];
    unsupportedAssets[0] = { ...unsupportedAssets[0], kind: 'building' };
    expect(() => AssetBuildSpecificationSchema.parse(unsupported)).toThrow();
  });

  it('accepts reusable custom prop geometry and rejects empty custom props', async () => {
    const input = JSON.parse(
      await readFile(
        resolve('examples/they-have-reached-procedural/asset-spec.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const assets = input['assets'] as Record<string, unknown>[];
    assets.push({
      assetId: 'prop.custom-cup',
      version: '1.0.0',
      kind: 'prop',
      displayName: 'Handmade cup',
      propType: 'custom',
      scale: 1,
      geometry: [
        {
          id: 'body',
          type: 'cylinder',
          position: { x: 0, y: 0, z: 0.08 },
          rotationDegrees: { x: 0, y: 0, z: 0 },
          materialTone: '#777777',
          radius: 0.06,
          depth: 0.16,
          vertices: 20,
        },
        {
          id: 'handle',
          type: 'stroke',
          position: { x: 0, y: 0, z: 0 },
          rotationDegrees: { x: 0, y: 0, z: 0 },
          materialTone: '#555555',
          points: [
            [0.05, 0, 0.13],
            [0.1, 0, 0.11],
            [0.1, 0, 0.04],
            [0.05, 0, 0.03],
          ],
          width: 0.008,
        },
      ],
      anchors: [{ id: 'grip', position: { x: 0.08, y: 0, z: 0.08 } }],
    });
    const parsed = AssetBuildSpecificationSchema.parse(input);
    expect(parsed.assets.at(-1)?.kind).toBe('prop');
    assets[assets.length - 1] = { ...assets[assets.length - 1], geometry: [] };
    expect(() => AssetBuildSpecificationSchema.parse(input)).toThrow(
      /Custom props require/,
    );
  });

  it('compiles the prepared action instructions into a pinned style scene', async () => {
    const input = JSON.parse(
      await readFile(
        resolve('examples/they-have-reached-procedural/manifest.json'),
        'utf8',
      ),
    ) as unknown;
    const manifest = parseProjectManifest(input);
    const shot = manifest.shots[0];
    if (!shot) throw new Error('Proof project is missing its shot.');
    const scene = compileScene(shot, manifest.video.frameRate);
    expect(scene.style.version).toBe('1.1.0');
    expect(scene.actions.map(({ action }) => action.type)).toEqual([
      'breathing',
      'head-turn',
    ]);
    expect(scene.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('validates semantic actions and resolves versioned art direction overrides', async () => {
    const actions = [
      {
        id: 'breathe',
        type: 'breathing',
        startFrame: 0,
        endFrame: 30,
        cycleFrames: 24,
        amplitude: 0.02,
      },
      {
        id: 'blink',
        type: 'blink',
        startFrame: 0,
        endFrame: 30,
        intervalFrames: 18,
        closureFrames: 4,
      },
      {
        id: 'look',
        type: 'head-turn',
        startFrame: 0,
        endFrame: 30,
        targetEntityId: 'phone',
        maxYawDegrees: 45,
      },
      {
        id: 'face',
        type: 'expression',
        startFrame: 0,
        endFrame: 30,
        expressionId: 'worried',
      },
      {
        id: 'speech-mouth',
        type: 'lip-sync',
        startFrame: 0,
        endFrame: 30,
        visemes: [
          { startFrame: 0, endFrame: 10, shape: 'closed' },
          { startFrame: 10, endFrame: 20, shape: 'open' },
          { startFrame: 20, endFrame: 30, shape: 'round' },
        ],
      },
      {
        id: 'walk',
        type: 'walk',
        startFrame: 0,
        endFrame: 30,
        cycleFrames: 20,
        strideMeters: 0.3,
        distanceMeters: 1.5,
      },
      { id: 'sit', type: 'sit', startFrame: 0, endFrame: 20, blendFrames: 12 },
      {
        id: 'stand',
        type: 'stand',
        startFrame: 20,
        endFrame: 30,
        blendFrames: 10,
      },
      {
        id: 'reach',
        type: 'reach',
        startFrame: 0,
        endFrame: 10,
        effector: 'right-hand',
        targetEntityId: 'phone',
        targetAnchorId: 'receiver',
        handPose: 'open',
      },
      {
        id: 'grasp',
        type: 'grasp',
        startFrame: 10,
        endFrame: 15,
        effector: 'right-hand',
        targetEntityId: 'phone',
        targetAnchorId: 'receiver',
      },
      {
        id: 'lift',
        type: 'lift',
        startFrame: 15,
        endFrame: 25,
        effector: 'right-hand',
        targetEntityId: 'phone',
        targetAnchorId: 'receiver',
        verticalOffset: 0.2,
      },
      {
        id: 'place',
        type: 'place',
        startFrame: 25,
        endFrame: 30,
        effector: 'right-hand',
        targetEntityId: 'phone',
        targetAnchorId: 'receiver',
        targetPosition: { x: 0, y: 0, z: 0 },
      },
      {
        id: 'interaction',
        type: 'interaction',
        startFrame: 0,
        endFrame: 10,
        interactionId: 'look-at',
        targetEntityId: 'phone',
        maxYawDegrees: 45,
      },
      {
        id: 'run',
        type: 'run',
        startFrame: 30,
        endFrame: 60,
        cycleFrames: 12,
        strideMeters: 0.7,
        distanceMeters: 3,
      },
      {
        id: 'jump',
        type: 'jump',
        startFrame: 60,
        endFrame: 90,
        heightMeters: 0.7,
        distanceMeters: 1.5,
      },
      {
        id: 'kick',
        type: 'kick',
        startFrame: 90,
        endFrame: 120,
        leg: 'right',
        targetEntityId: 'prop-kick-target',
        contactFrame: 15,
        angleDegrees: 55,
      },
      {
        id: 'celebrate',
        type: 'celebrate',
        startFrame: 120,
        endFrame: 150,
        intensity: 0.8,
      },
    ];
    expect(
      actions.map((action) => CharacterActionSchema.parse(action).type),
    ).toHaveLength(17);
    expect(() =>
      CharacterActionSchema.parse({
        id: 'bad-mouth',
        type: 'lip-sync',
        startFrame: 0,
        endFrame: 30,
        visemes: [
          { startFrame: 10, endFrame: 20, shape: 'open' },
          { startFrame: 5, endFrame: 15, shape: 'wide' },
        ],
      }),
    ).toThrow(/ordered, non-overlapping/);
    expect(() =>
      CharacterActionSchema.parse({ ...actions[8], effector: 'arm.unknown' }),
    ).toThrow();

    const manifestInput = JSON.parse(
      await readFile(
        resolve('examples/they-have-reached-procedural/manifest.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const shots = manifestInput['shots'] as Record<string, unknown>[];
    const scene = shots[0]?.['scene'] as Record<string, unknown>;
    scene['styleOverrides'] = {
      palette: { paper: [0.9, 0.88, 0.82] },
      grainStrength: 0.2,
    };
    scene['lights'] = [
      {
        id: 'lantern-key',
        type: 'area',
        position: { x: -2, y: -1, z: 2 },
        target: { x: 0, y: 0, z: 0 },
        color: [0.82, 0.77, 0.68],
        energy: 40,
        size: 0.8,
      },
    ];
    const manifest = parseProjectManifest(manifestInput);
    const shot = manifest.shots[0];
    if (!shot) throw new Error('Proof project is missing its shot.');
    const compiled = compileScene(shot, manifest.video.frameRate);
    expect(compiled.style.palette.paper).toEqual([0.9, 0.88, 0.82]);
    expect(compiled.style.grainStrength).toBe(0.2);
    expect(compiled.lights[0]?.id).toBe('lantern-key');
  });

  it('compiles versioned motion-library clips into renderer-independent frame curves', async () => {
    const input = JSON.parse(
      await readFile(
        resolve('examples/they-have-reached-procedural/manifest.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const shots = input['shots'] as Record<string, unknown>[];
    const shotInput = shots[0];
    if (!shotInput) throw new Error('Missing test shot.');
    const scene = shotInput['scene'] as Record<string, unknown>;
    scene['motionLibraries'] = [{ assetId: 'motion.father', version: '1.0.0' }];
    const characters = scene['characters'] as Record<string, unknown>[];
    const character = characters[0];
    if (!character) throw new Error('Missing test character.');
    const actions = character['actions'] as Record<string, unknown>[];
    actions.push({
      id: 'nod-clip',
      type: 'motion-clip',
      startFrame: 0,
      endFrame: 30,
      library: { assetId: 'motion.father', version: '1.0.0' },
      clipId: 'look-down',
      playbackRate: 1,
      blendMode: 'replace',
    });
    const requiredAssets = shotInput['requiredAssets'] as Record<
      string,
      unknown
    >[];
    requiredAssets.push({ assetId: 'motion.father', version: '1.0.0' });
    const manifest = parseProjectManifest(input);
    const shot = manifest.shots[0];
    if (!shot) throw new Error('Missing parsed shot.');
    const library = MotionClipLibrarySchema.parse({
      schemaVersion: '1.0.0',
      libraryId: 'motion.father',
      version: '1.0.0',
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
                { frame: 15, value: [0.1, 0, 0] },
                { frame: 30, value: [0, 0, 0] },
              ],
            },
          ],
        },
      ],
    });
    const compiled = compileScene(shot, manifest.video.frameRate, [library]);
    expect(compiled.motionCurves).toHaveLength(3);
    expect(compiled.motionCurves[1]?.frame).toBe(15);
    expect(compiled.motionCurves[1]?.control).toBe('head');
  });
});
