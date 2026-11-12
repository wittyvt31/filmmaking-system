import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { AssetRegistry } from '@filmmaking/assets';
import { defaultBlenderExecutable } from '@filmmaking/engine-blender';
import {
  ProjectManifestSchema,
  LocomotionSchema,
  type PreparedCharacter,
} from '@filmmaking/contracts';
import { prepareProductionPlan } from '@filmmaking/planner';
import {
  compileScene,
  forwardKinematics,
  rotateVector,
  angularDistance,
} from '@filmmaking/scene';
import { multiply } from '../packages/scene/src/motion-math.js';
import { conjugate } from '../packages/scene/src/rigid-transforms.js';

const project = resolve('examples/skeletal-retargeting');
const load = (file: string): unknown =>
  JSON.parse(readFileSync(join(project, file), 'utf8'));
const manifest = () => ProjectManifestSchema.parse(load('manifest.json'));
const pose = (character: PreparedCharacter, frame: number) =>
  forwardKinematics(
    character,
    new Map(
      character.sampledMotion!.joints.map((track) => [
        track.joint,
        track.rotations[frame]!,
      ]),
    ),
  );
const getActor = (scene: ReturnType<typeof compileScene>, id: string) => {
  const actor = scene.characters.find((character) => character.id === id);
  if (!actor || !('bones' in actor))
    throw new Error('Missing prepared actor: ' + id);
  return actor;
};

it('transfers rest-relative orientations across different skeletons and holds world-space contacts', () => {
  const input = manifest();
  const shot = input.shots[0]!;
  const originalClip = structuredClone(shot.scene!.motionClips[0]);
  const scene = compileScene(shot, input.video.frameRate);
  const source = getActor(scene, 'partner'),
    target = getActor(scene, 'performer');
  const joint = 'forearm.L';
  const fromRest = forwardKinematics(source, new Map()).get(joint)!;
  const toRest = forwardKinematics(target, new Map()).get(joint)!;
  expect(
    angularDistance(
      forwardKinematics(source, new Map()).get('thigh.L')!.rotation,
      forwardKinematics(target, new Map()).get('thigh.L')!.rotation,
    ),
  ).toBeGreaterThan(0.01);
  expect(fromRest.head).not.toEqual(toRest.head);
  expect(
    angularDistance(pose(target, 0).get(joint)!.rotation, toRest.rotation),
  ).toBeLessThan(1e-6);
  const deformation = (character: PreparedCharacter, rest: typeof fromRest) =>
    multiply(
      pose(character, 19).get(joint)!.rotation,
      conjugate(rest.rotation),
    );
  expect(
    angularDistance(deformation(source, fromRest), deformation(target, toRest)),
  ).toBeLessThan(1e-6);
  expect(target.sampledMotion!.rootPosition![19]![2]).toBeCloseTo(-0.02 * 0.84);
  const character = shot.scene!.characters.find(
    ({ id }) => id === 'performer',
  )!;
  if (!('constraints' in character))
    throw new Error('Missing contact constraints');
  for (let frame = 0; frame < shot.durationFrames; frame++) {
    const bones = pose(target, frame);
    const root = target.sampledMotion!.rootPosition![frame]!;
    const yaw = -Math.PI / 30;
    for (const constraint of character.constraints) {
      const tail = rotateVector(
        [Math.cos(yaw), 0, 0, Math.sin(yaw)],
        bones.get(constraint.effector)!.tail,
      );
      expect(
        Math.hypot(
          ...tail.map(
            (coordinate, axis) =>
              coordinate + root[axis]! - constraint.target[axis]!,
          ),
        ),
      ).toBeLessThanOrEqual(constraint.tolerance);
    }
  }
  expect(target.morphs?.some(({ target }) => target === 'Blink')).toBe(true);
  expect(target.facialBoneMap?.['face.jaw']).toBe('DemoJaw');
  expect(shot.scene!.motionClips[0]).toEqual(originalClip);
  expect(compileScene(shot, input.video.frameRate).sha256).toBe(scene.sha256);
  shot.scene!.retargetProfiles![0]!.mapping.translationScale = 0.8;
  expect(compileScene(shot, input.video.frameRate).sha256).not.toBe(
    scene.sha256,
  );
});

it('rejects unsupported or incomplete source rigs and missing mappings during scene compilation', () => {
  for (const [mutate, message] of [
    [
      (shot: ReturnType<typeof manifest>['shots'][number]) => {
        shot.scene!.retargetProfiles![0]!.sourceRig.profile = 'UnknownRig';
      },
      /unsupported source rig/,
    ],
    [
      (shot: ReturnType<typeof manifest>['shots'][number]) => {
        delete shot.scene!.retargetProfiles![0]!.sourceRest['head'];
      },
      /define every source rig joint/,
    ],
    [
      (shot: ReturnType<typeof manifest>['shots'][number]) => {
        const mapping = shot.scene!.retargetProfiles![0]!.mapping;
        mapping.joints = mapping.joints.filter(
          ({ source }) => source !== 'forearm.L',
        );
      },
      /animated source joint has no mapping/,
    ],
  ] as const) {
    const input = manifest(),
      shot = input.shots[0]!;
    mutate(shot);
    expect(() => compileScene(shot, input.video.frameRate)).toThrow(message);
  }
});

