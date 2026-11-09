import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defaultBlenderExecutable,
  runBlenderProcess,
} from '@filmmaking/engine-blender';
import { describe, expect, it } from 'vitest';

const blenderExecutable =
  process.env['FILMIE_BLENDER'] ?? defaultBlenderExecutable();
const blenderAvailable = existsSync(blenderExecutable);

describe.skipIf(!blenderAvailable)('Blender motion-curve runtime', () => {
  it('evaluates 3D replacement/additive curves deterministically and rejects collisions', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'filmie-motion-runtime-'));
    try {
      const script = join(temporary, 'motion-curves.py');
      await writeFile(
        script,
        `
import bpy, sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(resolve('engines/blender/worker'))})
import render_shot

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
