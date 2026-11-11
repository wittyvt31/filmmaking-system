import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  RiggedCharacterSchema,
  SpatialConstraintSchema,
} from '@filmmaking/contracts';
import {
  prepareCharacter,
  forwardKinematics,
  constrainMotion,
} from '@filmmaking/scene';
import { quaternion, withinLimits } from '../packages/scene/src/motion-math.js';

const manifest = JSON.parse(
  readFileSync('examples/humanoid-animation/manifest.json', 'utf8'),
);
const actor = RiggedCharacterSchema.parse(
  manifest.shots[0].scene.characters[0],
);
actor.poses = { root: [], joints: [] };
delete actor.parentId;
const prepared = prepareCharacter(actor, 3);
const posed = new Map([['upper_arm.L', quaternion([12, 0, 0])]]);
const target = forwardKinematics(prepared, posed).get('hand.L')!.tail;
const constraint = SpatialConstraintSchema.parse({
  id: 'reach',
  effector: 'hand.L',
  chainRoot: 'upper_arm.L',
  target,
  space: 'character-local',
  startFrame: 0,
  endFrame: 2,
});

it('reproduces every rest head and tail through forward kinematics', () => {
  const fk = forwardKinematics(prepared, new Map());
  for (const bone of prepared.bones)
    for (let i = 0; i < 3; i++) {
      expect(fk.get(bone.id)!.head[i]).toBeCloseTo(bone.head[i]!, 8);
      expect(fk.get(bone.id)!.tail[i]).toBeCloseTo(bone.tail[i]!, 8);
    }
});

it('converts world targets through the character and its world parent', () => {
  const child = structuredClone(prepared);
  child.parentId = 'anchor';
  child.transform = {
    position: { x: 1, y: 0, z: 0 },
    rotationDegrees: { x: 0, y: 0, z: 0 },
    scale: 1,
  };
  const [x, y, z] = target;
  const worldTarget = SpatialConstraintSchema.parse({
    ...constraint,
    space: 'world',
    tolerance: 2 * constraint.tolerance,
    target: [3 - 2 * y, 2 * (x + 1), 2 * z],
  });
  expect(
    constrainMotion(child, undefined, [worldTarget], 3, {
      schemaVersion: 1,
      materials: [],
      sha256: '',
      entities: [
        {
          id: 'anchor',
          boxes: [],
          transform: {
            position: { x: 3, y: 0, z: 0 },
            rotationDegrees: { x: 0, y: 0, z: 90 },
            scale: 2,
          },
        },
      ],
    }),
  ).toEqual(constrainMotion(child, undefined, [constraint], 3));
});
it('converges deterministically within tolerance and joint limits', () => {
  const result = constrainMotion(prepared, undefined, [constraint], 3)!;
  expect(result).toEqual(constrainMotion(prepared, undefined, [constraint], 3));
  const rotations = new Map(
    result.joints.map((t) => [t.joint, t.rotations[0]!]),
  );
  const actual = forwardKinematics(prepared, rotations).get('hand.L')!.tail;
  expect(
    Math.hypot(...actual.map((v, i) => v - target[i]!)),
  ).toBeLessThanOrEqual(constraint.tolerance);
  for (const track of result.joints) {
    const b = prepared.bones.find((b) => b.id === track.joint)!;
    expect(withinLimits(track.rotations[0]!, b.min, b.max)).toBe(true);
  }
});
it('rejects unreachable targets and contradictory contacts', () => {
  expect(() =>
    constrainMotion(
      prepared,
      undefined,
      [{ ...constraint, target: [100, 0, 0] }],
      3,
    ),
  ).toThrow(/unreachable/);
  expect(() =>
    constrainMotion(
      prepared,
      undefined,
      [constraint, { ...constraint, id: 'conflict', target: [100, 0, 0] }],
      3,
    ),
  ).toThrow(/conflicts/);
});

it('preserves authored joint channels and rejects incompatible constraints', () => {
  const locked = structuredClone(prepared);
  locked.poses.joints = ['upper_arm.L', 'forearm.L', 'hand.L'].map((joint) => ({
    joint,
    keys: [{ frame: 0, rotationDegrees: [0, 0, 0], interpolation: 'hold' }],
  }));
  expect(() => constrainMotion(locked, undefined, [constraint], 3)).toThrow(
    /authored motion/,
  );
});

it('activates only inside its interval with smooth fades and keeps planted feet', () => {
  const rest = forwardKinematics(prepared, new Map());
  const reach = { ...constraint, startFrame: 1, endFrame: 5, fadeFrames: 1 };
  const feet = ['L', 'R'].map((side) =>
    SpatialConstraintSchema.parse({
      id: 'foot.' + side,
      effector: 'foot.' + side,
      chainRoot: 'thigh.' + side,
      target: rest.get('foot.' + side)!.tail,
      space: 'character-local',
      startFrame: 0,
      endFrame: 6,
      priority: 100,
    }),
  );
  const result = constrainMotion(prepared, undefined, [reach, ...feet], 7)!;
  for (let frame = 0; frame < 7; frame++) {
    const fk = forwardKinematics(
      prepared,
      new Map(result.joints.map((t) => [t.joint, t.rotations[frame]!])),
    );
    for (const foot of feet)
      expect(fk.get(foot.effector)!.tail).toEqual(
        rest.get(foot.effector)!.tail,
      );
    if ([0, 1, 5, 6].includes(frame))
      expect(fk.get('hand.L')!.tail).toEqual(rest.get('hand.L')!.tail);
  }
});
