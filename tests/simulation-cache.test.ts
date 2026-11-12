import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ArtifactCache } from '@filmmaking/cache';
import { ProjectManifestSchema } from '@filmmaking/contracts';
import { BlenderRendererAdapter } from '@filmmaking/engine-blender';
import { compileScene } from '@filmmaking/scene';
import { expect, it } from 'vitest';
import {
  prepareSimulation,
  simulationDependency,
} from '../engines/blender/src/simulation-cache.js';

const manifest = () =>
  ProjectManifestSchema.parse(
    JSON.parse(
      readFileSync('examples/articulated-dynamics/manifest.json', 'utf8'),
    ),
  );
const workerDirectory = resolve('engines/blender/worker');
const dependency = async (
  scene: ReturnType<typeof compileScene>,
  build = 'test build',
) => (await simulationDependency(scene, workerDirectory, build))!;

it('keys Bullet artifacts on resolved physical inputs and ignores visual edits', async () => {
  const input = manifest();
  const shot = input.shots[0]!;
  const compile = () => compileScene(shot, input.video.frameRate);
  const initial = compile();
  const original = (await dependency(initial)).fingerprint;
  shot.scene!.lights[0]!.energy *= 2;
  const camera = shot.scene!.camera;
  if (camera.type !== 'static') throw new Error('Expected static camera');
  camera.distance += 1;
  shot.scene!.world!.materials[0]!.color = [1, 0, 0];
  const edited = compile();
  expect(edited.sha256).not.toBe(initial.sha256);
  expect((await dependency(edited)).fingerprint).toBe(original);
  expect(
    (await dependency(edited, 'different Bullet build')).fingerprint,
  ).not.toBe(original);
  for (const change of [
    (scene: typeof edited) => {
      scene.physics!.settings.gravity[2] -= 1;
    },
    (scene: typeof edited) => {
      scene.physics!.bodies[0]!.colliders[0]!.pose.position[0] += 1;
    },
    (scene: typeof edited) => {
      scene.physics!.joints![0]!.motorKeys[0]!.velocity += 1;
    },
    (scene: typeof edited) => {
      scene.physics!.bodies.find(
        (b) => b.entityId === 'hatch',
      )!.transitions[0]!.frame += 1;
    },
    (scene: typeof edited) => {
      scene.objectMotion = [
        {
          objectId: 'hatch',
          poses: [{ position: [0, 0, 0], rotation: [1, 0, 0, 0] }],
        },
      ];
    },
    (scene: typeof edited) => {
      scene.durationFrames += 1;
    },
    (scene: typeof edited) => {
      scene.frameRate.numerator += 1;
    },
  ]) {
    const changed = structuredClone(edited);
    change(changed);
    expect((await dependency(changed)).fingerprint).not.toBe(original);
  }
});

