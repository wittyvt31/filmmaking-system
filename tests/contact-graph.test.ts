import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  ContactGraphSchema,
  RiggedCharacterSchema,
  ShotSchema,
} from '@filmmaking/contracts';
import {
  prepareCharacter,
  solveContactFrame,
  bakeContactGraph,
  compileScene,
  type ContactParticipant,
} from '@filmmaking/scene';

it('bakes the reference while preserving locomotion, authored joints and world identity', () => {
  const manifest = JSON.parse(
    readFileSync('examples/humanoid-animation/manifest.json', 'utf8'),
  );
  const shot = ShotSchema.parse(manifest.shots.at(-1));
  const actor = shot.scene!.characters[0]!;
  if (!('source' in actor)) throw new Error('Expected a skeletal character');
  actor.poses.joints.push({
    joint: 'head',
    keys: [{ frame: 0, rotationDegrees: [5, 0, 0], interpolation: 'hold' }],
  });
  const fps = { numerator: 30, denominator: 1 };
  const baked = compileScene(shot, fps);
  const plainShot = structuredClone(shot);
  delete plainShot.scene!.contactGraph;
  const plain = compileScene(plainShot, fps);
  expect(compileScene(shot, fps).sha256).toBe(baked.sha256);
  expect(baked.sha256).not.toBe(plain.sha256);
  expect(baked.world?.sha256).toBe(plain.world?.sha256);
  for (const [index, c] of baked.characters.entries()) {
    const original = plain.characters[index]!;
    if (!('bones' in c) || !('bones' in original))
      throw new Error('Expected compiled rigs');
    expect(c.sampledMotion!.rootPosition).toEqual(
      original.sampledMotion!.rootPosition,
    );
    expect(c.sampledMotion!.rootRotation).toEqual(
      original.sampledMotion!.rootRotation,
    );
    for (const joint of ['foot.L', 'foot.R', 'head']) {
      expect(
        c.sampledMotion!.joints.find((track) => track.joint === joint),
      ).toEqual(
        original.sampledMotion!.joints.find((track) => track.joint === joint),
      );
    }
    const arm = (motion: typeof c.sampledMotion) =>
      motion!.joints.find((track) => track.joint === 'upper_arm.R')!.rotations;
    expect(arm(c.sampledMotion)[0]).toEqual(arm(original.sampledMotion)[0]);
    expect(arm(c.sampledMotion)[95]).toEqual(arm(original.sampledMotion)[95]);
  }
});
const pose = { position: [0, 0, 0], rotation: [1, 0, 0, 0] } as const;
function actor(id: string): ContactParticipant {
  const source = JSON.parse(
    readFileSync('examples/humanoid-animation/manifest.json', 'utf8'),
  );
  const character = prepareCharacter(
    RiggedCharacterSchema.parse(source.shots[0].scene.characters[0]),
    5,
  );
  character.id = id;
  character.bones = [
    {
      id: 'arm',
      head: [0, 0, 0],
      tail: [0, 1, 0],
      min: [-90, -90, -90],
      max: [90, 90, 90],
    },
  ];
  return {
    character,
    root: structuredClone(pose) as ContactParticipant['root'],
    scale: 1,
    rotations: new Map(),
    lockedJoints: new Set(),
  };
}
function graph() {
  return ContactGraphSchema.parse({
    version: 1,
    contacts: [
      {
        id: 'handshake',
        a: { entityId: 'a', boneId: 'arm', chainRoot: 'arm', anchor: pose },
        b: { entityId: 'b', boneId: 'arm', chainRoot: 'arm', anchor: pose },
        relativePose: pose,
        startFrame: 0,
        endFrame: 4,
      },
    ],
  });
}
it('coordinates two articulated participants deterministically, preserving inputs', () => {
  const a = actor('a'),
    b = actor('b');
  b.root.position = [0.3, 0, 0];
  const g = graph();
  g.contacts[0]!.channels = 'position';
  const result = solveContactFrame(g, [a, b], 2);
  expect(result.success).toBe(true);
  expect(result.rotations.get('a')!.get('arm')).toBeDefined();
  expect(result.rotations.get('b')!.get('arm')).toBeDefined();
  expect(result).toEqual(solveContactFrame(g, [b, a], 2));
  expect(a.rotations.size).toBe(0);
});
it('solves orientation and compatible simultaneous contacts', () => {
  const a = actor('a'),
    b = actor('b');
  const g = graph();
  g.contacts[0]!.channels = 'orientation';
  g.contacts[0]!.relativePose.rotation = [
    Math.cos(Math.PI / 12),
    0,
    0,
    Math.sin(Math.PI / 12),
  ];
  g.contacts.push({
    ...structuredClone(g.contacts[0]!),
    id: 'compatible',
    priority: 2,
  });
  expect(solveContactFrame(g, [a, b], 2).success).toBe(true);
});
it('preserves locked authored channels and reports incompatible contacts', () => {
  const a = actor('a'),
    b = actor('b');
  a.lockedJoints = b.lockedJoints = new Set(['arm']);
  b.root.position = [2, 0, 0];
  expect(solveContactFrame(graph(), [a, b], 2).success).toBe(false);
  expect(() => bakeContactGraph(graph(), 5, () => [a, b])).toThrow(
    'Contact solve failed',
  );
});
it('activation and release ramps return to authored motion and inactive contacts do nothing', () => {
  const a = actor('a'),
    b = actor('b');
  b.root.position = [0.3, 0, 0];
  const g = graph();
  Object.assign(g.contacts[0]!, {
    blendInFrames: 1,
    blendOutFrames: 1,
    channels: 'position',
  });
  for (const frame of [0, 4, 5]) {
    const result = solveContactFrame(g, [a, b], frame);
    expect(result.success).toBe(true);
    expect(result.rotations.get('a')!.size).toBe(0);
  }
  expect(bakeContactGraph(g, 5, () => [a, b])).toHaveLength(5);
});
it('rejects bad references, duplicates and invalid transition timing', () => {
  const g = graph();
  g.contacts[0]!.a.chainRoot = 'missing';
  expect(() => solveContactFrame(g, [actor('a'), actor('b')], 10)).toThrow(
    'Invalid contact chain',
  );
  const duplicate = graph();
  duplicate.contacts.push(duplicate.contacts[0]!);
  expect(ContactGraphSchema.safeParse(duplicate).success).toBe(false);
  const bad = graph();
  bad.contacts[0]!.blendInFrames = 10;
  expect(ContactGraphSchema.safeParse(bad).success).toBe(false);
});
