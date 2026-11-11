import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  LocomotionSchema,
  RiggedCharacterSchema,
  ShotSchema,
} from '@filmmaking/contracts';
import {
  compileScene,
  compileWorld,
  forwardKinematics,
  prepareCharacter,
  rotateVector,
  sampleLocomotion,
} from '@filmmaking/scene';

const manifest = JSON.parse(
  readFileSync('examples/humanoid-animation/manifest.json', 'utf8'),
);
const shot = () =>
  ShotSchema.parse(
    manifest.shots.find((s: { id: string }) => s.id === 'shot.walk-and-place'),
  );
const fps = { numerator: 30, denominator: 1 };

it('bakes timed root travel, alternating swing, and planted feet', () => {
  const source = shot();
  const actor = RiggedCharacterSchema.parse(source.scene!.characters[0]);
  const character = prepareCharacter(actor, source.durationFrames);
  const world = compileWorld(source.scene!.world!);
  const { contacts } = sampleLocomotion(
    character,
    actor.locomotion,
    undefined,
    source.durationFrames,
    fps,
    world,
  );
  const compiled = compileScene(source, fps);
  const prepared = compiled.characters[0]!;
  if (!('bones' in prepared)) throw new Error('Expected a skeletal character');
  const motion = prepared.sampledMotion!;
  expect(motion.rootPosition![0]).toEqual(
    actor.locomotion!.waypoints[0]!.position,
  );
  expect(motion.rootPosition![49]).toEqual([0, 0, 0]);
  expect(motion.rootPosition![68]).toEqual(motion.rootPosition!.at(-1));
  expect(motion.rootRotation![49]).not.toEqual(motion.rootRotation![68]);
  expect(
    contacts.some(
      (c) =>
        c.effector === 'foot.L' &&
        c.startFrame === c.endFrame &&
        c.target[2] > 0.1,
    ),
  ).toBe(true);
  expect(
    contacts.some(
      (c) =>
        c.effector === 'foot.R' &&
        c.startFrame === c.endFrame &&
        c.target[2] > 0.1,
    ),
  ).toBe(true);
  for (const frame of [1, 7, 20, 49, 58, 68, 105]) {
    const [x, y, z] = motion.rootPosition![frame]!;
    const posed = forwardKinematics(
      prepared,
      new Map(motion.joints.map((t) => [t.joint, t.rotations[frame]!])),
    );
    const { rotation, position } = {
      rotation: motion.rootRotation![frame]!,
      position: [x, y, z] as [number, number, number],
    };
    for (const contact of contacts.filter(
      (c) => c.startFrame <= frame && c.endFrame >= frame,
    )) {
      const tail = rotateVector(rotation, posed.get(contact.effector)!.tail);
      expect(
        Math.hypot(
          ...tail.map((v, i) => v + position[i]! - contact.target[i]!),
        ),
      ).toBeLessThanOrEqual(contact.tolerance + 1e-8);
    }
  }
  expect(compileScene(source, fps).sha256).toBe(compiled.sha256);
});

it('uses elevated box tops for contact and rejects blocked paths and root conflicts', () => {
  const source = shot();
  const actor = RiggedCharacterSchema.parse(source.scene!.characters[0]);
  const prepared = prepareCharacter(actor, source.durationFrames);
  const path = LocomotionSchema.parse({
    waypoints: [
      { frame: 0, position: [0, 0, 0.1], yawDegrees: 0 },
      { frame: 18, position: [0, -0.18, 0.1], yawDegrees: 0 },
    ],
  });
  const transform = (z: number) => ({
    position: { x: 0, y: 0, z },
    rotationDegrees: { x: 0, y: 0, z: 0 },
    scale: 1,
  });
  const platform = {
    id: 'platform',
    transform: transform(0.05),
    boxes: [
      {
        id: 'body',
        position: { x: 0, y: 0, z: 0 },
        dimensions: { x: 2, y: 2, z: 0.1 },
        materialId: 'platform',
      },
    ],
  };
  const world = {
    schemaVersion: 1 as const,
    materials: [],
    sha256: '',
    entities: [platform],
  };
  const { contacts } = sampleLocomotion(
    prepared,
    path,
    undefined,
    19,
    fps,
    world,
  );
  expect(contacts[0]!.target[2]).toBeCloseTo(0.143, 6);
  const blocked = {
    ...world,
    entities: [{ ...platform, id: 'barrier', transform: transform(0.6) }],
  };
  expect(() =>
    sampleLocomotion(prepared, path, undefined, 19, fps, blocked),
  ).toThrow(/blocked by barrier/);
  expect(() =>
    sampleLocomotion(
      prepared,
      path,
      { joints: [], rootPosition: [] },
      19,
      fps,
      world,
    ),
  ).toThrow(/authored root motion/);
});
