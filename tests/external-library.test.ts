import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { inspectGlbBytes, AssetRegistry } from '@filmmaking/assets';
import { AssetStudioService } from '../apps/web-api/src/asset-studio.js';
import {
  ExternalLibraryService,
  inspectCharacterCompatibility,
} from '../apps/web-api/src/external-library.js';
import { WorkspaceStore } from '../apps/web-api/src/store.js';
import { createFilmieServer } from '../apps/web-api/src/server.js';

const folders: string[] = [];
const servers: ReturnType<typeof createFilmieServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  for (const path of folders.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function makeGlb(json: object): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const padded = Math.ceil(encoded.length / 4) * 4;
  const data = new Uint8Array(20 + padded);
  data.fill(32, 20);
  data.set(encoded, 20);
  const view = new DataView(data.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, data.length, true);
  view.setUint32(12, padded, true);
  view.setUint32(16, 0x4e4f534a, true);
  return data;
}

const object = () =>
  makeGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'House', mesh: 0 }],
    meshes: [
      { name: 'Building', primitives: [{ attributes: { POSITION: 0 } }] },
    ],
  });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'filmie-library-'));
  folders.push(root);
  const store = new WorkspaceStore(root);
  const catalog = resolve('examples');
  const studio = new AssetStudioService(root, catalog, store);
  const library = new ExternalLibraryService(root, store, studio);
  return { root, store, catalog, studio, library };
}

const importRequest = (filename: string) => ({
  filename,
  assetId: 'world.house.test',
  version: '1.0.0',
  category: 'environment',
  universeId: 'cinematic-horror',
  themes: ['horror'],
  sourceProvider: 'Blendkit',
  sourceUrl: 'https://www.blendkit.com/',
  license: { name: 'Fixture only', restrictions: ['private-use'] },
});
const identity = {
  position: { x: 0, y: 0, z: 0 },
  rotationDegrees: { x: 0, y: 0, z: 0 },
  scale: 1,
};

it('validates inbox paths and reports the real available rig capabilities', async () => {
  const { library } = setup();
  await expect(library.inspect('../secrets.glb')).rejects.toThrow();
  await expect(library.inspect('missing.glb')).rejects.toThrow('not found');
  writeFileSync(join(library.config().inboxDirectory, 'house.glb'), object());
  const result = await library.inspect('house.glb');
  expect(result.meshCount).toBe(1);
  expect(result.character.status).toBe('needs-mapping');
  expect(result.character.skeletonCount).toBe(0);
  expect(result.character.facial).toBe('no-morph-targets');
});

it('suggests exact humanoid source bone names without fabricating animation readiness', () => {
  const names = [
    'Hips',
    'Spine',
    'Spine2',
    'Neck',
    'Head',
    'LeftArm',
    'LeftForeArm',
    'LeftHand',
    'LeftUpLeg',
    'LeftLeg',
    'LeftFoot',
    'RightArm',
    'RightForeArm',
    'RightHand',
    'RightUpLeg',
    'RightLeg',
    'RightFoot',
  ];
  const report = inspectGlbBytes(
    makeGlb({
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: names.map((name, index) => ({
        name,
        ...(index === 0 ? { mesh: 0, skin: 0 } : {}),
      })),
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0 }, targets: [{ POSITION: 0 }] },
          ],
        },
      ],
      skins: [
        { name: 'Rig', joints: names.map((_, index) => index), skeleton: 0 },
      ],
    }),
  );
  const rig = inspectCharacterCompatibility(report);
  expect(rig.status).toBe('mapping-candidate');
  expect(rig.suggestedJointMap['head']).toBe('Head');
  expect(rig.suggestedJointMap['upper_arm.L']).toBe('LeftArm');
  expect(rig.missingJoints).toEqual([]);
  expect(rig.facial).toBe('morph-targets-present-unmapped');
});

it('publishes one real GLB, applies themed world references and preserves immutable versions', async () => {
  const { root, store, library } = setup();
  const file = 'house.glb';
  writeFileSync(join(library.config().inboxDirectory, file), object());
  const input = importRequest(file);
  const output = await library.publish(input);
  expect(output.status).toBe('published');
  expect(output.contentHash).toMatch(/^[a-f0-9]{64}$/);
  const reused = await library.publish(input);
  expect(reused.status).toBe('reused');
  expect(
    library.list({ universeId: 'cinematic-horror', theme: 'horror' }),
  ).toHaveLength(1);
  expect(library.list({ universeId: 'cartoon' })).toEqual([]);
  const registry = new AssetRegistry(
    JSON.parse(
      readFileSync(join(root, 'asset-studio', 'assets.json'), 'utf8'),
    ) as unknown[],
  );
  expect(registry.list()[0]?.metadata['filmieLibrary']).toMatchObject({
    sourceProvider: 'Blendkit',
    universeId: 'cinematic-horror',
    themes: ['horror'],
  });
  const world = {
    id: 'world.house-night',
    version: '1.0.0',
    name: 'Night House',
    universeId: 'cinematic-horror',
    theme: 'horror',
    instances: [
      {
        id: 'house',
        assetId: input.assetId,
        version: input.version,
        transform: identity,
      },
      {
        id: 'house-copy',
        assetId: input.assetId,
        version: input.version,
        transform: { ...identity, position: { x: 5, y: 0, z: 0 } },
      },
    ],
  };
  expect(library.saveWorld(world).instances).toHaveLength(2);
  expect(library.saveWorld(world).instances).toHaveLength(2);
  expect(() => library.saveWorld({ ...world, name: 'Changed' })).toThrow(
    'immutable',
  );
  expect(() =>
    library.saveWorld({
      ...world,
      version: '1.0.1',
      universeId: 'wrong-style',
    }),
  ).toThrow('Unknown visual universe');
  const manifest = readFileSync('examples/3d-production/manifest.json', 'utf8');
  const project = store.create(
    'Night House Test',
    '3d-production',
    '[]',
    manifest,
  );
  const applied = library.applyWorld(project.id, world.id, world.version);
  expect(applied.instanceCount).toBe(2);
  expect(store.project(project.id).revisions).toHaveLength(2);
  const updated = JSON.parse(
    readFileSync(
      store.revisionPath(store.project(project.id), applied.revisionId),
      'utf8',
    ),
  ) as {
    shots: {
      scene: {
        world: {
          entities: { id: string; geometry: { asset?: { assetId: string } } }[];
        };
      };
    }[];
  };
  expect(updated.shots[0]!.scene.world.entities).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'house',
        geometry: expect.objectContaining({
          asset: { assetId: input.assetId, version: input.version },
        }),
      }),
    ]),
  );
  const projectAssets = new AssetRegistry(
    JSON.parse(
      readFileSync(store.registryPath(project.id), 'utf8'),
    ) as unknown[],
  );
  expect(projectAssets.list()).toHaveLength(1);
  expect(() => library.applyWorld(project.id, world.id, world.version)).toThrow(
    'collides',
  );
});

