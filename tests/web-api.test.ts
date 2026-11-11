import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { defaultBlenderExecutable } from '@filmmaking/engine-blender';
import { RiggedCharacterSchema } from '@filmmaking/contracts';
import { prepareCharacter } from '@filmmaking/scene';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
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

async function start(allowedHosts: string[] = []) {
  server = createFilmieServer({
    dataDirectory: join(root, 'data'),
    outputDirectory: join(root, 'outputs'),
    cacheDirectory: join(root, 'cache'),
    catalogsDirectory: resolve('examples'),
    webDirectory: join(root, 'web'),
    allowedHosts,
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

async function createProject(catalog = '3d-production') {
  const project = (await request(
    'projects',
    { name: 'Reference', catalog },
    201,
  )) as ProjectSummary;
  const path = 'projects/' + project.id;
  const revision = project.revisions[0]!.id;
  const { text } = (await request(path + '/revisions/' + revision)) as {
    text: string;
  };
  return { path, revision, text };
}

it.skipIf(process.env['FILMIE_WEB_REAL_RENDER'] !== '1')(
  'executes planted reach constraints through Studio and checks Blender endpoints',
  async () => {
    const { path, revision, text } = await createProject('humanoid-animation');
    const input = JSON.parse(text);
    const shot = input.shots[1];
    shot.durationFrames = 3;
    for (const c of shot.scene.characters[0].constraints) {
      c.endFrame = 2;
      if (c.fadeFrames) c.fadeFrames = 1;
    }
    input.shots = [shot];
    input.timeline.durationFrames = 3;
    input.timeline.videoTracks[0].clips = [{ shotId: shot.id, startFrame: 0 }];
    input.video.resolution = { width: 320, height: 180 };
    input.renderPolicy.outputDimensions = input.video.resolution;
    input.renderPolicy.renderer.config.samples = 4;
    const saved = (await request(
      path + '/revisions',
      { text: JSON.stringify(input), baseRevisionId: revision },
      201,
    )) as ProjectSummary;
    const queued = (await request(
      path + '/runs',
      { revisionId: saved.revisions[0]!.id },
      202,
    )) as Run;
    const { run, outputs } = await waitForRun(queued.id, 90_000);
    expect(run.status, run.error).toBe('succeeded');
    const blend = outputs.find((o) => o.name.endsWith('/scene.blend'))!;
    expect(blend).toBeDefined();
    const response = await fetch(base + blend.url);
    const { writeFile } = await import('node:fs/promises');
    const local = join(root, 'ik.blend');
    await writeFile(local, Buffer.from(await response.arrayBuffer()));
    await promisify(execFile)(
      defaultBlenderExecutable(),
      [
        '--background',
        local,
        '--python-expr',
        [
          'import bpy, math',
          'rig = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")',
          'bpy.context.scene.frame_set(2)',
          'targets = ' +
            JSON.stringify(
              shot.scene.characters[0].constraints.map(
                (c: {
                  effector: string;
                  target: number[];
                  tolerance: number;
                }) => [c.effector, c.target, c.tolerance],
              ),
            ),
          'for name, target, tolerance in targets:\n    actual = rig.matrix_world @ rig.pose.bones[name].tail\n    assert math.dist(actual, target) <= tolerance + 0.00001, (name, tuple(actual), target)',
        ].join('\n'),
      ],
      { timeout: 20_000, windowsHide: true },
    );
  },
  120_000,
);

it('validates the humanoid animation catalog and reports incompatible motion edits', async () => {
  const { path, text } = await createProject('humanoid-animation');
  expect(await request(path + '/validate', { text })).toEqual({
    issues: [],
    frames: 121,
    shots: 1,
  });
  const draft = JSON.parse(text);
  draft.shots[0].scene.characters[0].motion.at(-1).source.clipId =
    'missing-clip';
  const result = (await request(path + '/validate', {
    text: JSON.stringify(draft),
  })) as Validation;
  expect(result.issues[0]?.message).toMatch(/gesture.*unknown clip/);
});

it('allows requests using an explicitly configured LAN host', async () => {
  await stop();
  await start(['192.168.1.20']);
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Server did not bind a port');
  const response = await fetch(base + '/api/projects', {
    headers: {
      Host: '192.168.1.20:' + address.port,
      Origin: 'http://192.168.1.20:' + address.port,
    },
  });
  expect(response.status).toBe(200);
});

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
  'renders father actions and visitor poses through HTTP and reuses assets',
  async () => {
    const { path, revision, text } = await createProject();
    const input = JSON.parse(text);
    const shot = input.shots[0];
    shot.durationFrames = 3;
    const [breathing, headTurn] = shot.scene.characters[0].actions;
    Object.assign(breathing, { startFrame: 0, endFrame: 3, cycleFrames: 4 });
    Object.assign(headTurn, { startFrame: 0, endFrame: 3 });
    const visitor = shot.scene.characters[1];
    visitor.poses.root = visitor.poses.root.slice(0, 2);
    visitor.poses.root[1].frame = 2;
    for (const track of visitor.poses.joints) {
      track.keys = track.keys.slice(0, 2);
      track.keys[1].frame = 2;
    }
    shot.scene.camera = {
      type: 'static',
      distance: 9.4,
      target: { x: 0, y: 0.55, z: 1.2 },
    };
    input.timeline.durationFrames = 3;
    input.video.resolution = { width: 320, height: 180 };
    input.renderPolicy.outputDimensions = input.video.resolution;
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
    const cacheRoot = join(root, 'cache');
    const cacheEntry = (await readdir(cacheRoot, { recursive: true })).find(
      (file) => /[\\/]characters[\\/][a-f0-9]{64}\.blend$/.test(file),
    );
    expect(cacheEntry).toBeDefined();
    const prepared = prepareCharacter(RiggedCharacterSchema.parse(visitor), 3);
    const imported = {
      ...prepared,
      id: 'visitor.imported',
      source: {
        kind: 'imported',
        body: prepared.source.body,
        asset: {
          assetId: 'character.visitor',
          localPath: join(cacheRoot, cacheEntry!),
          metadata: {
            blenderCollection:
              'Filmie Humanoid ' + basename(cacheEntry!, '.blend').slice(0, 32),
          },
        },
      },
    };
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
          'root = objects["visitor"]',
          'assert root.parent == objects["room.main"]',
          'rig = next(obj for obj in root.children if obj.type == "ARMATURE")',
          'skin = next(obj for obj in rig.children if obj.type == "MESH")',
          'assert rig.pose.bones["forearm.L"].parent.name == "upper_arm.L"',
          'assert any(len(vertex.groups) == 2 for vertex in skin.data.vertices)',
          'def pose(frame):\n    bpy.context.scene.frame_set(frame)\n    evaluated = skin.evaluated_get(bpy.context.evaluated_depsgraph_get())\n    return rig.pose.bones["forearm.L"].rotation_quaternion.to_euler().x, root.location.y, [tuple(v.co) for v in evaluated.data.vertices]',
          'a, b, c = [pose(frame) for frame in (1, 2, 3)]',
          'assert c[0] < b[0] < a[0] and c[1] < b[1] < a[1]',
          'assert max(math.dist(x, y) for x, y in zip(a[2], c[2])) > 0.05',
          'father = objects["character.father.instance"]',
          'chest = next(obj for obj in father.children if obj.get("filmie_control_id") == "RIG_chest")',
          'head = next(obj for obj in chest.children if obj.get("filmie_control_id") == "RIG_head")',
          'head_mesh = next(obj for obj in head.children if obj.type == "MESH")',
          'def father_pose(frame):\n    bpy.context.scene.frame_set(frame)\n    return chest.scale.z, head.rotation_euler.z, head_mesh.matrix_world.copy()',
          'rest, mid, turn = [father_pose(frame) for frame in (1, 2, 3)]',
          'assert math.isclose(mid[0] / rest[0], 1.018, abs_tol=1e-5)',
          'assert math.isclose(turn[1] - rest[1], math.radians(34), abs_tol=1e-5)',
          'assert rest[2] != turn[2]',
          'import json, sys',
          'sys.path.insert(0, ' +
            JSON.stringify(resolve('engines/blender/worker')) +
            ')',
          'from render_shot import instantiate_asset, prepare_character',
          'from semantic_rig import discover_controls, RigCapabilityError, preflight_actions',
          'collection = bpy.data.collections.new("Renamed rig")',
          'nested = bpy.data.collections.new("Nested controls")',
          'collection.children.link(nested)',
          'control = bpy.data.objects.new("Arbitrary display name", None)',
          'nested.objects.link(control)',
          'control["filmie_control_id"] = "custom.torso"',
          'assert discover_controls(collection, {"semanticControls": {"chest": "custom.torso"}}, "test")["chest"] == control',
          'control.name = "Renamed control"',
          'control["filmie_control_id"] = "chest"',
          'assert discover_controls(collection, {}, "test")["chest"] == control',
          'instruction = {"characterId": "test", "action": {"type": "breathing", "id": "test.breathe"}}',
          'preflight_actions({"actions": [instruction], "motionCurves": []}, {"test": control}, {"test": {"chest": control}})',
          'duplicate = bpy.data.objects.new("Conflicting control", None)',
          'duplicate["filmie_control_id"] = "RIG_chest"',
          'nested.objects.link(duplicate)',
          'try:\n    discover_controls(collection, {}, "test")\nexcept RigCapabilityError as error:\n    assert "ambiguous semantic control" in str(error)\nelse:\n    raise AssertionError("Ambiguous controls were accepted")',
          'spec = json.loads(' + JSON.stringify(JSON.stringify(imported)) + ')',
          'imported_root, imported_rig, _ = prepare_character(bpy.context.scene, spec, instantiate_asset, {"room.main": objects["room.main"]})',
          'assert imported_root.parent == root.parent and len(imported_rig.data.bones) == len(rig.data.bones)',
          'spec["bones"][0]["head"][0] += 0.1',
          'try:\n    prepare_character(bpy.context.scene, spec, instantiate_asset, {"room.main": objects["room.main"]})\nexcept ValueError as error:\n    assert "Incompatible joint rest pose" in str(error)\nelse:\n    raise AssertionError("Incompatible rest pose was accepted")',
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
    visitor.poses.joints[0].keys[1].rotationDegrees[2] += 4;
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
      characterCacheHits: 1,
    });
  },
  85_000,
);

it.skipIf(process.env['FILMIE_WEB_REAL_RENDER'] !== '1')(
  'reports missing semantic capabilities in production preflight before rendering',
  async () => {
    const { path, revision, text } = await createProject();
    const input = JSON.parse(text);
    input.shots[0].scene.characters[0].actions.push({
      id: 'father.blinks',
      type: 'blink',
      startFrame: 0,
      endFrame: 5,
      intervalFrames: 4,
      closureFrames: 2,
    });
    const saved = (await request(
      path + '/revisions',
      {
        text: JSON.stringify(input),
        baseRevisionId: revision,
      },
      201,
    )) as ProjectSummary;
    const queued = (await request(
      path + '/runs',
      { revisionId: saved.revisions[0]!.id },
      202,
    )) as Run;
    const { run, outputs } = await waitForRun(queued.id, 35_000);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/INVALID_INSTRUCTIONS|requires semantic control/);
    expect(run.error).toMatch(/father\.blinks.*left-eye, right-eye/);
    expect(
      outputs.some(
        (output) => output.kind === 'image' || output.kind === 'video',
      ),
    ).toBe(false);
  },
  45_000,
);
