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
const blenderAvailable = existsSync(blenderExecutable);

describe.skipIf(!blenderAvailable)('Blender 2.5D artwork runtime', () => {
  it('imports alpha artwork, evaluates hierarchy/pivots/depth/camera, saves, reopens, and rerenders', async () => {
    const projectDirectory = resolve('examples/2.5d-proof');
    const manifest = parseProjectManifest(
      JSON.parse(
        await readFile(join(projectDirectory, 'manifest.json'), 'utf8'),
      ) as unknown,
    );
    const shot = manifest.shots[0];
    if (!shot?.scene) throw new Error('Missing structured 2.5D proof scene.');
    const references = shot.requiredAssets;
    const registry = new AssetRegistry(
      JSON.parse(
        await readFile(join(projectDirectory, 'assets.json'), 'utf8'),
      ) as unknown[],
    );
    const assets = await resolveAssetFiles(
      references,
      registry,
      projectDirectory,
    );
    const assetByVersion = new Map(
      assets.map((asset) => [`${asset.assetId}\u0000${asset.version}`, asset]),
    );
    const compiled = compileScene(shot, manifest.video.frameRate);
    const required = (reference: { assetId: string; version: string }) => {
      const asset = assetByVersion.get(
        `${reference.assetId}\u0000${reference.version}`,
      );
      if (!asset)
        throw new Error(
          `Missing proof asset ${reference.assetId}@${reference.version}`,
        );
      return asset;
    };
    const temporary = await mkdtemp(join(tmpdir(), 'filmie-2.5d-runtime-'));
    try {
      const outputDirectory = join(temporary, 'render');
      await writeFile(
        join(temporary, 'worker-spec.json'),
        JSON.stringify({
          durationFrames: 1,
          frameRate: manifest.video.frameRate,
          width: 320,
          height: 180,
          samples: 1,
          randomSeed: 5,
          outputDirectory,
          style: compiled.style,
          animationLibraryVersion: compiled.animationLibraryVersion,
          environment: required(compiled.environment),
          groups: compiled.groups,
          layers: compiled.layers.map((layer) => ({
            ...layer,
            asset: required(layer.asset),
          })),
          characters: [],
          props: [],
          lights: compiled.lights,
          camera: compiled.camera,
          cameraKeyframes: compiled.cameraKeyframes,
          actions: compiled.actions,
          motionCurves: compiled.motionCurves,
        }),
        'utf8',
      );
      const worker = await runBlenderProcess(
        blenderExecutable,
        [
          '--background',
          '--factory-startup',
          '--python',
          resolve('engines/blender/worker/render_shot.py'),
          '--',
          join(temporary, 'worker-spec.json'),
        ],
        { timeoutMs: 180_000 },
      );
      expect(worker.code, `${worker.stderr}\n${worker.stdout}`).toBe(0);
      expect(worker.stderr).not.toContain('FILMIE_GLOW_SKIPPED');
      const workerResult = JSON.parse(
        await readFile(join(outputDirectory, 'worker-result.json'), 'utf8'),
      ) as { status: string; blendPath: string; frameCount: number };
      expect(workerResult).toMatchObject({ status: 'success', frameCount: 1 });
      expect(
        (await stat(join(outputDirectory, 'frames', 'frame_000001.png'))).size,
      ).toBeGreaterThan(0);
      expect(existsSync(workerResult.blendPath)).toBe(true);

      const reopenScript = join(temporary, 'reopen-and-verify.py');
      await writeFile(
        reopenScript,
        `
import bpy, sys, hashlib, struct
sys.path.insert(0, ${JSON.stringify(resolve('engines/blender/worker'))})
import render_shot
bpy.ops.wm.open_mainfile(filepath=${JSON.stringify(workerResult.blendPath)})
daughter = bpy.data.objects['LAYER__layer.daughter']
daughter_sprite = bpy.data.objects['ARTWORK__layer.daughter']
phone = bpy.data.objects['LAYER__layer.telephone']
assert daughter.parent.name == 'GROUP__group.window-character'
assert daughter_sprite.parent == daughter
assert abs(min(vertex.co.z for vertex in daughter_sprite.data.vertices)) < 1e-5
assert abs(daughter.location.y - (-0.01)) < 1e-5
assert phone.location.y < daughter.matrix_world.translation.y
image_node = next(node for material in daughter_sprite.data.materials for node in material.node_tree.nodes if node.type == 'TEX_IMAGE')
alpha = list(image_node.image.pixels)[3::4]
assert min(alpha) < 0.01 and max(alpha) > 0.99
camera = bpy.context.scene.camera
bpy.context.scene.frame_set(1); bpy.context.view_layer.update()
start_y = camera.matrix_world.translation.y
bpy.context.scene.frame_set(24); bpy.context.view_layer.update()
end_y = camera.matrix_world.translation.y
assert start_y < end_y, (start_y, end_y)
assert not any(group.name == 'Filmie Fog Glow' for group in bpy.data.node_groups)
grain_curves = [curve for material in bpy.data.materials if material.node_tree and material.node_tree.animation_data and material.node_tree.animation_data.action for curve in render_shot.action_fcurves(material.node_tree.animation_data.action) if 'default_value' in curve.data_path and 'Noise Texture' in curve.data_path]
assert grain_curves, 'No saved grain boil FCurves were found'
assert all(point.interpolation == 'CONSTANT' for curve in grain_curves for point in curve.keyframe_points)
paper = bpy.data.objects['ScreenFixedPaper']
assert paper.parent == camera
original_visibility = {obj: obj.hide_render for obj in bpy.context.scene.objects}
for obj in bpy.context.scene.objects: obj.hide_render = obj != paper and obj != camera
paper_samples = []
for frame in (1, 24):
    bpy.context.scene.frame_set(frame)
    bpy.ops.render.render()
    pixels = bpy.data.images['Render Result'].pixels[:]
    paper_samples.append(hashlib.sha256(b''.join(struct.pack('<f', value) for value in pixels)).hexdigest())
assert paper_samples[0] == paper_samples[1], paper_samples
for obj, hidden in original_visibility.items(): obj.hide_render = hidden
bpy.context.scene.render.filepath = ${JSON.stringify(join(temporary, 'reopened-frame.png'))}
bpy.ops.render.render(write_still=True)
print('FILMIE_2_5D_REOPENED', tuple(round(v, 4) for v in daughter.matrix_world.translation), round(start_y, 4), round(end_y, 4), flush=True)
`,
        'utf8',
      );
      const reopened = await runBlenderProcess(
        blenderExecutable,
        ['--background', '--factory-startup', '--python', reopenScript],
        { timeoutMs: 120_000 },
      );
      expect(reopened.code, `${reopened.stderr}\n${reopened.stdout}`).toBe(0);
      expect(`${reopened.stdout}\n${reopened.stderr}`).toContain(
        'FILMIE_2_5D_REOPENED',
      );
      expect(
        (await stat(join(temporary, 'reopened-frame.png'))).size,
      ).toBeGreaterThan(0);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 360_000);
});
