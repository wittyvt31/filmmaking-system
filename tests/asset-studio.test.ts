import { afterEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { AssetRegistry, AssetVersionSchema } from '@filmmaking/assets';
import { proceduralAssetDescriptor } from '@filmmaking/engine-blender';
import { createFilmieServer } from '../apps/web-api/src/server.js';
import { AssetStudioService } from '../apps/web-api/src/asset-studio.js';
import { WorkspaceStore } from '../apps/web-api/src/store.js';

const roots: string[] = [];
const servers: ReturnType<typeof createFilmieServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'filmie-asset-studio-'));
  roots.push(root);
  const store = new WorkspaceStore(root);
  const catalog = resolve('examples');
  const studio = new AssetStudioService(root, catalog, store);
  return { root, store, catalog, studio };
}

function fixture() {
  return JSON.parse(
    readFileSync('examples/asset-lab/crane.definition.json', 'utf8'),
  ) as Record<string, unknown>;
}

it('validates real procedural geometry and rejects malformed definitions', () => {
  const { studio } = setup();
  const good = studio.validate(fixture());
  expect(good).toMatchObject({
    valid: true,
    partCount: 6,
    meshCount: 6,
    jointCount: 3,
    issues: [],
  });
  const invalid = fixture();
  invalid['parts'] = [];
  expect(
    studio.validate(invalid).issues.some((item) => item.path === 'parts'),
  ).toBe(true);
  expect(studio.list()).toEqual([]);
});

it('serves the fixture and browser validation through restricted local routes', async () => {
  const { root, catalog } = setup();
  const server = createFilmieServer({
    dataDirectory: root,
    outputDirectory: join(root, 'renders'),
    cacheDirectory: join(root, 'cache'),
    catalogsDirectory: catalog,
    webDirectory: resolve('apps/web/dist'),
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const url = 'http://127.0.0.1:' + address.port + '/api/asset-studio';

  const template = await fetch(url + '/template');
  expect(template.status).toBe(200);
  const example = (await template.json()) as {
    definition: Record<string, unknown>;
  };
  expect(example.definition['assetId']).toBe('filmie.demo.crane');

  const validation = await fetch(url + '/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ definition: example.definition }),
  });
  expect(validation.status).toBe(200);
  expect((await validation.json()) as unknown).toMatchObject({ valid: true });

  const assets = await fetch(url + '/assets');
  expect((await assets.json()) as unknown).toEqual({ assets: [] });

  const traversal = await fetch(url + '/files/artifacts/../../secret.glb');
  expect(traversal.status).toBe(404);
});

it('attaches published immutable asset versions to the project registry', () => {
  const { root, store, catalog, studio } = setup();
  const definition = fixture();
  const descriptor = proceduralAssetDescriptor(definition);
  const hash = 'a'.repeat(64);
  const content = AssetVersionSchema.parse({
    assetId: 'filmie.demo.crane',
    version: '1.0.0',
    type: 'model',
    contentHash: hash,
    sourceUri: 'artifacts/' + hash + '.glb',
    metadata: {},
    descriptor,
    license: { name: 'Filmie sample', restrictions: [] },
    provenance: { source: 'filmie-asset-studio' },
  });
  const registryRoot = join(root, 'asset-studio');
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(join(registryRoot, 'assets.json'), JSON.stringify([content]));

  const project = store.create('Asset test', '3d-production', '[]', '{}');
  expect(studio.attach(project.id, content.assetId, content.version)).toEqual({
    projectId: project.id,
    assetId: content.assetId,
    version: content.version,
  });
  // Reattaching the same immutable version must not duplicate it.
  studio.attach(project.id, content.assetId, content.version);
  const entries = new AssetRegistry(
    JSON.parse(
      readFileSync(store.registryPath(project.id), 'utf8'),
    ) as unknown[],
  ).list();
  expect(entries).toHaveLength(1);
  const expectedUri = relative(
    join(catalog, project.catalog),
    join(registryRoot, 'artifacts', hash + '.glb'),
  ).replaceAll('\\', '/');
  expect(entries[0]!.sourceUri).toBe(expectedUri);
  expect(entries[0]!.contentHash).toBe(hash);
});