it('promotes only complete successful bakes and restores them without invoking the solver', async () => {
  const input = manifest();
  const scene = compileScene(input.shots[0]!, input.video.frameRate);
  const dep = await dependency(scene);
  const scratch = await mkdtemp(join(tmpdir(), 'filmie-simulation-cache-'));
  try {
    const cache = new ArtifactCache(join(scratch, 'cache'));
    const work = join(scratch, 'work');
    await mkdir(work);
    const valid = {
      version: 1,
      fingerprint: dep.fingerprint,
      backend: dep.input.backend,
      startFrame: 0,
      frameCount: scene.durationFrames,
      frameRate: scene.frameRate,
      space: 'world',
      tracks: Object.fromEntries(
        dep.movingIds.map((id) => [
          id,
          Array.from({ length: scene.durationFrames }, () => ({
            position: [0, 0, 0],
            rotation: [1, 0, 0, 0],
          })),
        ]),
      ),
    };
    await expect(
      prepareSimulation(dep, cache, work, async (args) => {
        await writeFile(args.at(-1)!, JSON.stringify(valid));
        throw new Error('Interrupted');
      }),
    ).rejects.toThrow('Interrupted');
    await expect(
      prepareSimulation(dep, cache, work, async (args) => {
        await writeFile(args.at(-1)!, JSON.stringify({ ...valid, tracks: {} }));
      }),
    ).rejects.toThrow('Incomplete or invalid');
    expect(
      await cache.restore(
        dep.fingerprint,
        'simulation/physics+json',
        join(work, 'probe.json'),
      ),
    ).toBeNull();
    expect(
      (
        await prepareSimulation(dep, cache, work, async (args) => {
          await writeFile(args.at(-1)!, JSON.stringify(valid));
        })
      ).cacheHit,
    ).toBe(false);
    const restored = await prepareSimulation(dep, cache, work, async () => {
      throw new Error('Unexpected bake');
    });

    expect(restored.cacheHit).toBe(true);
    expect(JSON.parse(await readFile(restored.path, 'utf8'))).toEqual(valid);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it('shares one bake result across concurrent isolated cache directories', async () => {
  const input = manifest();
  const scene = compileScene(input.shots[0]!, input.video.frameRate);
  const dep = await dependency(scene);
  const scratch = await mkdtemp(join(tmpdir(), 'filmie-simulation-isolated-'));
  try {
    const valid = {
      version: 1,
      fingerprint: dep.fingerprint,
      backend: dep.input.backend,
      startFrame: 0,
      frameCount: scene.durationFrames,
      frameRate: scene.frameRate,
      space: 'world',
      tracks: Object.fromEntries(
        dep.movingIds.map((id) => [
          id,
          Array.from({ length: scene.durationFrames }, () => ({
            position: [0, 0, 0],
            rotation: [1, 0, 0, 0],
          })),
        ]),
      ),
    };
    let bakes = 0;
    const run = async (args: string[]) => {
      bakes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(args.at(-1)!, JSON.stringify(valid));
    };
    await mkdir(join(scratch, 'work-a'));
    await mkdir(join(scratch, 'work-b'));
    const first = prepareSimulation(
      dep,
      new ArtifactCache(join(scratch, 'cache-a')),
      join(scratch, 'work-a'),
      run,
    );
    const second = prepareSimulation(
      dep,
      new ArtifactCache(join(scratch, 'cache-b')),
      join(scratch, 'work-b'),
      run,
    );
    const results = await Promise.all([first, second]);
    expect(bakes).toBe(1);
    expect(JSON.parse(await readFile(results[0]!.path, 'utf8'))).toEqual(valid);
    expect(JSON.parse(await readFile(results[1]!.path, 'utf8'))).toEqual(valid);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it.skipIf(process.env['FILMIE_BLENDER_SIM_CACHE_CHECK'] !== '1')(
  'renders two distinct visual revisions with the same headless Bullet bake',
  async () => {
    const input = manifest(),
      shot = input.shots[0]!;
    shot.durationFrames = 2;
    const world = shot.scene!.world!;
    world.joints!.forEach((j) => {
      j.motorKeys = [];
    });
    world.entities.find((e) => e.id === 'hatch')!.physics!.transitions = [];
    const scratch = await mkdtemp(join(tmpdir(), 'filmie-bullet-reuse-'));
    try {
      const adapter = new BlenderRendererAdapter();
      const render = async (name: string) => {
        const result = await adapter.renderShot({
          jobId: name,
          shot,
          scene: compileScene(shot, input.video.frameRate),
          assets: [],
          settings: input.renderPolicy,
          artifact: {
            type: 'image-sequence/png',
            outputDirectory: join(scratch, name),
          },
          randomSeed: 0,
          cacheDirectory: join(scratch, 'shots'),
          simulationCacheDirectory: join(scratch, 'simulations'),
          timeoutMs: 45_000,
        });
        if (result.status === 'failure')
          throw new Error(
            result.error.message + '\n' + result.receipt.logs.join('\n'),
          );
        expect(result.cacheHit).toBe(false);
        return result.receipt;
      };
      const first = await render('first');
      shot.scene!.lights[0]!.energy *= 2;
      const camera = shot.scene!.camera;
      if (camera.type !== 'static') throw new Error('Expected static camera');
      camera.distance += 1;
      const second = await render('second');
      expect(first.metrics.simulationCacheHit).toBe(false);
      expect(second.metrics.simulationCacheHit).toBe(true);
      expect(second.metrics.simulationFingerprint).toBe(
        first.metrics.simulationFingerprint,
      );
      expect(second.fingerprint).not.toBe(first.fingerprint);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
  120_000,
);
