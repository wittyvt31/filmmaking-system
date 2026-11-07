import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defaultBlenderExecutable,
  runBlenderProcess,
} from '@filmmaking/engine-blender';
import { describe, expect, it } from 'vitest';

const blenderExecutable =
  process.env['FILMIE_BLENDER'] ?? defaultBlenderExecutable();
const blenderAvailable =
  blenderExecutable === 'blender' ? true : existsSync(blenderExecutable);

describe.skipIf(!blenderAvailable)(
  'Blender humanoid runtime acceptance',
  () => {
    it('deforms weighted humanoid geometry and exercises IK, attachments, and facial controls', async () => {
      const blender = blenderExecutable;

      const projectDirectory = resolve('examples/they-have-reached-procedural');
      const spec = JSON.parse(
        await readFile(join(projectDirectory, 'asset-spec.json'), 'utf8'),
      ) as {
        assets: { kind: string; assetId: string }[];
      };
      const character = spec.assets.find((asset) => asset.kind === 'character');
      if (!character) throw new Error('Missing character acceptance fixture.');
      const environment = spec.assets.find(
        (asset) => asset.kind === 'environment',
      );
      if (!environment)
        throw new Error('Missing environment acceptance fixture.');

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
            assets: [
              character,
              environment,
              {
                assetId: 'character.animation-prop',
                version: '1.0.0',
                kind: 'prop',
                displayName: 'Animation acceptance prop',
                propType: 'custom',
                scale: 1,
                geometry: [
                  {
                    id: 'body',
                    type: 'box',
                    position: { x: 0, y: 0, z: 0 },
                    rotationDegrees: { x: 0, y: 0, z: 0 },
                    dimensions: [0.25, 0.25, 0.25],
                    materialTone: '#555555',
                    bevel: 0.02,
                  },
                ],
                anchors: [{ id: 'handle', position: { x: 0, y: 0, z: 0.15 } }],
              },
            ],
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
          { timeoutMs: 300_000 },
        );
        expect(generation.code, generation.stderr).toBe(0);

        const result = JSON.parse(
          await readFile(join(outputDirectory, 'worker-result.json'), 'utf8'),
        ) as {
          assets: {
            assetId: string;
            sourcePath: string;
            collection: string;
          }[];
        };
        const blendPath = result.assets[0]?.sourcePath;
        if (!blendPath) throw new Error('Character .blend was not generated.');
        const characterAsset = result.assets.find(
          (asset) => asset.assetId === character.assetId,
        );
        const propAsset = result.assets.find(
          (asset) => asset.assetId === 'character.animation-prop',
        );
        const environmentAsset = result.assets.find(
          (asset) => asset.assetId === environment.assetId,
        );
        if (!characterAsset || !propAsset || !environmentAsset)
          throw new Error('Production acceptance assets were not generated.');

        const productionSpecPath = join(temporary, 'render-spec.json');
        await writeFile(
          productionSpecPath,
          JSON.stringify({
            outputDirectory: join(temporary, 'render'),
            width: 320,
            height: 180,
            samples: 4,
            durationFrames: 12,
            frameRate: { numerator: 24, denominator: 1 },
            animationLibraryVersion: '1.0.0',
            environment: {
              assetId: environmentAsset.assetId,
              version: '1.0.0',
              localPath: environmentAsset.sourcePath,
              metadata: { blenderCollection: environmentAsset.collection },
            },
            layers: [],
            characters: [
              {
                id: 'actor',
                artwork: {
                  assetId: characterAsset.assetId,
                  version: '1.0.0',
                  localPath: characterAsset.sourcePath,
                  metadata: { blenderCollection: characterAsset.collection },
                },
                transform: {
                  position: { x: 0, y: 0, z: 0 },
                  rotationDegrees: { x: 0, y: 0, z: 0 },
                  scale: 1,
                },
              },
            ],
            props: [
              {
                id: 'target',
                artwork: {
                  assetId: propAsset.assetId,
                  version: '1.0.0',
                  localPath: propAsset.sourcePath,
                  metadata: { blenderCollection: propAsset.collection },
                },
                transform: {
                  position: { x: -0.8, y: 0.0, z: 0.73 },
                  rotationDegrees: { x: 0, y: 0, z: 0 },
                  scale: 1,
                },
              },
            ],
            lights: [],
            camera: {
              startFrame: 0,
              durationFrames: 12,
              fromDistance: 4,
              toDistance: 4,
              target: { x: 0, y: 0, z: 0.9 },
            },
            cameraKeyframes: [
              { frame: 1, distance: 4 },
              { frame: 12, distance: 4 },
            ],
            style: {
              palette: {
                shadow: [0.065, 0.057, 0.049],
                graphite: [0.31, 0.285, 0.255],
                paper: [0.78, 0.75, 0.69],
              },
              lighting: {
                keyColor: [0.73, 0.69, 0.62],
                keyEnergy: 110,
                keySize: 3.4,
                keyPosition: [-2, -3.5, 2.4],
                ambientFill: 0.34,
              },
              grainScale: 42,
              grainStrength: 0.09,
              vignetteStrength: 0.2,
              hazeStrength: 0.025,
            },
            actions: [
              {
                characterId: 'actor',
                interval: { startFrame: 0, endFrame: 3 },
                action: {
                  id: 'breathe',
                  type: 'breathing',
                  startFrame: 0,
                  endFrame: 3,
                  cycleFrames: 3,
                  amplitude: 0.08,
                },
              },
              {
                characterId: 'actor',
                interval: { startFrame: 3, endFrame: 6 },
                action: {
                  id: 'walk',
                  type: 'walk',
                  startFrame: 3,
                  endFrame: 6,
                  cycleFrames: 4,
                  strideMeters: 0.45,
                  distanceMeters: 0.3,
                },
              },
              {
                characterId: 'actor',
                interval: { startFrame: 3, endFrame: 6 },
                action: {
                  id: 'reach',
                  type: 'reach',
                  startFrame: 3,
                  endFrame: 6,
                  effector: 'left-hand',
                  targetEntityId: 'target',
                  targetAnchorId: 'handle',
                },
              },
              {
                characterId: 'actor',
                interval: { startFrame: 6, endFrame: 9 },
                action: {
                  id: 'grasp',
                  type: 'grasp',
                  startFrame: 6,
                  endFrame: 9,
                  effector: 'left-hand',
                  targetEntityId: 'target',
                  targetAnchorId: 'handle',
                },
              },
              {
                characterId: 'actor',
                interval: { startFrame: 9, endFrame: 12 },
                action: {
                  id: 'release',
                  type: 'place',
                  startFrame: 9,
                  endFrame: 12,
                  effector: 'left-hand',
                  targetEntityId: 'target',
                  targetAnchorId: 'handle',
                  targetPosition: { x: 0.7, y: -1.0, z: 0.25 },
                  targetRotationDegrees: { x: 0, y: 0, z: 45 },
                },
              },
              {
                characterId: 'actor',
                interval: { startFrame: 0, endFrame: 12 },
                action: {
                  id: 'lip-sync',
                  type: 'lip-sync',
                  startFrame: 0,
                  endFrame: 12,
                  visemes: [
                    { startFrame: 0, endFrame: 3, shape: 'closed' },
                    { startFrame: 4, endFrame: 7, shape: 'open' },
                    { startFrame: 8, endFrame: 11, shape: 'wide' },
                  ],
                },
              },
              {
                characterId: 'actor',
                interval: { startFrame: 3, endFrame: 9 },
                action: {
                  id: 'expression',
                  type: 'expression',
                  startFrame: 3,
                  endFrame: 9,
                  expressionId: 'worried',
                },
              },
              {
                characterId: 'actor',
                interval: { startFrame: 7, endFrame: 12 },
                action: {
                  id: 'celebrate',
                  type: 'celebrate',
                  startFrame: 7,
                  endFrame: 12,
                  intensity: 0.5,
                },
              },
            ],
            motionCurves: [],
          }),
        );
        const production = await runBlenderProcess(
          blender,
          [
            '--background',
            '--factory-startup',
            '--python',
            resolve('engines/blender/worker/render_shot.py'),
            '--',
            productionSpecPath,
          ],
          { timeoutMs: 300_000 },
        );
        expect(production.code, production.stderr).toBe(0);
        const productionResult = JSON.parse(
          await readFile(
            join(temporary, 'render', 'worker-result.json'),
            'utf8',
          ),
        ) as { status: string; blendPath: string; frameCount: number };
        expect(productionResult.status).toBe('success');
        expect(productionResult.frameCount).toBe(12);
        const evidenceDirectory = process.env['FILMIE_RUNTIME_EVIDENCE_DIR'];
        if (evidenceDirectory) {
          await mkdir(evidenceDirectory, { recursive: true });
          await copyFile(
            productionResult.blendPath,
            join(evidenceDirectory, 'scene.blend'),
          );
          for (const frame of [1, 4, 6, 8, 9, 12]) {
            const frameName = `frame_${String(frame).padStart(6, '0')}.png`;
            await copyFile(
              join(temporary, 'render', 'frames', frameName),
              join(evidenceDirectory, frameName),
            );
          }
        }
        const checkScript = join(temporary, 'acceptance.py');
        await writeFile(
          checkScript,
          `
import bpy, math
from mathutils import Vector, Matrix
from pathlib import Path
blend_path = ${JSON.stringify(productionResult.blendPath).replaceAll('\\', '\\\\')}
bpy.ops.wm.open_mainfile(filepath=blend_path)
armature = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
controls = {o.get("filmie_semantic_id"): o for o in bpy.context.scene.objects if o.get("filmie_semantic_id")}
weighted = [o for o in bpy.context.scene.objects if o.type == 'MESH' and len(o.vertex_groups) >= 2 and any(m.type == 'ARMATURE' for m in o.modifiers)]
print('FILMIE_INSPECTION_ARMATURE', len(armature.data.bones), len(weighted), flush=True)
print('FILMIE_INSPECTION_CONTROLS', sorted(controls.keys()), flush=True)
assert armature.data.bones and len(armature.data.bones) >= 17
assert len(weighted) > 0
assert {'left-hand', 'right-hand', 'left-leg', 'right-leg', 'mouth'} <= set(controls)
assert sum(o.name.startswith('IK_foot.') for o in bpy.context.scene.objects) == 2
def measured_pose(frame):
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    rig_eval = armature.evaluated_get(depsgraph)
    left_foot = armature.matrix_world @ rig_eval.pose.bones['foot.L'].matrix.translation
    foot_target = next(o for o in bpy.context.scene.objects if o.name == 'IK_foot.L.Target').evaluated_get(depsgraph).matrix_world.translation
    left_hand = armature.matrix_world @ rig_eval.pose.bones['hand.L'].matrix.translation
    hand_target = next(o for o in bpy.context.scene.objects if o.name == 'IK_hand.L.Target').evaluated_get(depsgraph).matrix_world.translation
    evaluated_mesh = weighted[0].evaluated_get(depsgraph)
    mesh = evaluated_mesh.to_mesh()
    sample = mesh.vertices[min(50, len(mesh.vertices) - 1)].co.copy()
    evaluated_mesh.to_mesh_clear()
    return left_foot.copy(), foot_target.copy(), left_hand.copy(), hand_target.copy(), sample
pose4 = measured_pose(4)
pose6 = measured_pose(6)
assert (pose4[0] - pose4[1]).length < 0.04, 'Evaluated leg IK misses foot target'
assert abs(pose4[1].z - 0.0) < 0.01, 'Left foot target is not grounded'
assert (pose4[2] - pose4[3]).length < 0.03, 'Evaluated arm IK misses hand target'
assert (pose6[0] - pose6[1]).length < 0.04, 'Leg IK misses target during locomotion'
assert (pose6[2] - pose6[3]).length < 0.03, 'Arm IK misses target during locomotion'
assert (pose4[4] - pose6[4]).length > 0.02, 'Skinned mesh did not deform with the evaluated pose'
mouth = controls['mouth']
bpy.context.view_layer.update()
face_transform = mouth.matrix_world.copy().translation

# Inspect only transforms produced by render_shot.py.
frames = {}
root = next(o for o in bpy.context.scene.objects if o.name == 'actor')
prop = next(o for o in bpy.context.scene.objects if o.name == 'target')
for frame in range(1, 13):
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    frames[frame] = (
        tuple(round(v, 6) for v in root.matrix_world.translation),
        tuple(round(v, 6) for v in controls['left-hand'].matrix_world.translation),
        tuple(round(v, 6) for v in controls['left-leg'].matrix_world.translation),
        tuple(round(v, 6) for v in controls['mouth'].matrix_world.translation),
        round(controls['mouth'].scale.x, 4),
        round(controls['mouth'].scale.z, 4),
        tuple(round(v, 6) for v in prop.matrix_world.translation),
    )
assert frames[1] != frames[12]
assert frames[12][4] > 0
snapshot = dict(frames)
second = {}
for frame in range(1, 13):
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    second[frame] = (
        tuple(round(v, 6) for v in root.matrix_world.translation),
        tuple(round(v, 6) for v in controls['left-hand'].matrix_world.translation),
        tuple(round(v, 6) for v in controls['left-leg'].matrix_world.translation),
        tuple(round(v, 6) for v in controls['mouth'].matrix_world.translation),
        round(controls['mouth'].scale.x, 4),
        round(controls['mouth'].scale.z, 4),
        tuple(round(v, 6) for v in prop.matrix_world.translation),
    )
assert second == snapshot

bpy.context.scene.frame_set(5)
bpy.context.view_layer.update()
anchor = controls['left-hand'].matrix_world.translation
bpy.context.scene.frame_set(9)
bpy.context.view_layer.update()
open_mouth = tuple(round(v, 4) for v in controls['mouth'].scale[:])
attachment = prop.constraints.get('FILMIE Hand Attachment')
print('FILMIE_ATTACHMENT', attachment.influence if attachment else None, tuple(round(v, 4) for v in prop.matrix_world.translation), flush=True)
assert attachment is not None
influences = {}
for frame in (7, 8, 9, 10, 11, 12):
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    influences[frame] = attachment.influence
expected = {7: 0.0, 8: 0.5, 9: 1.0, 10: 1.0, 11: 1.0, 12: 0.0}
for frame, value in expected.items():
    assert abs(influences[frame] - value) < 1e-4, (frame, influences[frame])
print('FILMIE_INFLUENCE_BOUNDARIES', influences, flush=True)
bpy.context.scene.frame_set(12)
bpy.context.view_layer.update()
final_world = prop.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world.copy()
assert (final_world.translation - Vector((0.7, -1.0, 0.25))).length < 0.02, final_world.translation
assert abs(final_world.to_euler().z - math.radians(45)) < 0.03, final_world.to_euler().z
print('FILMIE_FINAL_TRANSFORM', tuple(round(v, 4) for v in final_world.translation), round(final_world.to_euler().z, 4), flush=True)
# Verify physical attach/release behavior against evaluated world transforms.
bpy.context.scene.frame_set(6); bpy.context.view_layer.update()
before_attach = prop.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world.translation.copy()
bpy.context.scene.frame_set(7); bpy.context.view_layer.update()
after_attach = prop.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world.translation.copy()
assert (after_attach - before_attach).length < 0.01, 'Object jumped at attachment start'
bpy.context.scene.frame_set(9); bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
anchor_data = __import__('json').loads(prop.get('filmie_anchors', '{}'))
prop_world = prop.evaluated_get(depsgraph).matrix_world.copy()
hand_world = controls['left-hand'].evaluated_get(depsgraph).matrix_world.copy()
anchor_world = prop_world @ Vector(anchor_data['handle'])
contact_distance = (hand_world.translation - anchor_world).length
assert contact_distance < 0.18, ('Hand missed target anchor', contact_distance, tuple(hand_world.translation), tuple(anchor_world))
relative_at_contact = hand_world.inverted() @ prop_world
bpy.context.scene.frame_set(11); bpy.context.view_layer.update()
depsgraph = bpy.context.evaluated_depsgraph_get()
relative_during_carry = controls['left-hand'].evaluated_get(depsgraph).matrix_world.inverted() @ prop.evaluated_get(depsgraph).matrix_world
assert (relative_during_carry.translation - relative_at_contact.translation).length < 0.05, 'Object-relative transform drifted during carry'
bpy.context.scene.frame_set(9); bpy.context.view_layer.update()
before_follow = prop.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world.translation.copy()
controls['left-hand'].location.x += 0.1; bpy.context.view_layer.update()
after_follow = prop.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world.translation.copy()
assert (after_follow - before_follow).length > 0.05, 'Attached object did not follow hand'
bpy.context.scene.frame_set(12); bpy.context.view_layer.update()
before_release = prop.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world.translation.copy()
controls['left-hand'].location.x += 0.1; bpy.context.view_layer.update()
after_release = prop.evaluated_get(bpy.context.evaluated_depsgraph_get()).matrix_world.translation.copy()
assert (after_release - before_release).length < 0.01, 'Released object still followed hand'
bpy.context.scene.frame_set(1)
bpy.context.view_layer.update()
closed_mouth = tuple(round(v, 4) for v in controls['mouth'].scale[:])
assert open_mouth != closed_mouth, (closed_mouth, open_mouth)
assert influences[12] == 0.0
print('FILMIE_RUNTIME_ACCEPTANCE', len(armature.data.bones), len(weighted), tuple(round(v, 6) for v in face_transform), len(snapshot))
print('FILMIE_RIG_MEASUREMENTS', round((pose4[0] - pose4[1]).length, 5), round((pose4[2] - pose4[3]).length, 5), round((pose4[4] - pose6[4]).length, 5), flush=True)
`,
        );
        const proof = await runBlenderProcess(
          blender,
          ['--background', '--factory-startup', '--python', checkScript],
          { timeoutMs: 60_000 },
        );
        expect(proof.code, proof.stderr || proof.stdout).toBe(0);
        expect(`${proof.stdout}\n${proof.stderr}`).toContain(
          'FILMIE_RUNTIME_ACCEPTANCE',
        );
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }, 900_000);
  },
);
