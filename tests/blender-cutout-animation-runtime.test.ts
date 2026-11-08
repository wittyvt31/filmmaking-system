import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AssetRegistry, resolveAssetFiles } from '@filmmaking/assets';
import { parseProjectManifest } from '@filmmaking/contracts';
import {
  defaultBlenderExecutable,
  runBlenderProcess,
} from '@filmmaking/engine-blender';
import { compileScene } from '@filmmaking/scene';
import { describe, expect, it } from 'vitest';

const blenderExecutable =
  process.env['FILMIE_BLENDER'] ?? defaultBlenderExecutable();
const blenderAvailable =
  blenderExecutable === 'blender' || existsSync(blenderExecutable);

describe.skipIf(!blenderAvailable)(
  'Blender 2.5D cutout animation runtime',
  () => {
    it('executes mapped cutout controls, facial variants, head motion, and phone contact', async () => {
      const project = resolve('examples/artwork-preparation-proof');
      const manifest = parseProjectManifest(
        JSON.parse(
          await readFile(join(project, 'manifest.json'), 'utf8'),
        ) as unknown,
      );
      const shot = manifest.shots[0];
      if (!shot?.scene)
        throw new Error('Missing structured cutout animation scene.');
      const compiled = compileScene(shot, manifest.video.frameRate);
      const registry = new AssetRegistry(
        JSON.parse(
          await readFile(join(project, 'assets.json'), 'utf8'),
        ) as unknown[],
      );
      const assets = await resolveAssetFiles(
        shot.requiredAssets,
        registry,
        project,
      );
      const byKey = new Map(
        assets.map((asset) => [
          `${asset.assetId}\u0000${asset.version}`,
          asset,
        ]),
      );
      const required = (reference: { assetId: string; version: string }) => {
        const asset = byKey.get(
          `${reference.assetId}\u0000${reference.version}`,
        );
        if (!asset)
          throw new Error(
            `Missing cutout proof asset ${reference.assetId}@${reference.version}`,
          );
        return asset;
      };
      const temporary = await mkdtemp(join(tmpdir(), 'filmie-cutout-runtime-'));
      try {
        const output = join(temporary, 'render');
        const workerSpec = {
          durationFrames: 1,
          frameRate: manifest.video.frameRate,
          width: 320,
          height: 180,
          samples: 1,
          randomSeed: 17,
          outputDirectory: output,
          style: compiled.style,
          animationLibraryVersion: compiled.animationLibraryVersion,
          environment: required(compiled.environment),
          groups: compiled.groups,
          layers: compiled.layers.map((layer) => ({
            ...layer,
            asset: required(layer.asset),
          })),
          characters: compiled.characters.map((character) => ({
            ...character,
            artwork: required(character.artwork),
            rig: character.rig ? required(character.rig) : null,
          })),
          props: compiled.props.map((prop) => ({
            ...prop,
            artwork: required(prop.artwork),
          })),
          lights: compiled.lights,
          camera: compiled.camera,
          cameraKeyframes: compiled.cameraKeyframes,
          actions: compiled.actions,
          motionCurves: compiled.motionCurves,
        };
        const specPath = join(temporary, 'worker-spec.json');
        await writeFile(specPath, JSON.stringify(workerSpec), { flag: 'wx' });
        const worker = await runBlenderProcess(
          blenderExecutable,
          [
            '--background',
            '--factory-startup',
            '--python',
            resolve('engines/blender/worker/render_shot.py'),
            '--',
            specPath,
          ],
          { timeoutMs: 180_000 },
        );
        expect(worker.code, `${worker.stderr}\n${worker.stdout}`).toBe(0);
        const result = JSON.parse(
          await readFile(join(output, 'worker-result.json'), 'utf8'),
        ) as { status: string; blendPath: string; frameCount: number };
        expect(result).toMatchObject({ status: 'success', frameCount: 1 });
        expect(
          (await stat(join(output, 'frames', 'frame_000001.png'))).size,
        ).toBeGreaterThan(0);

        const inspection = join(temporary, 'inspect-scene.py');
        await writeFile(
          inspection,
          `
import bpy
bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(result.blendPath)})
scene=bpy.context.scene
head=bpy.data.objects['GROUP__rig.head']
arm=bpy.data.objects['GROUP__rig.arm.right']
eyes=bpy.data.objects['GROUP__rig.eyes']
phone=bpy.data.objects['telephone']
sprites=[o for o in bpy.data.objects if o.get('filmie_variant_slot')=='face.eyes']
assert len(sprites)==2, len(sprites)
def sample(frame):
    scene.frame_set(frame); bpy.context.view_layer.update()
    return tuple(round(v, 4) for v in phone.matrix_world.translation)
scene.frame_set(3); bpy.context.view_layer.update()
assert eyes.scale.z < 0.1, eyes.scale.z
scene.frame_set(5); bpy.context.view_layer.update()
assert abs(eyes.scale.z - 1.0) < 0.001, eyes.scale.z
scene.frame_set(20); bpy.context.view_layer.update()
assert any(not o.hide_render and o.get('filmie_variant_id')=='calm' for o in sprites)
scene.frame_set(50); bpy.context.view_layer.update()
assert any(not o.hide_render and o.get('filmie_variant_id')=='alarmed' for o in sprites)
scene.frame_set(16); bpy.context.view_layer.update(); start_yaw=head.rotation_euler.z
scene.frame_set(42); bpy.context.view_layer.update(); end_yaw=head.rotation_euler.z
assert abs(end_yaw-start_yaw) > 0.1, (start_yaw,end_yaw)
scene.frame_set(80); bpy.context.view_layer.update(); resting=tuple(arm.location)
scene.frame_set(100); bpy.context.view_layer.update(); reaching=tuple(arm.location)
assert sum((a-b)**2 for a,b in zip(resting,reaching)) > 0.1, (resting,reaching)
before=sample(115); after=sample(140)
assert abs(after[2]-before[2]) > 0.05, (before,after)
print('FILMIE_CUTOUT_RUNTIME', start_yaw, end_yaw, resting, reaching, before, after, flush=True)
`,
          'utf8',
        );
        const reopened = await runBlenderProcess(
          blenderExecutable,
          ['--background', '--factory-startup', '--python', inspection],
          { timeoutMs: 60_000 },
        );
        expect(reopened.code, `${reopened.stderr}\n${reopened.stdout}`).toBe(0);
        expect(reopened.stdout).toContain('FILMIE_CUTOUT_RUNTIME');
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }, 300_000);
  },
);
