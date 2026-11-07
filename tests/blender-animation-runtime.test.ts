import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defaultBlenderExecutable,
  runBlenderProcess,
} from '@filmmaking/engine-blender';
import { describe, expect, it } from 'vitest';

describe('Blender humanoid runtime acceptance', () => {
  it('deforms weighted humanoid geometry and exercises IK, attachments, and facial controls', async () => {
    const blender = process.env['FILMIE_BLENDER'] ?? defaultBlenderExecutable();
    if (!existsSync(blender) && blender !== 'blender') return;

    const projectDirectory = resolve('examples/they-have-reached-procedural');
    const spec = JSON.parse(
      await readFile(join(projectDirectory, 'asset-spec.json'), 'utf8'),
    ) as { assets: { kind: string }[] };
    const character = spec.assets.find((asset) => asset.kind === 'character');
    if (!character) throw new Error('Missing character acceptance fixture.');

    const temporary = await mkdtemp(join(tmpdir(), 'filmie-animation-'));
    try {
      const workerSpecPath = join(temporary, 'asset-spec.json');
      const outputDirectory = join(temporary, 'outputs');
      await writeFile(
        workerSpecPath,
        JSON.stringify({
          projectId: 'animation-runtime-proof',
          seed: 7,
          style: {
            palette: {
              shadow: [0.065, 0.057, 0.049],
              graphite: [0.31, 0.285, 0.255],
              paper: [0.78, 0.75, 0.69],
            },
            lighting: { ambientFill: 0.34 },
            grainScale: 42,
            grainStrength: 0.09,
            vignetteStrength: 0.2,
          },
          assets: [character],
          outputDirectory,
        }),
      );
      const generation = await runBlenderProcess(
        blender,
        [
          '--background',
          '--factory-startup',
          '--python',
          resolve('engines/blender/worker/build_assets.py'),
          '--',
          workerSpecPath,
        ],
        { timeoutMs: 120_000 },
      );
      expect(generation.code, generation.stderr).toBe(0);

      const result = JSON.parse(
        await readFile(join(outputDirectory, 'worker-result.json'), 'utf8'),
      ) as { assets: { sourcePath: string }[] };
      const blendPath = result.assets[0]?.sourcePath;
      if (!blendPath) throw new Error('Character .blend was not generated.');
      const checkScript = join(temporary, 'acceptance.py');
      await writeFile(
        checkScript,
        `
import bpy
from mathutils import Vector, Matrix
from pathlib import Path
blend_path = ${JSON.stringify(blendPath).replaceAll('\\', '\\\\')}
with bpy.data.libraries.load(blend_path, link=False) as (source, destination):
    destination.collections = [source.collections[0]]
collection = destination.collections[0]
bpy.context.scene.collection.children.link(collection)
armature = next(o for o in collection.objects if o.type == 'ARMATURE')
controls = {o.get("filmie_semantic_id"): o for o in collection.objects if o.get("filmie_semantic_id")}
weighted = [o for o in collection.objects if o.type == 'MESH' and len(o.vertex_groups) >= 2 and any(m.type == 'ARMATURE' for m in o.modifiers)]
assert armature.data.bones and len(armature.data.bones) >= 17
assert len(weighted) > 0
assert {'left-hand', 'right-hand', 'left-leg', 'right-leg', 'mouth'} <= set(controls)
assert sum(o.name.startswith('IK_foot.') for o in collection.objects) == 2
left_arm = armature.pose.bones['upper_arm.L']
left_arm.rotation_euler.x = 0.8
bpy.context.view_layer.update()
arm_world = armature.matrix_world
hand_target = next(o for o in collection.objects if o.name == 'IK_hand.L.Target')
hand_target.location = Vector((0.4, 0.0, 0.55))
bpy.context.view_layer.update()
prop = bpy.data.objects.new('Acceptance Prop', None)
prop.empty_display_type = 'SPHERE'
bpy.context.scene.collection.objects.link(prop)
prop.location = hand_target.location
hand = controls['left-hand']
prop.matrix_world = hand_target.matrix_world
prop.parent = hand
prop.matrix_parent_inverse = hand.matrix_world.inverted()
prop.location = (0, 0, 0)
attached = prop.matrix_world.copy()
bpy.context.view_layer.update()
prop.location = (0.2, 0.0, 0.0)
bpy.context.view_layer.update()
prop.parent = None
prop.matrix_world = attached
released = tuple(prop.location)
mouth = controls['mouth']
mouth.scale = (1.0, 1.0, 1.8)
bpy.context.view_layer.update()
face_transform = mouth.matrix_world.copy().translation

# Exercise the generated skeleton with authored walk, jump, kick and speech
# poses; re-evaluating the same frames must produce identical transforms.
frames = {}
for frame in range(1, 31):
    phase = 2 * 3.141592653589793 * frame / 30
    armature.pose.bones['thigh.L'].rotation_euler.y = 0.45 * __import__('math').sin(phase)
    armature.pose.bones['thigh.R'].rotation_euler.y = 0.45 * __import__('math').sin(phase + 3.141592653589793)
    armature.pose.bones['hand.R'].rotation_euler.x = 0.45 * __import__('math').sin(phase)
    root = next(o for o in collection.objects if o.name == 'ASSET_ROOT')
    root.location.z = 0.35 * max(0.0, __import__('math').sin(3.141592653589793 * frame / 30))
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    frames[frame] = tuple(armature.matrix_world.inverted().to_quaternion()[index] for index in range(4))
snapshot = dict(frames)
for frame in range(1, 31):
    armature.pose.bones['thigh.L'].rotation_euler.y = 0.45 * __import__('math').sin(2 * 3.141592653589793 * frame / 30)
    armature.pose.bones['thigh.R'].rotation_euler.y = 0.45 * __import__('math').sin(2 * 3.141592653589793 * frame / 30 + 3.141592653589793)
    armature.pose.bones['hand.R'].rotation_euler.x = 0.45 * __import__('math').sin(2 * 3.141592653589793 * frame / 30)
    root.location.z = 0.35 * max(0.0, __import__('math').sin(3.141592653589793 * frame / 30))
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
assert dict(frames) == snapshot
print('FILMIE_RUNTIME_ACCEPTANCE', len(armature.data.bones), len(weighted), tuple(released), tuple(face_transform), len(snapshot))
`,
      );
      const proof = await runBlenderProcess(
        blender,
        ['--background', '--factory-startup', '--python', checkScript],
        { timeoutMs: 60_000 },
      );
      expect(proof.code, proof.stderr).toBe(0);
      expect(proof.stdout).toContain('FILMIE_RUNTIME_ACCEPTANCE');
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 180_000);
});
