import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { AssetRegistry } from '@filmmaking/assets';
import {
  MeshShapeSchema,
  parseProjectManifest,
  WorldSchema,
} from '@filmmaking/contracts';
import { prepareProductionPlan } from '@filmmaking/planner';
import { compileWorld, worldCollisionProxies } from '@filmmaking/scene';

const directory = resolve('examples/geometry-workshop');
const read = (file: string) =>
  JSON.parse(readFileSync(resolve(directory, file), 'utf8'));
const workshop = () =>
  parseProjectManifest(read('manifest.json')).shots[0]!.scene!.world!;

it('compiles reusable hierarchies deterministically and uses primitive or authored collision proxies', () => {
  const input = workshop();
  const world = compileWorld(input);
  input.meshes!.reverse();
  input.entities.reverse();
  input.assemblies![0]!.parts.reverse();
  expect(compileWorld(input).sha256).toBe(world.sha256);
  expect(world.assemblies![0]!.parts.map((part) => part.id)).toEqual([
    'base',
    'stem',
    'cap',
  ]);
  expect(
    world.entities.filter((entity) => 'assemblyId' in entity),
  ).toHaveLength(2);
  const proxies = worldCollisionProxies(world);
  expect(proxies.find((p) => p.entityId === 'column-left')?.shape).toEqual({
    kind: 'cylinder',
    radius: 0.14,
    height: 1.1,
  });
  expect(
    proxies.find((p) => p.entityId === 'plaza')?.pose.position[2],
  ).toBeCloseTo(-0.06);
  expect(proxies.some((p) => p.entityId === 'arch')).toBe(false);
});

it('rejects invalid topology, cyclic assembly parts and missing material overrides', () => {
  expect(
    MeshShapeSchema.safeParse({
      kind: 'extrusion',
      polygon: [
        [0, 0],
        [3, 2],
        [0, 3],
        [2, 0],
      ],
      depth: 1,
    }).success,
  ).toBe(false);
  expect(
    MeshShapeSchema.safeParse({
      kind: 'indexed',
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
      triangles: [[0, 1, 4]],
    }).success,
  ).toBe(false);
  const world = workshop();
  world.assemblies![0]!.parts[0]!.parentId = 'cap';
  const asset = world.entities.find(
    (entity) => entity.id === 'artifact-painted',
  )!.geometry;
  if (asset.kind !== 'asset' || asset.materialOverrides?.mode !== 'slots')
    throw new Error('Expected a slot override');
  asset.materialOverrides.slots[0]!.materialId = 'missing';
  const result = WorldSchema.safeParse(world);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        'Assembly hierarchy contains a cycle',
        'Unknown material "missing"',
      ]),
    );
  }
});

it('resolves a pinned GLB dependency shared by two geometry instances', async () => {
  const input = read('manifest.json');
  const registry = new AssetRegistry(read('assets.json'));
  const plan = await prepareProductionPlan(input, registry, directory);
  expect(plan.assets).toHaveLength(1);
  expect(plan.renderPlan.jobs[0]!.inputAssets).toEqual([
    { assetId: 'model.workshop-artifact', version: '1.0.0' },
  ]);
  expect(
    plan.compiledScenes['shot.geometry-workshop']!.world?.meshes,
  ).toHaveLength(8);
});
