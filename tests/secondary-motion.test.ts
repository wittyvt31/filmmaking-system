import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ProjectManifestSchema,
  SecondaryMotionBakeSchema,
  SecondaryMotionConfigurationSchema,
  type RigidTransform,
} from '@filmmaking/contracts';
import {
  bakeSecondaryMotion,
  bakeSecondaryMotionByFrame,
} from '@filmmaking/secondary-motion';
import { compileScene } from '@filmmaking/scene';

const pose = (x: number, y = 0, z = 0): RigidTransform => ({
  position: [x, y, z],
  rotation: [1, 0, 0, 0],
});

const config = SecondaryMotionBakeSchema.parse({
  frameCount: 12,
  settings: {
    frameRate: { numerator: 30, denominator: 1 },
    substeps: 4,
  },
  nodes: [
    {
      id: 'tip',
      parentId: 'root',
      kind: 'chain',
      restPose: pose(1),
      massKg: 1,
      stiffness: 40,
      damping: 1,
      gravity: [0, 0, 0],
      drag: 0,
    },
    {
      id: 'root',
      kind: 'attachment',
      restPose: pose(0),
      anchored: true,
    },
  ],
});

it('bakes deterministic follow-through in stable hierarchy order', () => {
  const authored = Array.from({ length: 12 }, (_, frame) => ({
    nodeId: 'root',
    frame,
    pose: pose(frame < 2 ? 0 : 1),
  }));
  const forward = bakeSecondaryMotion({ config, authored });
  const reversed = bakeSecondaryMotion({
    config: { ...config, nodes: [...config.nodes].reverse() },
    authored,
  });
  expect(forward).toEqual(reversed);
  expect(
    forward[2]!.poses.find((item) => item.nodeId === 'tip')!.world.position[0],
  ).toBeLessThan(2);
  expect(
    forward[11]!.poses.find((item) => item.nodeId === 'tip')!.world.position[0],
  ).toBeGreaterThan(1);
});

it('honors explicit overrides and exposes frame-addressable results', () => {
  const overridden = {
    ...config,
    nodes: config.nodes.map((node) =>
      node.id === 'tip'
        ? { ...node, overrides: [{ frame: 5, pose: pose(3) }] }
        : node,
    ),
  };
  const frames = bakeSecondaryMotionByFrame(overridden);
  expect(
    frames.get(5)!.poses.find((item) => item.nodeId === 'tip')!.local.position,
  ).toEqual([3, 0, 0]);
  expect(frames.size).toBe(12);
});

it('compiles character secondary motion after authored skeletal evaluation', () => {
  const manifest = ProjectManifestSchema.parse(
    JSON.parse(
      readFileSync('examples/humanoid-animation/manifest.json', 'utf8'),
    ),
  );
  const shot = manifest.shots[0]!;
  const character = shot.scene!.characters[0]!;
  if (!('source' in character))
    throw new Error('Expected rigged reference character');
  character.secondaryMotion = {
    nodes: [
      {
        id: 'head',
        kind: 'skeletal-control',
        restPose: pose(0),
        anchored: true,
      },
    ],
    colliders: [],
    substeps: 2,
    solverIterations: 2,
    deterministicSeed: 11,
  };
  character.poses.joints = [
    {
      joint: 'head',
      keys: [
        {
          frame: 0,
          rotationDegrees: [0, 0, 0],
          interpolation: 'hold',
        },
        {
          frame: 1,
          rotationDegrees: [0, 10, 0],
          interpolation: 'linear',
        },
      ],
    },
  ];
  const first = compileScene(shot, manifest.video.frameRate);
  const second = compileScene(shot, manifest.video.frameRate);
  expect(first).toEqual(second);
  expect(first.characters[0]).toMatchObject({
    sampledMotion: {
      joints: expect.arrayContaining([
        expect.objectContaining({ joint: 'head' }),
      ]),
    },
  });
});

it('keeps the flexible attachment reference manifest-shaped', () => {
  const reference = JSON.parse(
    readFileSync('examples/secondary-motion/flexible-attachment.json', 'utf8'),
  ) as unknown;
  expect(
    SecondaryMotionConfigurationSchema.parse(reference).nodes,
  ).toHaveLength(2);
});
