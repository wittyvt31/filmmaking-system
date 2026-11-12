import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AssetRegistry } from '@filmmaking/assets';
import { ShotSchema } from '@filmmaking/contracts';
import { defaultBlenderExecutable } from '@filmmaking/engine-blender';
import { prepareProductionPlan } from '@filmmaking/planner';
import { angularDistance, compileScene } from '@filmmaking/scene';
import { expect, it } from 'vitest';

const project = resolve('examples/facial-performance');
const load = async (file: string) =>
  JSON.parse(await readFile(join(project, file), 'utf8'));
const rate = { numerator: 30, denominator: 1 };

it('layers expressions, phonemes, visemes and blinks with authored precedence', async () => {
  const {
    shots: [raw],
  } = await load('manifest.json');
  const scene = compileScene(ShotSchema.parse(raw), rate);
  const actor = scene.characters.find((c) => c.id === 'performer')!;
  if (!('bones' in actor)) throw new Error('Expected facial rig');
  const morph = (name: string, frame: number) =>
    actor.morphs!.find((t) => t.target === name)!.keys[frame]!.value;
  expect(morph('Blink', 10)).toBe(1);
  expect(morph('Blink', 13)).toBe(0);
  expect(morph('Round', 5)).toBe(0);
  expect(morph('Round', 11)).toBeCloseTo(0.8);
  expect(morph('Smile', 8)).toBe(0.75);
  expect(morph('Smile', 14)).toBe(0.3);
  const jaw = actor.sampledMotion!.joints.find(
    (t) => t.joint === 'face.jaw',
  )!.rotations;
  expect((angularDistance(jaw[5]!, [1, 0, 0, 0]) * 180) / Math.PI).toBeCloseTo(
    19.8,
  );
  const head = actor.sampledMotion!.joints.find(
    (t) => t.joint === 'head',
  )!.rotations;
  expect(angularDistance(head[0]!, head[12]!)).toBeGreaterThan(0.03);
  expect(compileScene(ShotSchema.parse(raw), rate).sha256).toBe(scene.sha256);
  const layered = structuredClone(raw);
  const upper = layered.scene.characters[0].facial.layers;
  for (const [blend, value] of [
    ['replace', 0],
    ['additive', 0.2],
  ] as const)
    upper.push({
      kind: 'control',
      control: 'smile',
      keys: [{ frame: 6, value }],
      startFrame: 6,
      endFrame: 13,
      blend,
      priority: 30,
      weight: 0.5,
    });
  const layeredActor = compileScene(
    ShotSchema.parse(layered),
    rate,
  ).characters.find((c) => c.id === 'performer')!;
  if (!('bones' in layeredActor)) throw new Error('Expected facial rig');
  expect(
    layeredActor.morphs!.find((t) => t.target === 'Smile')!.keys[8]!.value,
  ).toBeCloseTo(0.475);
  raw.scene.characters[0].morphs = [
    {
      mesh: 'Facial Surface',
      target: 'Smile',
      keys: [{ frame: 0, value: 0.12 }],
    },
  ];
  raw.scene.characters[0].poses.joints.push({
    joint: 'head',
    keys: [{ frame: 0, rotationDegrees: [0, 0, 0] }],
  });
  const changed = compileScene(ShotSchema.parse(raw), rate);
  const override = changed.characters.find((c) => c.id === 'performer')!;
  if (!('bones' in override)) throw new Error('Expected facial rig');
  expect(override.morphs!.find((t) => t.target === 'Smile')!.keys).toEqual([
    { frame: 0, interpolation: 'linear', value: 0.12 },
  ]);
  expect(
    override
      .sampledMotion!.joints.find((t) => t.joint === 'head')!
      .rotations.every((q) => q[0] === 1),
  ).toBe(true);
  expect(changed.world?.sha256).toBe(scene.world?.sha256);
  expect(changed.sha256).not.toBe(scene.sha256);
});

