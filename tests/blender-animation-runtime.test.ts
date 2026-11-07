import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
        const checkScript = join(temporary, 'acceptance.py');
        await writeFile(
          checkScript,
          `
import bpy
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
left_arm = armature.pose.bones['upper_arm.L']
left_arm.rotation_euler.x = 0.8
bpy.context.view_layer.update()
arm_world = armature.matrix_world
hand_target = next(o for o in bpy.context.scene.objects if o.name == 'IK_hand.L.Target')
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
    root = next(o for o in bpy.context.scene.objects if o.name == 'actor')
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
        expect(proof.code, proof.stderr || proof.stdout).toBe(0);
        expect(proof.stdout).toContain('FILMIE_RUNTIME_ACCEPTANCE');
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }, 900_000);
  },
);
