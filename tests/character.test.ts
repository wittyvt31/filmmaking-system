import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AssetRegistry } from '@filmmaking/assets';
import {
  FilmieHumanoid,
  ProjectManifestSchema,
  RiggedCharacterSchema,
} from '@filmmaking/contracts';
import { prepareProductionPlan } from '@filmmaking/planner';
import { compileScene, prepareCharacter } from '@filmmaking/scene';

const project = resolve('examples/3d-production');
const reference = ProjectManifestSchema.parse(
  JSON.parse(readFileSync(resolve(project, 'manifest.json'), 'utf8')),
);
const visitor = () =>
  RiggedCharacterSchema.parse(reference.shots[0]!.scene!.characters[1]);

describe('FilmieHumanoid', () => {
  it('prepares a deterministic rest skeleton and zero-based pose tracks', () => {
    const character = visitor();
    const prepared = prepareCharacter(character, 90);
    expect(prepared.bones).toHaveLength(FilmieHumanoid.joints.length);
    expect(prepared.bones.find(({ id }) => id === 'head')?.tail[2]).toBe(
      character.source.body.height,
    );
    expect(prepared.bones.find(({ id }) => id === 'forearm.L')?.parent).toBe(
      'upper_arm.L',
    );
    expect(prepared).toEqual(prepareCharacter(character, 90));
    expect(
      compileScene(reference.shots[0]!, reference.video.frameRate).characters,
    ).toContainEqual(expect.objectContaining(prepared));
    character.poses.root.shift();
    character.poses.joints[0]!.keys.shift();
    const delayed = prepareCharacter(character, 90);
    expect(delayed.poses.root[0]).toEqual({
      frame: 0,
      transform: character.transform,
      interpolation: 'hold',
    });
    expect(
      delayed.poses.joints.find((track) => track.joint === 'upper_arm.L')
        ?.keys[0],
    ).toEqual({
      frame: 0,
      rotationDegrees: [0, 0, 0],
      interpolation: 'hold',
    });
    character.source.body.height *= 1.1;
    expect(prepareCharacter(character, 90).bones[0]?.head[2]).toBeGreaterThan(
      prepared.bones[0]!.head[2],
    );
  });

  it('rejects unsupported rig versions, inconsistent proportions and invalid pose tracks', () => {
    const character = visitor();
    expect(() =>
      RiggedCharacterSchema.parse({
        ...character,
        rig: { ...character.rig, version: 2 },
      }),
    ).toThrow(/Unknown rig/);
    expect(() =>
      RiggedCharacterSchema.parse({
        ...character,
        source: {
          ...character.source,
          body: {
            ...character.source.body,
            height: 0,
            hipWidth: 0.28,
            shoulderWidth: 0.17,
          },
        },
      }),
    ).toThrow(/height/);
    character.poses.joints.push({
      joint: 'missing',
      keys: [{ frame: 3, rotationDegrees: [0, 0, 0], interpolation: 'hold' }],
    });
    character.poses.joints[0]!.keys[1]!.rotationDegrees = [0, 0, 180];
    character.poses.joints[0]!.keys[1]!.frame = 0;
    expect(() => RiggedCharacterSchema.parse(character)).toThrow(
      /Unknown joint/,
    );
    expect(() => RiggedCharacterSchema.parse(character)).toThrow(/limits/);
    expect(() => RiggedCharacterSchema.parse(character)).toThrow(
      /strictly increasing/,
    );
  });

  it('validates parent references, frame ranges, and imported asset metadata', async () => {
    const manifest = structuredClone(reference);
    const scene = manifest.shots[0]!.scene!;
    const character = visitor();
    scene.characters[1] = character;
    character.parentId = 'missing';
    character.poses.root[1]!.frame = 90;
    expect(() => ProjectManifestSchema.parse(manifest)).toThrow(/world entity/);
    expect(() => ProjectManifestSchema.parse(manifest)).toThrow(
      /within the shot/,
    );
    character.parentId = 'room.main';
    character.poses.root[1]!.frame = 42;
    character.source = {
      kind: 'imported',
      asset: { assetId: 'character.father', version: '1.1.0' },
      body: character.source.body,
    };
    const registry = new AssetRegistry(
      JSON.parse(readFileSync(resolve(project, 'assets.json'), 'utf8')),
    );
    await expect(
      prepareProductionPlan(manifest, registry, project),
    ).rejects.toThrow(/rigProfile and rigVersion/);
    manifest.shots[0]!.requiredAssets = [];
    expect(() => ProjectManifestSchema.parse(manifest)).toThrow(
      /character.father@1.1.0/,
    );
  });
});
