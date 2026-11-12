import { expect, it } from 'vitest';
import {
  RetargetProfileSchema,
  type PreparedCharacter,
  SpatialConstraintSchema,
} from '@filmmaking/contracts';
import {
  retargetFrame,
  validateRetargetCompatibility,
} from '../packages/scene/src/retargeting.js';
import { quaternion } from '../packages/scene/src/motion-math.js';
import { angularDistance } from '../packages/scene/src/rigid-transforms.js';
import { prepareCharacter } from '../packages/scene/src/character.js';
import { RiggedCharacterSchema } from '@filmmaking/contracts';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(
  readFileSync('examples/humanoid-animation/manifest.json', 'utf8'),
);
const base = prepareCharacter(
  RiggedCharacterSchema.parse(manifest.shots[0].scene.characters[0]),
  3,
);
function rig(id: string, length = 1): PreparedCharacter {
  return {
    ...structuredClone(base),
    id,
    parentId: undefined,
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotationDegrees: { x: 0, y: 0, z: 0 },
      scale: 1,
    },
    poses: { root: [], joints: [] },
    bones: [
      {
        id,
        head: [0, 0, 0],
        tail: [0, length, 0],
        min: [-180, -180, -180],
        max: [180, 180, 180],
      },
    ],
  } as PreparedCharacter;
}
const source = rig('source'),
  target = rig('target', 2);
const profile = RetargetProfileSchema.parse({
  version: 1,
  joints: [{ semantic: 'arm', source: 'source', target: 'target' }],
  translationScale: 2,
});
const motion = {
  rootPosition: [
    [1, 0, 0],
    [2, 0, 0],
  ] as [number, number, number][],
  joints: [
    {
      joint: 'source',
      rotations: [quaternion([0, 0, 20]), quaternion([0, 0, 40])],
    },
  ],
};
it('transfers renamed joints, different proportions, and scaled root paths without state', () => {
  const a = retargetFrame(source, target, motion, 1, profile);
  expect(a.success).toBe(true);
  expect(a.motion.rootPosition).toEqual([[4, 0, 0]]);
  expect(
    angularDistance(a.motion.joints[0]!.rotations[0]!, quaternion([0, 0, 40])),
  ).toBeLessThan(1e-6);
  retargetFrame(source, target, motion, 0, profile);
  expect(retargetFrame(source, target, motion, 1, profile)).toEqual(a);
});
it('aligns different rest orientations and converts coordinate axes', () => {
  const rotated = rig('target');
  rotated.bones[0]!.tail = [1, 0, 0];
  const result = retargetFrame(source, rotated, { joints: [] }, 0, profile);
  expect(result.success).toBe(true);
  expect(
    angularDistance(result.motion.joints[0]!.rotations[0]!, [1, 0, 0, 0]),
  ).toBeLessThan(1e-6);
  const converted = retargetFrame(source, target, motion, 0, {
    ...profile,
    coordinateRotation: quaternion([0, 0, 90]),
  });
  expect(converted.motion.rootPosition![0]![1]).toBeCloseTo(2);
});
it('rejects duplicate mappings, missing bones, malformed samples and joint limits', () => {
  expect(() =>
    RetargetProfileSchema.parse({
      ...profile,
      joints: [...profile.joints, ...profile.joints],
    }),
  ).toThrow();
  expect(
    validateRetargetCompatibility(source, target, {
      ...profile,
      joints: [{ semantic: 'arm', source: 'absent', target: 'target' }],
    }),
  ).not.toHaveLength(0);
  expect(() => retargetFrame(source, target, motion, 8, profile)).toThrow();
  const limited = rig('target');
  limited.bones[0]!.min = [0, 0, 0];
  limited.bones[0]!.max = [0, 0, 5];
  expect(
    retargetFrame(source, limited, motion, 0, profile).diagnostics[0]!.code,
  ).toBe('joint-limit');
});
it('solves target-space contact while locking authored overrides and reporting unreachable residuals', () => {
  const contact = SpatialConstraintSchema.parse({
    id: 'plant',
    effector: 'target',
    chainRoot: 'target',
    target: [0, 2, 0],
    space: 'character-local',
    startFrame: 0,
    endFrame: 1,
    tolerance: 0.001,
  });
  const solved = retargetFrame(source, target, motion, 0, profile, {
    constraints: [contact],
  });
  expect(solved.success).toBe(true);
  const blocked = retargetFrame(source, target, motion, 0, profile, {
    constraints: [contact],
    authored: new Map([['target', quaternion([0, 0, 90])]]),
  });
  expect(blocked.success).toBe(false);
  expect(blocked.diagnostics.some((d) => (d.positionError ?? 0) > 1)).toBe(
    true,
  );
  expect(
    angularDistance(
      blocked.motion.joints[0]!.rotations[0]!,
      quaternion([0, 0, 90]),
    ),
  ).toBeLessThan(1e-6);
});
it('preserves target-authored channels', () => {
  const authored = rig('target');
  authored.poses.joints = [
    {
      joint: 'target',
      keys: [{ frame: 0, rotationDegrees: [0, 0, 12], interpolation: 'hold' }],
    },
  ];
  expect(
    angularDistance(
      retargetFrame(source, authored, motion, 0, profile).motion.joints[0]!
        .rotations[0]!,
      quaternion([0, 0, 12]),
    ),
  ).toBeLessThan(1e-6);
});

it('validates mapped ancestry and reports unreachable world-space foot locks', () => {
  const child = rig('target');
  child.bones.push({
    ...child.bones[0]!,
    id: 'toe',
    parent: 'target',
    head: [0, 1, 0],
    tail: [0, 2, 0],
  });
  const invalid = {
    ...profile,
    joints: [
      ...profile.joints,
      { semantic: 'toe', source: 'source', target: 'toe' },
    ],
  };
  expect(() => validateRetargetCompatibility(source, child, invalid)).toThrow();
  const constraint = SpatialConstraintSchema.parse({
    id: 'foot',
    effector: 'target',
    chainRoot: 'target',
    target: [0, 2, 0],
    startFrame: 0,
    endFrame: 1,
    tolerance: 0.001,
  });
  const result = retargetFrame(source, target, motion, 1, profile, {
    constraints: [constraint],
  });
  expect(result.success).toBe(false);
  expect(result.motion.rootPosition).toEqual([[4, 0, 0]]);
  expect(result.diagnostics.some((d) => (d.positionError ?? 0) > 1)).toBe(true);
});
