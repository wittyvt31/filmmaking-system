import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defaultBlenderExecutable,
  runBlenderProcess,
} from '@filmmaking/engine-blender';
import { describe, expect, it } from 'vitest';
import {
  MotionClipLibrarySchema,
  parseProjectManifest,
} from '@filmmaking/contracts';
import { compileScene } from '@filmmaking/scene';

const blenderExecutable =
  process.env['FILMIE_BLENDER'] ?? defaultBlenderExecutable();
const blenderAvailable = existsSync(blenderExecutable);

describe.skipIf(!blenderAvailable)('Blender motion-curve runtime', () => {
  it('evaluates 3D replacement/additive curves deterministically and rejects collisions', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'filmie-motion-runtime-'));
    try {
      const manifest = parseProjectManifest(
        JSON.parse(
          await readFile(
            resolve('examples/reference-shot/father-motion/manifest.json'),
            'utf8',
          ),
        ),
      );
      const shot = manifest.shots[0]!;
      const library = MotionClipLibrarySchema.parse({
        schemaVersion: '1.0.0',
        libraryId: 'test.motion',
        version: '1.0.0',
        clips: [
          {
            id: 'test.ease',
            durationFrames: 5,
            tracks: [
              {
                control: 'head',
                channel: 'rotation',
                keyframes: [
                  { frame: 0, value: [0, 0, 0], interpolation: 'ease-in-out' },
                  { frame: 4, value: [0, 0.08, 0] },
                ],
              },
            ],
          },
        ],
      });
      shot.scene!.characters[0]!.actions = [
        {
          id: 'test.action',
          type: 'motion-clip',
          startFrame: 0,
          endFrame: 5,
          library: { assetId: library.libraryId, version: library.version },
          clipId: 'test.ease',
          playbackRate: 1,
          blendMode: 'replace',
        },
      ];
      const compiled = compileScene(shot, manifest.video.frameRate, [library]);
      const script = join(temporary, 'motion-curves.py');
      await writeFile(
        script,
        `
import bpy, json, runpy, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(resolve('engines/blender/worker'))})
import render_shot

framing = {'width':640,'height':360,'cameraKeyframes':[{'focalLength':50,'distance':6},{'focalLength':50,'distance':4.4}]}
plane_scale = render_shot.source_framing(framing, (531, 266), 6)
assert abs(plane_scale - 1.2636) < 1e-8
assert framing['sourceFraming']['sourceLimited']
assert abs(framing['sourceFraming']['upscaleRelativeToFit'] - 1.04 * 6 / 4.4) < 1e-8
framing['cameraKeyframes'][-1]['distance'] = 2
try:
    render_shot.source_framing(framing, (531, 266), 6)
except RuntimeError as error:
    assert 'twice' in str(error)
else:
    raise AssertionError('Source zoom cap was ignored')

scene = bpy.context.scene
root = bpy.data.objects.new('motion-root', None)
scene.collection.objects.link(root)
root.location = (1.0, 2.0, 3.0)
render_shot.apply_motion_curves({
    'motionCurves': [
        {'characterId':'actor','control':'root','channel':'location','frame':0,'value':[0,0,0],'blendMode':'replace'},
        {'characterId':'actor','control':'root','channel':'location','frame':2,'value':[2,4,6],'blendMode':'replace'},
    ]
}, {}, {'actor':root})
scene.frame_set(1); bpy.context.view_layer.update()
replace_start = tuple(round(v, 4) for v in root.matrix_world.translation)
scene.frame_set(2); bpy.context.view_layer.update()
replace_mid = tuple(round(v, 4) for v in root.matrix_world.translation)
scene.frame_set(3); bpy.context.view_layer.update()
replace_end = tuple(round(v, 4) for v in root.matrix_world.translation)
assert replace_start == (0.0, 0.0, 0.0), replace_start
assert replace_mid == (1.0, 2.0, 3.0), replace_mid
assert replace_end == (2.0, 4.0, 6.0), replace_end
replacement_snapshot = (replace_start, replace_mid, replace_end)
replacement_repeat = []
for frame in (1, 2, 3):
    scene.frame_set(frame); bpy.context.view_layer.update()
    replacement_repeat.append(tuple(round(v, 4) for v in root.matrix_world.translation))
assert tuple(replacement_repeat) == replacement_snapshot

root.animation_data_clear()
root.location = (1.0, 2.0, 3.0)
render_shot.apply_motion_curves({
    'motionCurves': [
        {'characterId':'actor','control':'root','channel':'location','frame':0,'value':[0,0,0],'blendMode':'additive'},
        {'characterId':'actor','control':'root','channel':'location','frame':2,'value':[1,0,-1],'blendMode':'additive'},
    ]
}, {}, {'actor':root})
scene.frame_set(1); bpy.context.view_layer.update()
additive_start = tuple(round(v, 4) for v in root.matrix_world.translation)
scene.frame_set(2); bpy.context.view_layer.update()
additive_mid = tuple(round(v, 4) for v in root.matrix_world.translation)
scene.frame_set(3); bpy.context.view_layer.update()
additive_end = tuple(round(v, 4) for v in root.matrix_world.translation)
assert additive_start == (1.0, 2.0, 3.0), additive_start
assert additive_mid == (1.5, 2.0, 2.5), additive_mid
assert additive_end == (2.0, 2.0, 2.0), additive_end

head = bpy.data.objects.new('head-pivot', None)
scene.collection.objects.link(head)
render_shot.apply_motion_curves({'motionCurves':${JSON.stringify(compiled.motionCurves)}}, {'father': {'head': head}}, {})
for frame, expected in ((1, 0), (2, .0125), (3, .04), (4, .0675), (5, .08), (6, .08)):
    scene.frame_set(frame)
    assert abs(head.rotation_euler.y - expected) < 1e-6, (frame, head.rotation_euler.y)

def png(name, pixels):
    image = bpy.data.images.new(name, width=12, height=12, alpha=True)
    image.pixels.foreach_set(pixels)
    image.filepath_raw = str(Path(${JSON.stringify(temporary)}) / (name + '.png'))
    image.file_format = 'PNG'
    image.save()
    return image.filepath_raw

source_path = png('source', [1.0] * (12 * 12 * 4))
matte_pixels = []
for y in range(12):
    for x in range(12):
        white = float((4 <= x <= 7 and 4 <= y <= 7) or (x == 0 and y == 0))
        matte_pixels.extend((white, white, white, 1.0))
matte_path = png('matte', matte_pixels)
matte_layer = {
    'id':'test.matte', 'source':{'localPath':source_path,'assetId':'source','version':'1.0.0','contentHash':'source'},
    'manualMatte':{'localPath':matte_path},
    'processing':{'smoothingPasses':1,'removeIslandsBelowPixels':4},
    'size':{'width':1,'height':1},'pivot':{'x':.5,'y':.5},'opacity':1,'order':0,
    'transform':{'position':{'x':0,'y':0,'z':0},'rotationDegrees':{'x':0,'y':0,'z':0},'scale':1},
}
matte_spec = Path(${JSON.stringify(temporary)}) / 'matte-spec.json'
matte_spec.write_text(json.dumps({
    'assets':[{'assetId':'test.matte','version':'1.0.0','kind':'character','displayName':'Matte fixture',
               'groups':[],'layers':[matte_layer],'anchors':[],'variantSlots':[]}],
    'style':{'palette':{'shadow':[0,0,0],'paper':[1,1,1],'graphite':[.5,.5,.5]}},
    'outputDirectory':str(matte_spec.parent / 'prepared'),
}), encoding='utf-8')
sys.argv.extend(['--', str(matte_spec)])
runpy.run_path(str(Path(sys.path[0]) / 'prepare_artwork.py'), run_name='__main__')
sprite = bpy.data.objects['SPRITE__test.matte']
image = next(node.image for node in sprite.data.materials[0].node_tree.nodes if node.type == 'TEX_IMAGE')
assert sprite['filmie_prepared_matte'] and image.packed_file
assert image.pixels[3] == 0, 'Isolated matte pixel survived processing'
assert 0.25 < image.pixels[(5 * 12 + 3) * 4 + 3] < 0.4, 'Expected a smoothed matte edge'
assert image.pixels[(5 * 12 + 5) * 4 + 3] == 1, 'Matte erased solid interior'

def must_reject(curves, expected):
    try:
        render_shot.apply_motion_curves({'motionCurves':curves}, {}, {'actor':root})
    except RuntimeError as error:
        assert expected in str(error), str(error)
    else:
        raise AssertionError('Expected rejection: ' + expected)

base = {'characterId':'actor','control':'root','channel':'location','frame':1,'value':[0,0,0]}
must_reject([dict(base, blendMode='replace'), dict(base, blendMode='replace')], 'same frame')
must_reject([dict(base, blendMode='replace'), dict(base, blendMode='additive')], 'mix replacement and additive')
print('FILMIE_MOTION_RUNTIME', replace_start, replace_mid, replace_end, additive_start, additive_mid, additive_end, flush=True)
`,
        'utf8',
      );
      const result = await runBlenderProcess(
        blenderExecutable,
        ['--background', '--factory-startup', '--python', script],
        { timeoutMs: 60_000 },
      );
      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain('FILMIE_MOTION_RUNTIME');
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 90_000);
});
