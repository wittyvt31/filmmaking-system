import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { defaultBlenderExecutable } from '@filmmaking/engine-blender';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFilmieServer } from '../apps/web-api/src/server.js';
import type {
  Output,
  ProjectSummary,
  Run,
  Validation,
} from '../apps/web-api/src/types.js';

let root: string;
let server: Server;
let base: string;

async function start() {
  server = createFilmieServer({
    dataDirectory: join(root, 'data'),
    outputDirectory: join(root, 'outputs'),
    cacheDirectory: join(root, 'cache'),
    catalogsDirectory: resolve('examples'),
    webDirectory: join(root, 'web'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Server did not bind a port');
  base = 'http://127.0.0.1:' + address.port;
}

async function stop() {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'filmie-web-'));
  await start();
});

afterEach(async () => {
  await stop();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function request(path: string, payload?: object, expected = 200) {
  const response = await fetch(
    base + '/api/' + path,
    payload
      ? {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'Content-Type': 'application/json' },
        }
      : {},
  );
  const data: unknown = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(expected);
  return data;
}

async function createProject() {
  const project = (await request(
    'projects',
    { name: 'Reference', catalog: '3d-production' },
    201,
  )) as ProjectSummary;
  const path = 'projects/' + project.id;
  const revision = project.revisions[0]!.id;
  const { text } = (await request(path + '/revisions/' + revision)) as {
    text: string;
  };
  return { path, revision, text };
}

it('validates reference assets, persists revisions, rejects stale saves, and duplicates an older revision', async () => {
  const { path, revision, text } = await createProject();
  expect(await request(path + '/validate', { text })).toEqual({
    issues: [],
    frames: 90,
    shots: 1,
  });
  const invalid = (await request(path + '/validate', {
    text: '{}',
  })) as Validation;
  expect(invalid.issues.some((issue) => issue.path === 'projectId')).toBe(true);
  const edited = text.replace('filmie.3d-reference', 'filmie.web-reference');
  const saved = (await request(
    path + '/revisions',
    { text: edited, baseRevisionId: revision },
    201,
  )) as ProjectSummary;
  await request(path + '/revisions', { text, baseRevisionId: revision }, 409);
  await request(
    path + '/revisions',
    { text: '{', baseRevisionId: saved.revisions[0]!.id },
    400,
  );
  const duplicate = (await request(
    path + '/duplicate',
    { name: 'Older copy', revisionId: revision },
    201,
  )) as ProjectSummary;
  await stop();
  await start();
  expect(await request(path + '/revisions/' + saved.revisions[0]!.id)).toEqual({
    text: edited,
  });
  expect(
    await request(
      'projects/' + duplicate.id + '/revisions/' + duplicate.revisions[0]!.id,
    ),
  ).toEqual({ text });
  const response = await fetch(base + '/api/projects', {
    headers: { Origin: 'http://other.invalid' },
  });
  expect(response.status).toBe(403);
});

async function waitForRun(id: string, timeout = 5000) {
  return vi.waitFor(
    async () => {
      const result = (await request('runs/' + id)) as {
        run: Run;
        outputs: Output[];
      };
      expect(['succeeded', 'failed']).toContain(result.run.status);
      return result;
    },
    { timeout, interval: 250 },
  );
}

it('runs the real orchestration path and retains Blender launch errors and logs', async () => {
  vi.stubEnv('FILMIE_BLENDER', join(root, 'missing-blender'));
  const { path, revision } = await createProject();
  const queued = (await request(
    path + '/runs',
    { revisionId: revision },
    202,
  )) as Run;
  const { run } = await waitForRun(queued.id);
  expect(run.status).toBe('failed');
  expect(run.error).toMatch(/Blender|missing-blender/i);
  await stop();
  await start();
  expect(await request(path + '/runs')).toMatchObject([
    { id: run.id, revisionId: revision, status: 'failed' },
  ]);
});

it.skipIf(process.env['FILMIE_WEB_REAL_RENDER'] !== '1')(
  'renders one Blender frame through HTTP, serves previews, and reruns from cache',
  async () => {
    const { path, revision, text } = await createProject();
    const input = JSON.parse(text);
    const shot = input.shots[0];
    shot.durationFrames = 1;
    shot.scene.characters.forEach((character: { actions: unknown[] }) => {
      character.actions = [];
    });
    shot.scene.camera.durationFrames = 1;
    input.timeline.durationFrames = 1;
    input.video.resolution = { width: 320, height: 180 };
    input.renderPolicy.outputDimensions = input.video.resolution;
    input.renderPolicy.renderer.config.engine = 'BLENDER_WORKBENCH';
    const saved = (await request(
      path + '/revisions',
      { text: JSON.stringify(input), baseRevisionId: revision },
      201,
    )) as ProjectSummary;
    const version = saved.revisions[0]!.id;
    const queued = (await request(
      path + '/runs',
      { revisionId: version },
      202,
    )) as Run;
    const { run, outputs } = await waitForRun(queued.id, 55_000);
    expect(run.status, run.error).toBe('succeeded');
    expect(run.progress).toEqual({ completed: 1, total: 1 });
    const blend = outputs.find((output) =>
      output.name.endsWith('/scene.blend'),
    );
    expect(blend).toBeDefined();
    await promisify(execFile)(
      defaultBlenderExecutable(),
      [
        '--background',
        join(root, 'outputs', run.id, blend!.name),
        '--python-exit-code',
        '1',
        '--python-expr',
        [
          'import bpy, math',
          'objects = bpy.context.scene.objects',
          'floor = objects["room.main/floor"]',
          'assert all(math.isclose(a, b, abs_tol=1e-5) for a, b in zip(floor.dimensions, (6.44, 7.22, 0.18)))',
          'assert floor.data.materials[0].name == "floor-stone"',
          'assert objects["bench.seat"].parent == objects["bench"]',
          'assert objects["bench.lantern"].parent == objects["bench"]',
          'assert objects["bench.leg-left/body"].data == objects["bench.leg-right/body"].data',
          'assert objects["bench"]["filmie_physics_massKg"] == 14',
          'assert math.isclose(objects["room.main/north.entry.leaf"].rotation_euler.z, math.radians(-22), abs_tol=1e-5)',
        ].join('\n'),
      ],
      { timeout: 15_000, windowsHide: true },
    );
    const master = outputs.find((output) => output.name === 'master.mp4')!;
    const frame = outputs.find((output) => output.kind === 'image')!;
    const response = await fetch(base + master.url, {
      headers: { Range: 'bytes=0-15' },
    });
    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(16);
    const png = await fetch(base + frame.url);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(
      Buffer.from(await png.arrayBuffer())
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    const rerun = (await request(
      path + '/runs',
      { revisionId: version },
      202,
    )) as Run;
    expect((await waitForRun(rerun.id)).run.cacheHits).toEqual({
      shots: 1,
      assembly: true,
    });
    shot.scene.camera.fromDistance += 0.5;
    const cameraRevision = (await request(
      path + '/revisions',
      { text: JSON.stringify(input), baseRevisionId: version },
      201,
    )) as ProjectSummary;
    const cameraRun = (await request(
      path + '/runs',
      {
        revisionId: cameraRevision.revisions[0]!.id,
      },
      202,
    )) as Run;
    const changed = await waitForRun(cameraRun.id, 35_000);
    expect(changed.run.status, changed.run.error).toBe('succeeded');
    expect(changed.run.cacheHits?.shots).toBe(0);
    const workerResult = changed.outputs.find((output) =>
      output.name.endsWith('/worker-result.json'),
    )!;
    expect(await (await fetch(base + workerResult.url)).json()).toMatchObject({
      worldCacheHit: true,
    });
  },
  65_000,
);
