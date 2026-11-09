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

describe.skipIf(!blenderAvailable)('Blender camera pan keyframes', () => {
  it('keys different camera rotations for a pan whose keyframes have different targets', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'filmie-camera-pan-'));
    try {
      const environmentPath = resolve(
        'examples/2.5d-proof/assets/backgrounds/interior-wide.png',
      );
      const spec = {
        randomSeed: 3,
        durationFrames: 12,
        outputDirectory: join(temporary, 'render'),
        frameRate: { numerator: 30, denominator: 1 },
        width: 320,
        height: 180,
        renderConfig: {
          engine: 'BLENDER_EEVEE',
          device: 'CPU',
          samples: 1,
          denoising: false,
          shadows: 'off',
          textures: 'low',
          compositing: false,
          frameRate: { numerator: 30, denominator: 1 },
        },
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
          paperFiberScale: 240,
          paperOpacity: 0.045,
          lineBoilStrength: 0.12,
        },
        environment: {
          assetId: 'background.interior-wide',
          version: '1.0.0',
          localPath: environmentPath,
          metadata: {},
        },
        groups: [],
        layers: [],
        characters: [],
        props: [],
        lights: [],
        camera: { type: 'static', distance: 6, target: { x: 0, y: 0, z: 0 } },
        cameraKeyframes: [
          {
            frame: 1,
            distance: 6,
            position: { x: 0, y: -6, z: 0 },
            target: { x: -2, y: 0, z: 0 },
            focalLength: 50,
          },
          {
            frame: 12,
            distance: 6,
            position: { x: 0, y: -6, z: 0 },
            target: { x: 2, y: 0, z: 0 },
            focalLength: 50,
          },
        ],
        animationLibraryVersion: '1.0.0',
      };
      const specPath = join(temporary, 'worker-spec.json');
      await writeFile(specPath, JSON.stringify(spec), 'utf8');
      const script = join(temporary, 'camera-pan.py');
      await writeFile(
        script,
        `
import bpy, sys, json
sys.path.insert(0, ${JSON.stringify(resolve('engines/blender/worker'))})
import render_shot

spec = json.load(open(sys.argv[sys.argv.index("--") + 1], "r", encoding="utf-8"))
render_shot.create_scene(spec)
camera = bpy.context.scene.camera

def rotation_at(frame):
    bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    return tuple(round(v, 6) for v in camera.matrix_world.to_euler())

start = rotation_at(1)
end = rotation_at(12)
assert any(abs(a - b) > 1e-4 for a, b in zip(start, end)), (start, end)
print('FILMIE_PAN_ROTATIONS', start, end, flush=True)
`,
        'utf8',
      );
      const result = await runBlenderProcess(
        blenderExecutable,
        [
          '--background',
          '--factory-startup',
          '--python',
          script,
          '--',
          specPath,
        ],
        { timeoutMs: 120_000 },
      );
      expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
      expect(result.stdout).toContain('FILMIE_PAN_ROTATIONS');
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 180_000);
});
