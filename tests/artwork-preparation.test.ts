import { mkdtemp, readFile, rm, writeFile, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArtworkPreparationSpecificationSchema } from '@filmmaking/contracts';
import { AssetRegistry, AssetVersionSchema } from '@filmmaking/assets';
import { prepareLayeredArtwork } from '../engines/blender/src/artwork.js';
import {
  defaultBlenderExecutable,
  runBlenderProcess,
} from '@filmmaking/engine-blender';

const sourceProject = resolve('examples/artwork-preparation-proof');
const blender = defaultBlenderExecutable();
const blenderAvailable = blender === 'blender' || existsSync(blender);

describe('layered artwork preparation contracts', () => {
  it('rejects broken parents and incomplete or mismatched facial variations', async () => {
    const specification = JSON.parse(
      await readFile(join(sourceProject, 'artwork-spec.json'), 'utf8'),
    ) as unknown;
    const parsed = ArtworkPreparationSpecificationSchema.parse(specification);
    expect(parsed.assets).toHaveLength(5);
    const character = parsed.assets.find((asset) => asset.kind === 'character');
    expect(character?.variantSlots).toHaveLength(2);
    expect(() =>
      ArtworkPreparationSpecificationSchema.parse({
        ...parsed,
        assets: [
          {
            ...character,
            groups: [
              {
                id: 'a',
                parentId: 'b',
                transform: {
                  position: { x: 0, y: 0, z: 0 },
                  rotationDegrees: { x: 0, y: 0, z: 0 },
                  scale: 1,
                },
              },
              {
                id: 'b',
                parentId: 'a',
                transform: {
                  position: { x: 0, y: 0, z: 0 },
                  rotationDegrees: { x: 0, y: 0, z: 0 },
                  scale: 1,
                },
              },
            ],
          },
        ],
      }),
    ).toThrow(/cycle/i);
    expect(() =>
      ArtworkPreparationSpecificationSchema.parse({
        ...parsed,
        assets: [
          {
            ...character,
            variantSlots: [
              {
                id: 'face.eyes',
                defaultVariant: 'missing',
                variants: [
                  { id: 'calm', layerIds: ['eyes-calm'] },
                  { id: 'alarmed', layerIds: ['eyes-alarmed'] },
                ],
              },
            ],
          },
        ],
      }),
    ).toThrow(/default variant/i);
  });

  it.skipIf(!blenderAvailable)(
    'prepares reusable packages and verifies rig, alpha, variants, anchors, scene import, and saved-scene reload in Blender',
    async () => {
      const project = await mkdtemp(join(tmpdir(), 'filmie-artwork-proof-'));
      try {
        await cp(join(sourceProject, 'artwork'), join(project, 'artwork'), {
          recursive: true,
        });
        const allRecords = JSON.parse(
          await readFile(join(sourceProject, 'assets.json'), 'utf8'),
        ) as unknown[];
        const sourceRecords = allRecords
          .filter((entry) => (entry as { type?: unknown }).type === 'image')
          .map((entry) => AssetVersionSchema.parse(entry));
        const registry = new AssetRegistry(sourceRecords);
        expect(registry.list()).toHaveLength(17);
        await writeFile(
          join(project, 'assets.json'),
          `${JSON.stringify(sourceRecords, null, 2)}\n`,
        );
        const specification = await readFile(
          join(sourceProject, 'artwork-spec.json'),
          'utf8',
        );
        const validSpecification = JSON.parse(specification) as {
          assets: {
            layers: { source: { assetId: string; version: string } }[];
          }[];
        };
        const missingVersion = structuredClone(validSpecification);
        const missingLayer = missingVersion.assets[0]?.layers[0];
        if (!missingLayer)
          throw new Error('Proof specification has no artwork layer.');
        missingLayer.source.version = '9.9.9';
        await writeFile(
          join(project, 'artwork-spec.json'),
          JSON.stringify(missingVersion),
        );
        await expect(
          prepareLayeredArtwork({
            projectDirectory: project,
            timeoutMs: 30_000,
          }),
        ).rejects.toThrow(/not registered/i);

        const firstSource = sourceRecords[0];
        if (!firstSource) throw new Error('Proof source registry is empty.');
        const invalidPath = join(
          project,
          'artwork',
          'unsupported-extension.jpg',
        );
        await writeFile(
          invalidPath,
          await readFile(join(project, firstSource.sourceUri)),
        );
        const unsupportedImage = {
          ...firstSource,
          assetId: 'art.invalid-extension',
          sourceUri: 'artwork/unsupported-extension.jpg',
        };
        const invalidRegistry = [...sourceRecords, unsupportedImage];
        await writeFile(
          join(project, 'assets.json'),
          JSON.stringify(invalidRegistry),
        );
        const invalidExtension = structuredClone(validSpecification);
        const invalidLayer = invalidExtension.assets[0]?.layers[0];
        if (!invalidLayer)
          throw new Error('Proof specification has no artwork layer.');
        invalidLayer.source.assetId = unsupportedImage.assetId;
        await writeFile(
          join(project, 'artwork-spec.json'),
          JSON.stringify(invalidExtension),
        );
        await expect(
          prepareLayeredArtwork({
            projectDirectory: project,
            timeoutMs: 30_000,
          }),
        ).rejects.toThrow(/must be a PNG/i);

        await writeFile(
          join(project, 'assets.json'),
          JSON.stringify(sourceRecords),
        );
        await writeFile(join(project, 'artwork-spec.json'), specification);

        const prepared = await prepareLayeredArtwork({
          projectDirectory: project,
          timeoutMs: 300_000,
        });
        expect(prepared.createdAssetIds.sort()).toEqual([
          'character.father-cutout',
          'environment.moonlit-room',
          'prop.kerosene-lantern-illustration',
          'prop.rotary-telephone-illustration',
          'prop.wooden-chair',
        ]);
        const reuse = await prepareLayeredArtwork({
          projectDirectory: project,
          timeoutMs: 30_000,
        });
        expect(reuse.createdAssetIds).toEqual([]);
        expect(reuse.reusedAssetIds).toHaveLength(5);
        for (const record of prepared.assets) AssetVersionSchema.parse(record);

        const father = prepared.assets.find(
          (asset) => asset.assetId === 'character.father-cutout',
        );
        const room = prepared.assets.find(
          (asset) => asset.assetId === 'environment.moonlit-room',
        );
        expect(father).toBeDefined();
        expect(room).toBeDefined();
        const fatherPath = resolve(project, father!.sourceUri);
        const roomPath = resolve(project, room!.sourceUri);
        const buildSceneScript = join(project, 'load_and_render.py');
        const buildSceneResultPath = join(project, 'scene-result.json');
        const savedScene = join(project, 'prepared-scene.blend');
        const python = String.raw`import bpy, hashlib, json, math, os, sys
from mathutils import Vector
spec_path = sys.argv[sys.argv.index('--') + 1]
spec = json.load(open(spec_path, 'r', encoding='utf-8'))
def append_collection(path, name):
    with bpy.data.libraries.load(path, link=False) as (source, target):
        if name not in source.collections: raise RuntimeError('Missing prepared collection: ' + name)
        target.collections = [name]
    collection = target.collections[0]
    bpy.context.scene.collection.children.link(collection)
    return collection
def rendered_pixel_hash(path):
    image = bpy.data.images.load(path, check_existing=False)
    packed = bytes(int(max(0, min(1, value)) * 255) for value in image.pixels)
    digest = hashlib.sha256(packed).hexdigest()
    bpy.data.images.remove(image)
    return digest
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.eevee.taa_render_samples = 1
for existing in list(bpy.data.objects): bpy.data.objects.remove(existing, do_unlink=True)
scene.render.resolution_x = 320
scene.render.resolution_y = 180
scene.render.resolution_percentage = 100
father = append_collection(spec['fatherPath'], 'ASSET__character_father_cutout')
room = append_collection(spec['roomPath'], 'ASSET__environment_moonlit_room')
root = next(obj for obj in father.objects if obj.get('filmie_asset_id') == 'character.father-cutout')
root.location = (-0.2, 0.0, -0.4)
room_root = next(obj for obj in room.objects if obj.get('filmie_asset_id') == 'environment.moonlit-room')
root_objects = {obj.get('filmie_node_id'): obj for obj in father.objects if obj.get('filmie_node_id')}
assert root_objects['rig.head'].parent is root_objects['rig.torso']
assert root_objects['arm-left'].parent is root_objects['rig.arm.left']
anchor = next(obj for obj in father.objects if obj.get('filmie_anchor_id') == 'hand.left')
assert anchor.parent == root_objects['rig.arm.left']
pivot = next(obj for obj in father.objects if obj.get('filmie_layer_id') == 'head')
sprite = next(obj for obj in father.objects if obj.get('filmie_layer_id') == 'head' and obj.type == 'MESH')
assert sprite.parent == pivot
assert json.loads(pivot['filmie_pivot']) == {'x': 0.5, 'y': 0.45}
images = [image for image in bpy.data.images if image.packed_file]
assert images and all(image.packed_file is not None for image in images)
assert any(image.channels == 4 and min(image.pixels[3::4]) < 0.99 for image in images)
eyes_calm = next(obj for obj in father.objects if obj.name == 'SPRITE__eyes-calm')
eyes_alarm = next(obj for obj in father.objects if obj.name == 'SPRITE__eyes-alarmed')
hair_pivot = next(obj for obj in father.objects if obj.name == 'PIVOT__hair')
eyes_pivot = next(obj for obj in father.objects if obj.name == 'PIVOT__eyes-calm')
assert eyes_pivot.location.y < hair_pivot.location.y
sys.path.insert(0, spec['runtimePath'])
from artwork_runtime import set_artwork_variant
cam_data = bpy.data.cameras.new('ProofCamera')
cam_data.type = 'ORTHO'
cam_data.ortho_scale = 8.0
camera = bpy.data.objects.new('ProofCamera', cam_data)
scene.collection.objects.link(camera)
camera.location = (0, -8, 0)
camera.rotation_euler = (Vector((0, 0, 0)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
scene.camera = camera
scene.view_settings.view_transform = 'Standard'
scene.render.image_settings.file_format = 'PNG'
scene.frame_set(1)
bpy.context.view_layer.update()
default_eval = bpy.context.evaluated_depsgraph_get()
assert not eyes_calm.hide_render
assert eyes_alarm.hide_render
os.makedirs(spec['outputDirectory'], exist_ok=True)
scene.render.filepath = os.path.join(spec['outputDirectory'], 'calm.png')
bpy.ops.render.render(write_still=True)
calm_hash = rendered_pixel_hash(scene.render.filepath)
set_artwork_variant(root, 'face.eyes', 'alarmed')
set_artwork_variant(root, 'face.mouth', 'alarmed')
scene.frame_set(2)
bpy.context.view_layer.update()
variant_eval = bpy.context.evaluated_depsgraph_get()
assert eyes_calm.hide_render
assert not eyes_alarm.hide_render
scene.render.filepath = os.path.join(spec['outputDirectory'], 'alarmed.png')
bpy.ops.render.render(write_still=True)
alarmed_hash = rendered_pixel_hash(scene.render.filepath)
set_artwork_variant(root, 'face.eyes', 'calm')
set_artwork_variant(root, 'face.mouth', 'calm')
arm = root_objects['rig.arm.left']
arm.rotation_euler.z += math.radians(28)
scene.frame_set(3)
bpy.context.view_layer.update()
scene.render.filepath = os.path.join(spec['outputDirectory'], 'arm-pivot.png')
bpy.ops.render.render(write_still=True)
arm_hash = rendered_pixel_hash(scene.render.filepath)
arm.rotation_euler.z -= math.radians(28)
scene.frame_set(1)
bpy.context.view_layer.update()
bpy.ops.wm.save_as_mainfile(filepath=spec['savedScene'])
with open(spec['resultPath'], 'w', encoding='utf-8') as stream:
    json.dump({'status':'success','objects':len(father.objects),'packedImages':len(images),'calmHash':calm_hash,'alarmedHash':alarmed_hash,'armHash':arm_hash}, stream)
`;
        await writeFile(buildSceneScript, python, { flag: 'wx' });
        const outputDirectory = join(project, 'variant-renders');
        await mkdir(outputDirectory);
        const workerSpec = join(project, 'separate-scene.json');
        await writeFile(
          workerSpec,
          JSON.stringify({
            fatherPath,
            roomPath,
            runtimePath: resolve('engines/blender/worker'),
            savedScene,
            resultPath: buildSceneResultPath,
            outputDirectory,
          }),
          { flag: 'wx' },
        );
        const build = await runBlenderProcess(
          blender,
          [
            '--background',
            '--factory-startup',
            '--python',
            buildSceneScript,
            '--',
            workerSpec,
          ],
          { timeoutMs: 180_000 },
        );
        expect(build.code, build.stderr || build.stdout).toBe(0);
        expect(
          existsSync(buildSceneResultPath),
          build.stderr || build.stdout,
        ).toBe(true);
        const result = JSON.parse(
          await readFile(buildSceneResultPath, 'utf8'),
        ) as {
          status: string;
          objects: number;
          packedImages: number;
          calmHash: string;
          alarmedHash: string;
          armHash: string;
        };
        expect(result.status).toBe('success');
        expect(result.objects).toBeGreaterThan(10);
        expect(result.packedImages).toBeGreaterThanOrEqual(9);
        expect(result.calmHash).not.toBe(result.alarmedHash);
        expect(result.calmHash).not.toBe(result.armHash);
        const calm = await readFile(join(outputDirectory, 'calm.png'));
        const alarmed = await readFile(join(outputDirectory, 'alarmed.png'));
        expect(calm.equals(alarmed)).toBe(false);

        const reopenScript = join(project, 'reopen_and_render.py');
        const reopenedFrame = join(outputDirectory, 'reopened.png');
        await writeFile(
          reopenScript,
          String.raw`import bpy, json, os, sys
spec = json.load(open(sys.argv[sys.argv.index('--') + 1], 'r', encoding='utf-8'))
bpy.ops.wm.open_mainfile(filepath=spec['savedScene'])
scene = bpy.context.scene
scene.render.filepath = spec['reopenedFrame']
bpy.ops.render.render(write_still=True)
print('FILMIE_REOPEN_RENDER_OK')
`,
          { flag: 'wx' },
        );
        const reopenSpec = join(project, 'reopen.json');
        await writeFile(
          reopenSpec,
          JSON.stringify({ savedScene, reopenedFrame }),
          { flag: 'wx' },
        );
        const reopen = await runBlenderProcess(
          blender,
          ['--background', '--python', reopenScript, '--', reopenSpec],
          { timeoutMs: 120_000 },
        );
        expect(reopen.code, reopen.stderr || reopen.stdout).toBe(0);
        expect(existsSync(reopenedFrame)).toBe(true);
        expect((await readFile(reopenedFrame)).length).toBeGreaterThan(1000);
      } finally {
        if (process.env['FILMIE_KEEP_ARTWORK_TEST'] !== '1')
          await rm(project, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