it('assembles a reviewed humanoid as a rigged Filmie character rather than a static prop', () => {
  const { root, store, library } = setup();
  const registryRoot = join(root, 'asset-studio');
  const hash = 'b'.repeat(64);
  const mapping = {
    pelvis: 'Hips',
    spine: 'Spine',
    chest: 'Spine2',
    neck: 'Neck',
    head: 'Head',
    'upper_arm.L': 'LeftArm',
    'forearm.L': 'LeftForeArm',
    'hand.L': 'LeftHand',
    'thigh.L': 'LeftUpLeg',
    'shin.L': 'LeftLeg',
    'foot.L': 'LeftFoot',
    'upper_arm.R': 'RightArm',
    'forearm.R': 'RightForeArm',
    'hand.R': 'RightHand',
    'thigh.R': 'RightUpLeg',
    'shin.R': 'RightLeg',
    'foot.R': 'RightFoot',
  };
  writeFileSync(
    join(registryRoot, 'assets.json'),
    JSON.stringify([
      {
        assetId: 'characters.daughter.test',
        version: '1.0.0',
        type: 'model',
        contentHash: hash,
        sourceUri: 'artifacts/' + hash + '.glb',
        metadata: {
          filmieLibrary: {
            category: 'character',
            universeId: 'cinematic-horror',
            themes: ['horror'],
          },
          rigProfile: 'FilmieHumanoid',
          rigVersion: 1,
          rigJointMap: mapping,
        },
        license: { name: 'Fixture', restrictions: [] },
        provenance: { source: 'test' },
      },
    ]),
  );
  const world = library.saveWorld({
    id: 'world.daughter-test',
    version: '1.0.0',
    name: 'Daughter exterior',
    universeId: 'cinematic-horror',
    theme: 'horror',
    instances: [
      {
        id: 'daughter',
        assetId: 'characters.daughter.test',
        version: '1.0.0',
        transform: identity,
        characterHeight: 1.2,
      },
    ],
  });
  const project = store.create(
    'Daughter Test',
    '3d-production',
    '[]',
    readFileSync('examples/3d-production/manifest.json', 'utf8'),
  );
  const applied = library.applyWorld(project.id, world.id, world.version);
  const manifest = JSON.parse(
    readFileSync(
      store.revisionPath(store.project(project.id), applied.revisionId),
      'utf8',
    ),
  ) as {
    shots: {
      requiredAssets: { assetId: string }[];
      scene: {
        characters: {
          id: string;
          source: { kind: string; body: { height: number } };
        }[];
        world: { entities: { id: string }[] };
      };
    }[];
  };
  const character = manifest.shots[0]!.scene.characters.find(
    (item) => item.id === 'daughter',
  );
  expect(character?.source.kind).toBe('imported');
  expect(character?.source.body.height).toBe(1.2);
  expect(
    manifest.shots[0]!.scene.world.entities.some(
      (item) => item.id === 'daughter',
    ),
  ).toBe(false);
  expect(
    manifest.shots[0]!.requiredAssets.some(
      (item) => item.assetId === 'characters.daughter.test',
    ),
  ).toBe(true);
});

it('offers the Blender bridge HTTP API only through local server routes', async () => {
  const { root, catalog, library } = setup();
  const server = createFilmieServer({
    dataDirectory: root,
    catalogsDirectory: catalog,
    outputDirectory: join(root, 'renders'),
    cacheDirectory: join(root, 'cache'),
    webDirectory: resolve('apps/web/dist'),
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  const url = 'http://127.0.0.1:' + port;
  const config = await fetch(url + '/api/external-library/config');
  expect(config.status).toBe(200);
  expect((await config.json()) as unknown).toMatchObject(library.config());
  const universes = await fetch(url + '/api/external-library/universes');
  expect(
    (await universes.json()) as { universes: { id: string }[] },
  ).toMatchObject({
    universes: [{ id: 'cinematic-horror' }],
  });
  const invalid = await fetch(url + '/api/external-library/inspect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: '../bad.glb' }),
  });
  expect(invalid.status).toBe(422);
});