it('rejects invalid symbols, targets, cyclic rigs and shot bounds', async () => {
  const {
    shots: [raw],
  } = await load('manifest.json');
  const compile = (v: unknown) => compileScene(ShotSchema.parse(v), rate);
  const speech = structuredClone(raw);
  speech.scene.characters[0].facial.speech[0].id = 'missing';
  expect(() => compile(speech)).toThrow(/Unknown speech symbol/);
  const target = structuredClone(raw);
  target.scene.characters[0].facial.gaze[0].target.entityId = 'absent';
  expect(() => compile(target)).toThrow(/Unknown tracking target entity/);
  const cycle = structuredClone(raw);
  cycle.scene.facialRigs[0].bones[0].parent = 'face.jaw';
  expect(() => compile(cycle)).toThrow(/cyclic facial bone parent/);
  raw.scene.characters[0].facial.blinks[0].openFrames = 30;
  expect(() => compile(raw)).toThrow(/exceeds shot duration/);
});

it.skipIf(process.env['FILMIE_BLENDER_FACE_CHECK'] !== '1')(
  'binds facial bones and evaluates morph, jaw and gaze frames in Blender without rendering',
  async () => {
    const plan = await prepareProductionPlan(
      await load('manifest.json'),
      new AssetRegistry(await load('assets.json')),
      project,
    );
    const scene = plan.compiledScenes['shot.facial-study']!;
    const scratch = await mkdtemp(join(tmpdir(), 'filmie-face-check-'));
    try {
      const spec = {
        ...scene,
        outputDirectory: scratch,
        width: 160,
        height: 90,
        samples: 1,
        renderConfig: { engine: 'BLENDER_EEVEE', device: 'AUTO', samples: 1 },
        characters: scene.characters.map((c) =>
          'bones' in c && c.source.kind === 'imported'
            ? {
                ...c,
                source: {
                  ...c.source,
                  asset: { ...plan.assets[0], format: 'glb' },
                },
              }
            : c,
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
            'from mathutils import Quaternion, Vector',
            'sys.path.insert(0,' +
              JSON.stringify(resolve('engines/blender/worker')) +
              ')',
            'from render_shot import create_scene',
            'bpy.ops.wm.read_factory_settings(use_empty=True)',
            'with open(' +
              JSON.stringify(file) +
              ', encoding="utf-8") as f: spec = json.load(f)',
            'scene, _, _ = create_scene(spec)',
            'rig = next(o for o in scene.objects if o.type == "ARMATURE" and o.get("filmie_character_id") == "performer")',
            'partner = next(o for o in scene.objects if o.type == "ARMATURE" and o.get("filmie_character_id") == "partner")',
            'mesh = next(o for o in scene.objects if o.get("filmie_face_reference"))',
            'keys = mesh.data.shape_keys.key_blocks',
            'scene.frame_set(11)',
            'assert abs(keys["Blink"].value - 1) < 1e-6',
            'scene.frame_set(6)',
            'jaw = rig.pose.bones["DemoJaw"]',
            'assert abs(jaw.rotation_quaternion.angle - 0.345575) < 1e-5',
            'eye = rig.pose.bones["DemoEyeL"]',
            'basis = Quaternion(rig["filmie_joint_bindings"]["face.eye.L"]["basis"])',
            'actual = (rig.matrix_world.to_quaternion() @ eye.matrix.to_quaternion() @ basis @ Vector((0,1,0))).normalized()',
            'target = (partner.matrix_world @ partner.pose.bones["head"].head - rig.matrix_world @ eye.head).normalized()',
            'assert actual.dot(target) > .999, actual.dot(target)',
            'scene.frame_set(12)',
            'assert abs(keys["Round"].value - .8) < 1e-6',
            'scene.frame_set(15)',
            'assert abs(keys["Smile"].value - .3) < 1e-6 and keys["Blink"].value == 0',
            'assert any(g.name == "DemoJaw" for g in mesh.vertex_groups)',
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
