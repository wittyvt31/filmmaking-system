import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canonicalJsonSha256,
  RigidTransformSchema,
  type CompiledSceneInstruction,
} from '@filmmaking/contracts';
import { ArtifactCache } from '@filmmaking/cache';

const artifactType = 'simulation/physics+json';
const worker = 'bake_simulation.py';
export async function simulationDependency(
  scene: CompiledSceneInstruction,
  workerDirectory: string,
  blenderBuild: string,
) {
  const simulation = scene.physics;
  if (!simulation) return;
  const movingIds = simulation.bodies
    .filter((body) => body.properties.mode !== 'static')
    .map((body) => body.entityId)
    .sort();
  if (!movingIds.length) return;
  const dependencies = await Promise.all(
    [
      worker,
      'physics_backend.py',
      'world_builder.py',
      'animation_curves.py',
    ].map(async (file) =>
      createHash('sha256')
        .update(await readFile(join(workerDirectory, file)))
        .digest('hex'),
    ),
  );
  const backend = canonicalJsonSha256({
    solver: 'Blender Bullet',
    blenderBuild,
    platform: process.platform,
    arch: process.arch,
    dependencies,
  });
  // The compiler has already resolved collider geometry, follower motion and release schedules.
  const input = {
    version: 1,
    backend,
    simulation: {
      ...simulation,
      bodies: simulation.bodies.map((body) => ({
        entityId: body.entityId,
        initialPose: body.initialPose,
        properties: body.properties,
        colliders: body.colliders,
        transitions: body.transitions,
        keyframes: body.keyframes,
      })),
    },
    objectMotion: (scene.objectMotion ?? []).filter((track) =>
      movingIds.includes(track.objectId),
    ),
    frameRate: scene.frameRate,
    startFrame: 0,
    frameCount: scene.durationFrames,
  };
  return {
    input,
    movingIds,
    fingerprint: canonicalJsonSha256(input),
    workerPath: join(workerDirectory, worker),
  };
}
type Dependency = NonNullable<Awaited<ReturnType<typeof simulationDependency>>>;
const inFlight = new Map<string, Promise<void>>();

async function validArtifact(
  path: string,
  dependency: Dependency,
): Promise<boolean> {
  try {
    const artifact = JSON.parse(await readFile(path, 'utf8'));
    const { input, fingerprint, movingIds } = dependency;
    if (
      artifact.version !== 1 ||
      artifact.fingerprint !== fingerprint ||
      artifact.backend !== input.backend ||
      artifact.startFrame !== 0 ||
      artifact.frameCount !== input.frameCount ||
      artifact.space !== 'world' ||
      artifact.frameRate?.numerator !== input.frameRate.numerator ||
      artifact.frameRate?.denominator !== input.frameRate.denominator ||
      !artifact.tracks ||
      JSON.stringify(Object.keys(artifact.tracks).sort()) !==
        JSON.stringify(movingIds)
    )
      return false;
    return movingIds.every((id) => {
      const poses: unknown = artifact.tracks[id];
      return (
        Array.isArray(poses) &&
        poses.length === input.frameCount &&
        poses.every((pose) => RigidTransformSchema.safeParse(pose).success)
      );
    });
  } catch {
    return false;
  }
}

async function bakeSimulation(
  dependency: Dependency,
  cache: ArtifactCache,
  run: (args: string[]) => Promise<void>,
) {
  const { fingerprint, input, workerPath } = dependency;
  await mkdir(cache.directory, { recursive: true });
  const scratch = await mkdtemp(
    join(cache.directory, `simulation-${fingerprint}-`),
  );
  try {
    const specPath = join(scratch, 'spec.json');
    const result = join(scratch, 'simulation.json');
    await writeFile(specPath, JSON.stringify({ ...input, fingerprint }));
    await run([
      '--background',
      '--factory-startup',
      '--python-exit-code',
      '1',
      '--python',
      workerPath,
      '--',
      specPath,
      result,
    ]);
    if (!(await validArtifact(result, dependency)))
      throw new Error('Incomplete or invalid Bullet simulation artifact');
    await cache.store(fingerprint, artifactType, result);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function prepareSimulation(
  dependency: Dependency,
  cache: ArtifactCache,
  workDirectory: string,
  run: (args: string[]) => Promise<void>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const { fingerprint } = dependency;
  const path = join(workDirectory, 'simulation.json');
  if (
    (await cache.restore(fingerprint, artifactType, path)) &&
    (await validArtifact(path, dependency))
  ) {
    signal?.throwIfAborted();
    return { path, cacheHit: true };
  }
  let task = inFlight.get(fingerprint);
  let cacheHit = true;
  if (!task) {
    cacheHit = false;
    task = bakeSimulation(dependency, cache, run);
    inFlight.set(fingerprint, task);
    void task.then(
      () => {
        if (inFlight.get(fingerprint) === task) inFlight.delete(fingerprint);
      },
      () => {
        if (inFlight.get(fingerprint) === task) inFlight.delete(fingerprint);
      },
    );
  }
  await task;
  signal?.throwIfAborted();
  if (
    !(await cache.restore(fingerprint, artifactType, path)) ||
    !(await validArtifact(path, dependency))
  )
    throw new Error('Simulation cache entry was not available after baking');
  return { path, cacheHit };
}
