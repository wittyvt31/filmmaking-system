import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { ProjectManifestSchema } from '@filmmaking/contracts';
import { defaultBlenderExecutable } from '@filmmaking/engine-blender';
import { compileScene } from '@filmmaking/scene';

const manifest = () =>
  ProjectManifestSchema.parse(
    JSON.parse(
      readFileSync('examples/articulated-dynamics/manifest.json', 'utf8'),
    ),
  );
it('compiles stable joint bindings, animation and release into the shot fingerprint', () => {
  const input = manifest(),
    shot = input.shots[0]!;
  const compile = () => compileScene(shot, input.video.frameRate);
  const scene = compile();
  expect(scene.physics?.joints?.map((j) => j.id)).toEqual([
    'carriage-slider',
    'hatch-hinge',
  ]);
  expect(
    scene.physics?.bodies.find((b) => b.entityId === 'hatch')?.transitions,
  ).toEqual([{ frame: 12, mode: 'dynamic' }]);
  expect(compile().sha256).toBe(scene.sha256);
  const joint = shot.scene!.world!.joints![1]!;
  joint.motorKeys[0]!.velocity = 0.25;
  expect(compile().sha256).not.toBe(scene.sha256);
  joint.anchorA.position[0] = 1;
  expect(compile).toThrow(/anchors must share a world pose/);
});

it.skipIf(process.env['FILMIE_BLENDER_JOINT_CHECK'] !== '1')(
  'bakes and reapplies Bullet hinges and animated motors without rendering',
  async () => {
    const input = manifest();
    const compiled = compileScene(input.shots[0]!, input.video.frameRate);
    const scratch = await mkdtemp(join(tmpdir(), 'filmie-joint-check-'));
    try {
      const file = join(scratch, 'spec.json');
      await writeFile(
        file,
        JSON.stringify({
          ...compiled,
          outputDirectory: scratch,
          width: 160,
          height: 90,
          renderConfig: { engine: 'BLENDER_EEVEE', device: 'AUTO', samples: 1 },
        }),
      );
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
            'sys.path.insert(0,' +
              JSON.stringify(resolve('engines/blender/worker')) +
              ')',
            'from render_shot import create_scene, action_fcurves, apply_secondary_motion',
            'from physics_backend import bake_physics, apply_physics_bake',
            'with open(' +
              JSON.stringify(file) +
              ', encoding="utf-8") as stream: spec = json.load(stream)',
            'bpy.ops.wm.read_factory_settings(use_empty=True)',
            'scene, _, _ = create_scene(spec)',
            'baked = bake_physics(scene, spec["physics"], [], spec["durationFrames"], action_fcurves)',
            'again = bake_physics(scene, spec["physics"], [], spec["durationFrames"], action_fcurves)',
            'assert all((p-q).length < 1e-5 and abs(r.dot(s)) > .99999 for k in baked for (p,r),(q,s) in zip(baked[k],again[k]))',
            'hatch = baked["hatch"]',
            'assert all(abs(hatch[i][0].z-.78)<.001 for i in range(12))',
            'assert min(p.z for p,r in hatch[20:]) < .65, [tuple(p) for p,r in hatch[::10]]',
            'assert (hatch[-1][0]-hatch[-10][0]).length < .03, [tuple(p) for p,r in hatch[::10]]',
            'carriage = baked["carriage"]',
            'assert max(p.x for p,r in carriage)-min(p.x for p,r in carriage) > .15',
            'assert abs(carriage[29][0].x-carriage[-1][0].x) > .12, [p.x for p,r in carriage[::10]]',
            'assert max(abs(p.y) for p,r in carriage) < .01 and carriage[29][0].x > 1.15 and max(p.x for p,r in carriage) < 1.33, [p.x for p,r in carriage[::10]]',
            'apply_physics_bake(scene, baked, action_fcurves)',
            'root = next(o for o in scene.objects if o.get("filmie_entity_id") == "hatch")',
            'for f in (63, 1, 32):\n scene.frame_set(f)\n assert (root.location-hatch[f-1][0]).length < 1e-5',
            'control = bpy.data.objects.new("Attachment", None)',
            'scene.collection.objects.link(control)',
            'control.parent = root',
            'control["filmie_control_id"] = "flap"',
            'local = {"position": [0, .2, 0], "rotation": [1, 0, 0, 0]}',
            'track = {"ownerId": "hatch", "bindings": [{"nodeId": "flap", "target": "control", "space": "local"}], "frames": [{"frame": 0, "poses": [{"nodeId": "flap", "local": local, "world": local}]}]}',
            'apply_secondary_motion({"secondaryMotion": [track]}, {}, {"hatch": root})',
            'assert abs(control.location.y - .2) < 1e-6',
            'assert (root.location-hatch[0][0]).length < 1e-5',
          ].join('\n'),
        ],
        { windowsHide: true, timeout: 35000 },
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  45000,
);

it('compiles a character-owned proxy up to its explicit release and reserves the physics root', () => {
  const input = manifest();
  const characterManifest = ProjectManifestSchema.parse(
    JSON.parse(
      readFileSync('examples/skeletal-retargeting/manifest.json', 'utf8'),
    ),
  );
  const character = characterManifest.shots[0]!.scene!.characters.find(
    ({ id }) => id === 'partner',
  )!;
  if (!('source' in character)) throw new Error('Expected skeletal character');
  const shot = input.shots[0]!,
    world = shot.scene!.world!;
  character.transform.position = { x: -1.25, y: -0.48, z: 0.78 };
  character.transform.rotationDegrees.z = 0;
  character.motion = [];
  character.poses.root = [
    {
      frame: 0,
      interpolation: 'linear',
      transform: structuredClone(character.transform),
    },
  ];
  shot.scene!.characters = [character];
  const hatch = world.entities.find(({ id }) => id === 'hatch')!;
  hatch.physics!.followCharacter = {
    characterId: character.id,
    offset: { position: [0, 0, 0], rotation: [1, 0, 0, 0] },
  };
  hatch.secondaryMotion = {
    nodes: [
      {
        id: 'assembly-root',
        kind: 'attachment',
        restPose: { position: [0, 0, 0], rotation: [1, 0, 0, 0] },
        anchored: true,
        massKg: 1,
        stiffness: 80,
        damping: 12,
        gravity: [0, 0, 0],
        drag: 0,
        radius: 0,
        overrides: [],
      },
    ],
    colliders: [],
    substeps: 2,
    solverIterations: 2,
    deterministicSeed: 0,
  };
  const compiled = compileScene(shot, input.video.frameRate);
  const follower = compiled.physics!.bodies.find(
    ({ entityId }) => entityId === 'hatch',
  )!;
  expect(follower.keyframes).toHaveLength(12);
  expect(follower.keyframes[11]?.pose.position).toEqual([-1.25, -0.48, 0.78]);
  expect(
    compiled.secondaryMotion?.find(({ ownerId }) => ownerId === 'hatch')
      ?.bindings,
  ).toEqual([]);
  hatch.physics!.followCharacter.joint = 'absent';
  expect(() => compileScene(shot, input.video.frameRate)).toThrow(
    /Unknown physics follower joint/,
  );
});
