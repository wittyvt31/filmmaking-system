import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { AssetRegistry } from '@filmmaking/assets';
import {
  parseProjectManifest,
  RiggedCharacterSchema,
  resolveRigJointMap,
} from '@filmmaking/contracts';
import { prepareProductionPlan } from '@filmmaking/planner';
import { compileScene, prepareCharacter } from '@filmmaking/scene';

const project = resolve('examples/character-deformation');
const read = (name: string) =>
  JSON.parse(readFileSync(resolve(project, name), 'utf8'));

it('resolves a pinned GLB rig mapping and compiles morph tracks into shot identity', async () => {
  const manifest = parseProjectManifest(read('manifest.json'));
  const assets = read('assets.json');
  const plan = await prepareProductionPlan(
    manifest,
    new AssetRegistry(assets),
    project,
  );
  const scene = plan.compiledScenes['shot.skinned-performer']!;
  const character = RiggedCharacterSchema.parse(
    manifest.shots[0]!.scene!.characters[0],
  );
  expect(resolveRigJointMap(character, assets[0].metadata)?.['forearm.L']).toBe(
    'Studio_forearm.L',
  );
  expect(scene.characters[0]).toMatchObject({
    morphs: [{ target: 'ChestBreath' }],
    deformation: { skinning: 'preserve-volume' },
  });
  const shot = structuredClone(manifest.shots[0]!);
  const actor = RiggedCharacterSchema.parse(shot.scene!.characters[0]);
  actor.morphs![0]!.keys[1]!.value = 0.5;
  shot.scene!.characters[0] = actor;
  const changed = compileScene(shot, manifest.video.frameRate);
  expect(changed.sha256).not.toBe(scene.sha256);
  expect(changed.world?.sha256).toBe(scene.world?.sha256);
  actor.morphs![0]!.keys[2]!.frame = shot.durationFrames;
  expect(() => prepareCharacter(actor, shot.durationFrames)).toThrow(
    /Morph keyframe is outside/,
  );
});

it('rejects duplicate source bindings and accepts an explicit canonical rest skeleton', () => {
  const input = read('manifest.json');
  const character = RiggedCharacterSchema.parse(
    input.shots[0].scene.characters[0],
  );
  if (character.source.kind !== 'imported')
    throw new Error('Expected imported fixture');
  const metadata = read('assets.json')[0].metadata;
  const original = prepareCharacter(character, 20);
  const rest = Object.fromEntries(
    original.bones.map(({ id, head, tail }) => [
      id,
      {
        head: [...head],
        tail: [...tail],
      },
    ]),
  );
  rest['head']!.tail[2]! += 0.02;
  const adapted = RiggedCharacterSchema.parse({
    ...character,
    source: { ...character.source, restSkeleton: rest },
  });
  expect(
    prepareCharacter(adapted, 20).bones.find((b) => b.id === 'head')!.tail[2],
  ).toBeCloseTo(original.bones.find((b) => b.id === 'head')!.tail[2] + 0.02);
  metadata.rigJointMap['head'] = metadata.rigJointMap['neck'];
  expect(() => resolveRigJointMap(character, metadata)).toThrow(
    /distinct source bone/,
  );
});

it('feeds the same canonical motion, locomotion and object interaction tracks to mapped assets', () => {
  const manifest = parseProjectManifest(
    JSON.parse(
      readFileSync(
        resolve('examples/humanoid-animation/manifest.json'),
        'utf8',
      ),
    ),
  );
  const shot = manifest.shots.find((s) => s.id === 'shot.walk-and-place')!;
  const original = compileScene(shot, manifest.video.frameRate);
  const variant = structuredClone(shot);
  const actor = RiggedCharacterSchema.parse(variant.scene!.characters[0]);
  actor.source = {
    kind: 'imported',
    body: actor.source.body,
    asset: { assetId: 'character.studio-performer', version: '1.0.0' },
  };
  variant.scene!.characters[0] = actor;
  const mapped = compileScene(variant, manifest.video.frameRate);
  const before = original.characters[0]!;
  const after = mapped.characters[0]!;
  if (!('bones' in before) || !('bones' in after))
    throw new Error('Expected compiled rigs');
  expect(after.bones).toEqual(before.bones);
  expect(after.sampledMotion).toEqual(before.sampledMotion);
  expect(mapped.objectMotion).toEqual(original.objectMotion);
});
