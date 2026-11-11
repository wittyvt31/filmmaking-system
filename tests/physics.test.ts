import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  ShotSchema,
  WorldSchema,
  type CollisionProxy,
} from '@filmmaking/contracts';
import {
  compileScene,
  compileWorld,
  overlapsSphere,
  worldCollisionProxies,
} from '@filmmaking/scene';

const manifest = JSON.parse(
  readFileSync('examples/humanoid-animation/manifest.json', 'utf8'),
);
const drop = () =>
  ShotSchema.parse(
    manifest.shots.find((shot: { id: string }) => shot.id === 'shot.cup-drop'),
  );
const fps = { numerator: 30, denominator: 1 };

it('compiles release into a dynamic transition and fingerprints simulation inputs', () => {
  const shot = drop();
  const compiled = compileScene(shot, fps);
  const cup = compiled.physics!.bodies.find((body) => body.entityId === 'cup')!;
  expect(cup.properties.mode).toBe('kinematic');
  expect(cup.transitions).toEqual([{ frame: 32, mode: 'dynamic' }]);
  expect(cup.colliders[0]!.shape).toEqual({
    kind: 'cylinder',
    radius: 0.045,
    height: 0.1,
  });
  expect(compileScene(shot, fps).sha256).toBe(compiled.sha256);
  shot.scene!.world!.physics!.gravity[2] = -6;
  expect(compileScene(shot, fps).sha256).not.toBe(compiled.sha256);
});

it('rejects an interaction that continues into physics and a missing imported proxy', () => {
  const shot = drop();
  const cup = shot.scene!.world!.entities.find(
    (entity) => entity.id === 'cup',
  )!;
  cup.physics!.transitions = [{ frame: 24, mode: 'dynamic' }];
  expect(() => compileScene(shot, fps)).toThrow(
    /continues into a dynamic interval/,
  );
  delete cup.colliders;
  expect(() => compileScene(shot, fps)).toThrow(/requires collision geometry/);
});

it('accepts dynamic to kinematic takeover only with an explicit world pose', () => {
  const shot = drop();
  shot.scene!.interactions = [];
  const cup = shot.scene!.world!.entities.find(
    (entity) => entity.id === 'cup',
  )!;
  cup.physics!.releaseOnInteraction = false;
  cup.physics!.mode = 'dynamic';
  cup.physics!.transitions = [{ frame: 55, mode: 'kinematic' }];
  expect(() => compileScene(shot, fps)).toThrow(/takeover requires a keyframe/);
  const pose = { position: [0, 0, 1], rotation: [1, 0, 0, 0] } as const;
  cup.physics!.keyframes = [
    {
      frame: 55,
      pose: { position: [...pose.position], rotation: [...pose.rotation] },
    },
  ];
  const body = compileScene(shot, fps).physics!.bodies.find(
    (item) => item.entityId === 'cup',
  )!;
  expect(body.transitions).toEqual([{ frame: 55, mode: 'kinematic' }]);
  expect(body.keyframes[0]!.pose).toEqual(pose);
});

it('resolves scaled imported proxies through the world hierarchy and queries rotated primitives', () => {
  const transform = {
    position: { x: 0, y: 0, z: 0 },
    rotationDegrees: { x: 0, y: 0, z: 0 },
    scale: 1,
  };
  const world = compileWorld(
    WorldSchema.parse({
      schemaVersion: 1,
      entities: [
        {
          id: 'group',
          transform: {
            ...transform,
            scale: 2,
            rotationDegrees: { x: 0, y: 0, z: 90 },
          },
          geometry: { kind: 'group' },
        },
        {
          id: 'model',
          parentId: 'group',
          transform: { ...transform, position: { x: 1, y: 0, z: 0 } },
          geometry: {
            kind: 'asset',
            asset: { assetId: 'prop.test', version: '1.0.0' },
          },
          colliders: [
            { id: 'box', shape: { kind: 'box', dimensions: [2, 1, 1] } },
          ],
        },
      ],
    }),
  );
  const box = worldCollisionProxies(world)[0]!;
  expect(box.pose.position[1]).toBeCloseTo(2);
  expect(overlapsSphere(box, [0, 3.9, 0], 0)).toBe(true);
  expect(overlapsSphere(box, [1.2, 2, 0], 0.1)).toBe(false);
  const primitives: CollisionProxy['shape'][] = [
    { kind: 'sphere', radius: 1 },
    { kind: 'cylinder', radius: 1, height: 2 },
    { kind: 'capsule', radius: 1, segmentLength: 2 },
  ];
  for (const shape of primitives) {
    const proxy: CollisionProxy = {
      id: shape.kind,
      entityId: 'test',
      shape,
      pose: { position: [0, 0, 0], rotation: [1, 0, 0, 0] },
    };
    expect(overlapsSphere(proxy, [1.05, 0, 0], 0.1)).toBe(true);
    expect(overlapsSphere(proxy, [1.2, 0, 0], 0.1)).toBe(false);
  }
});
