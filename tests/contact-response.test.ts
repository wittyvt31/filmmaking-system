import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RiggedCharacterSchema } from '@filmmaking/contracts';
import {
  createContactResponseEvaluator,
  prepareCharacter,
  type ContactParticipant,
} from '@filmmaking/scene';
const pose = { position: [0, 0, 0], rotation: [1, 0, 0, 0] };
const manifest = JSON.parse(
  readFileSync('examples/humanoid-animation/manifest.json', 'utf8'),
);
function participants(): ContactParticipant[] {
  return ['a', 'b'].map((id) => {
    const character = prepareCharacter(
      RiggedCharacterSchema.parse(manifest.shots[0].scene.characters[0]),
      121,
    );
    character.id = id;
    return {
      character,
      root: { position: [0, 0, 0], rotation: [1, 0, 0, 0] },
      scale: 1,
      rotations: new Map(),
      lockedJoints: new Set(),
    };
  });
}
function request() {
  return {
    version: 1,
    characters: ['a', 'b'].map((entityId) => ({
      entityId,
      massKg: 60,
      recoveryFrequencyHz: 1,
      supportRadiusMeters: 0.001,
    })),
    loads: [
      {
        contact: {
          id: 'impact',
          a: {
            entityId: 'a',
            boneId: 'hand.R',
            chainRoot: 'upper_arm.R',
            anchor: pose,
          },
          b: {
            entityId: 'b',
            boneId: 'hand.R',
            chainRoot: 'upper_arm.R',
            anchor: pose,
          },
          relativePose: pose,
          startFrame: 0,
          endFrame: 30,
        },
        direction: [1, 0, 0],
        impulseNewtonSeconds: 30,
        durationSeconds: 0.5,
      },
    ],
  };
}
it('couples equal and opposite impulses, recovers and supports arbitrary frame access', () => {
  const sample = createContactResponseEvaluator(
    request(),
    { numerator: 30, denominator: 1 },
    participants,
  );
  const peak = sample(5);
  expect(peak[0]!.displacement[0]).toBeCloseTo(-peak[1]!.displacement[0], 12);
  expect(peak[1]!.displacement[0]).toBeCloseTo(
    0.5 * (5 / 30) * Math.exp((-2 * Math.PI * 5) / 30),
    12,
  );
  expect(peak[1]!.stepTarget).toBeDefined();
  expect(Math.abs(sample(120)[1]!.displacement[0])).toBeLessThan(1e-8);
  expect(sample(5)).toEqual(peak);
});
it('preserves authored roots and joints, and rejects separated impacts', () => {
  const r = request();
  Object.assign(r.characters[0]!, {
    rootLocked: true,
    joints: [{ joint: 'upper_arm.R', inertiaKgMetersSquared: 2 }],
  });
  const sample = () =>
    participants().map((p) => ({
      ...p,
      lockedJoints: new Set(['upper_arm.R']),
    }));
  expect(
    createContactResponseEvaluator(
      r,
      { numerator: 30, denominator: 1 },
      sample,
    )(5)[0]!.displacement,
  ).toEqual([0, 0, 0]);
  expect(() =>
    createContactResponseEvaluator(r, { numerator: 30, denominator: 1 }, () =>
      participants().map((p, i) => ({
        ...p,
        root: { ...p.root, position: [i, 0, 0] },
      })),
    ),
  ).toThrow('separated');
});
it('matches physical time across frame rates and releases sustained force', () => {
  const r = request();
  Object.assign(r.loads[0]!, { forceNewtons: 40, impulseNewtonSeconds: 0 });
  const a = createContactResponseEvaluator(
    r,
    { numerator: 30, denominator: 1 },
    participants,
  );
  const b = createContactResponseEvaluator(
    r,
    { numerator: 60, denominator: 1 },
    participants,
  );
  expect(a(6)[1]!.displacement).toEqual(b(12)[1]!.displacement);
  expect(a(120)[1]!.displacement[0]).toBeLessThan(1e-8);
});

it('provides a lifted step, fixed plant and recovery without modifying locked foot chains', () => {
  const r = request();
  Object.assign(r.characters[1]!, {
    stagger: { effector: 'foot.R', chainRoot: 'thigh.R' },
  });
  const rate = { numerator: 30, denominator: 1 };
  const evaluate = createContactResponseEvaluator(r, rate, participants);
  const stance = evaluate(14)[1]!.staggerFoot!;
  expect(stance.phase).toBe('plant');
  expect(evaluate(16)[1]!.staggerFoot).toEqual(stance);
  expect(evaluate(8)[1]!.staggerFoot!.position[2]).toBeGreaterThan(
    stance.position[2] + 0.05,
  );
  expect(evaluate(22)[1]!.staggerFoot!.phase).toBe('recover');
  expect(evaluate(30)[1]!.staggerFoot).toBeUndefined();
  expect(evaluate(14)[1]!.staggerFoot).toEqual(stance);
  const locked = createContactResponseEvaluator(r, rate, () =>
    participants().map((p) => ({
      ...p,
      lockedJoints: new Set(['shin.R']),
    })),
  )(14)[1]!;
  expect(locked.staggerFoot).toBeUndefined();
  expect(locked.constrained).toContain('authored-stagger-chain');
});

it('turns off-centre load into joint recoil and preserves a locked authored pose', () => {
  const r = request();
  Object.assign(r.characters[1]!, {
    joints: [
      { joint: 'upper_arm.R', inertiaKgMetersSquared: 2, maxRecoilDegrees: 6 },
    ],
  });
  const rate = { numerator: 30, denominator: 1 };
  const free = createContactResponseEvaluator(r, rate, participants)(5)[1]!;
  const rotation = free.rotations.get('upper_arm.R')!;
  const angle = (2 * Math.acos(rotation[0]) * 180) / Math.PI;
  expect(angle).toBeGreaterThan(1);
  expect(angle).toBeLessThanOrEqual(6.00001);
  const locked = createContactResponseEvaluator(r, rate, () =>
    participants().map((p) => ({
      ...p,
      lockedJoints: new Set(['upper_arm.R']),
    })),
  )(5)[1]!;
  expect(locked.rotations.has('upper_arm.R')).toBe(false);
  expect(locked.constrained).toContain('authored-joint:upper_arm.R');
});