it('composes joint-only retargeting with locomotion and rejects competing root motion', () => {
  const input = manifest(),
    shot = input.shots[0]!;
  const target = shot.scene!.characters.find(({ id }) => id === 'performer')!;
  if (!('locomotion' in target || 'constraints' in target))
    throw new Error('Expected humanoid');
  target.constraints = [];
  target.locomotion = LocomotionSchema.parse({
    waypoints: [
      { frame: 0, position: [0.85, 0, 0], yawDegrees: -12 },
      { frame: 19, position: [0.85, -0.12, 0], yawDegrees: -12 },
    ],
  });
  expect(() => compileScene(shot, input.video.frameRate)).toThrow(
    /Locomotion conflicts with authored root motion/,
  );
  const clip = shot.scene!.motionClips[0]!;
  clip.rootPosition = [];
  clip.joints = clip.joints.filter(({ joint }) => joint !== 'thigh.L');
  const actor = getActor(
    compileScene(shot, input.video.frameRate),
    'performer',
  );
  expect(actor.sampledMotion!.rootPosition![19]![1]).toBeCloseTo(-0.12);
  const rotations = actor.sampledMotion!.joints.find(
    ({ joint }) => joint === 'forearm.L',
  )!.rotations;
  expect(angularDistance(rotations[0]!, rotations[19]!)).toBeGreaterThan(0.1);
});

it.skipIf(process.env['FILMIE_BLENDER_RETARGET_CHECK'] !== '1')(
  'evaluates the retargeted GLB and its facial morphs in Blender',
  async () => {
    const input = manifest();
    const plan = await prepareProductionPlan(
      input,
      new AssetRegistry(load('assets.json')),
      project,
    );
    const scene = plan.compiledScenes[input.shots[0]!.id]!;
    const scratch = await mkdtemp(join(tmpdir(), 'filmie-retarget-'));
    try {
      const spec = {
        ...scene,
        outputDirectory: scratch,
        width: 160,
        height: 90,
        samples: 1,
        renderConfig: { engine: 'BLENDER_EEVEE', device: 'AUTO', samples: 1 },
        characters: scene.characters.map((actor) =>
          'bones' in actor && actor.source.kind === 'imported'
            ? {
                ...actor,
                source: {
                  ...actor.source,
                  asset: { ...plan.assets[0], format: 'glb' },
                },
              }
            : actor,
        ),
      };
      const file = join(scratch, 'spec.json');
      await writeFile(file, JSON.stringify(spec));
      await promisify(execFile)(
        defaultBlenderExecutable(),
        [
          '--background',
          '--factory-startup',
          '--python-exit-code',
          '1',
          '--python-expr',
          [
            'import bpy, json, sys',
            'from mathutils import Quaternion',
            'sys.path.insert(0,' +
              JSON.stringify(resolve('engines/blender/worker')) +
              ')',
            'from render_shot import create_scene',
            'bpy.ops.wm.read_factory_settings(use_empty=True)',
            'with open(' +
              JSON.stringify(file) +
              ', encoding="utf-8") as f: spec = json.load(f)',
            'scene, _, _ = create_scene(spec)',
            'rig = next(o for o in scene.objects if o.get("filmie_character_id") == "performer" and o.type == "ARMATURE")',
            'mesh = next(o for o in scene.objects if o.get("filmie_face_reference"))',
            'assert any(g.name == "DemoJaw" for g in mesh.vertex_groups)',
            'assert any(m.type == "ARMATURE" and m.object == rig for m in mesh.modifiers)',
            'scene.frame_set(11)',
            'assert abs(mesh.data.shape_keys.key_blocks["Blink"].value - 1) < 1e-6',
            'scene.frame_set(20)',
            'track = next(t for c in spec["characters"] if c["id"] == "performer" for t in c["sampledMotion"]["joints"] if t["joint"] == "forearm.L")',
            'binding = rig["filmie_joint_bindings"]["forearm.L"]',
            'basis = Quaternion(binding["basis"])',
            'expected = basis @ Quaternion(track["rotations"][-1]) @ basis.inverted()',
            'assert abs(rig.pose.bones[binding["bone"]].rotation_quaternion.dot(expected)) > .99999 and expected.angle > .1',
          ].join('\n'),
        ],
        { timeout: 30_000, windowsHide: true },
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  40_000,
);
