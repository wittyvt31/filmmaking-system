import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ProjectManifestSchema,
  WorldSchema,
  type World,
} from '@filmmaking/contracts';
import { compileScene, compileWorld } from '@filmmaking/scene';

const reference = ProjectManifestSchema.parse(
  JSON.parse(readFileSync('examples/3d-production/manifest.json', 'utf8')),
);
const getWorld = (): World =>
  structuredClone(reference.shots[0]!.scene!.world!);
const getRoom = (world: World) => {
  const room = world.entities.find(({ id }) => id === 'room.main')!.geometry;
  if (room.kind !== 'room') throw new Error('Missing room fixture');
  return room;
};

describe('manifest world', () => {
  it('builds a deterministic local hierarchy and measured floor, ceiling, door, and window', () => {
    const world = getWorld();
    const built = compileWorld(world);
    expect(
      compileWorld({ ...world, entities: [...world.entities].reverse() }),
    ).toEqual(built);
    const room = built.entities[0]!;
    if (!('boxes' in room)) throw new Error('Missing compiled room');
    const floor = room.boxes.find(({ id }) => id === 'floor')!;
    expect(floor.dimensions.x).toBeCloseTo(6.44);
    expect(floor.dimensions.y).toBeCloseTo(7.22);
    expect(floor.dimensions.z).toBeCloseTo(0.18);
    expect(floor.position.z + floor.dimensions.z / 2).toBe(0);
    const ceiling = room.boxes.find(({ id }) => id === 'ceiling')!;
    expect(ceiling.position.z - ceiling.dimensions.z / 2).toBeCloseTo(3.1);

    const northWall = room.boxes.filter(({ id }) =>
      id.startsWith('north.wall.'),
    );
    const solidArea = northWall.reduce(
      (area, box) => area + box.dimensions.x * box.dimensions.z,
      0,
    );
    expect(solidArea).toBeCloseTo(6.44 * 3.1 - 1 * 2.18 - 1.35 * 1.05);
    expect(
      northWall.some(
        (box) =>
          Math.abs(box.position.x - 1) < box.dimensions.x / 2 &&
          Math.abs(box.position.z - 1.5) < box.dimensions.z / 2,
      ),
    ).toBe(false);
    const door = room.boxes.find(({ id }) => id === 'north.entry.leaf')!;
    expect(door.rotationDegrees).toBe(-22);
    expect(door.dimensions.y).toBe(0.045);
    const benchIndex = built.entities.findIndex(({ id }) => id === 'bench');
    const lanternIndex = built.entities.findIndex(
      ({ id }) => id === 'bench.lantern',
    );
    expect(lanternIndex).toBeGreaterThan(benchIndex);
    expect(built.entities[lanternIndex]).toMatchObject({
      parentId: 'bench',
      asset: { assetId: 'prop.lantern', version: '1.1.0' },
    });
    expect(
      compileScene(reference.shots[0]!, reference.video.frameRate).world,
    ).toEqual(built);
    getRoom(world).dimensions.x += 1;
    expect(compileWorld(world).sha256).not.toBe(built.sha256);
  });

  it('rejects overlapping and oversized openings and invalid frames', () => {
    const world = getWorld();
    const openings = getRoom(world).walls[0]!.openings;
    openings[1]!.offset = 1;
    openings[0]!.height = 10;
    openings[0]!.frame!.width = 1;
    expect(() => WorldSchema.parse(world)).toThrow(/fit within/);
    expect(() => WorldSchema.parse(world)).toThrow(/must not overlap/);
    expect(() => WorldSchema.parse(world)).toThrow(/positive clear opening/);
  });

  it('rejects missing parents, cycles, duplicate entities, invalid dimensions and unknown materials', () => {
    const world = getWorld();
    world.entities[0]!.parentId = 'bench';
    world.entities[2]!.parentId = 'missing';
    world.entities[2]!.transform.scale = 0;
    world.entities[3]!.id = world.entities[4]!.id;
    getRoom(world).floor.materialId = 'missing';
    expect(() => WorldSchema.parse(world)).toThrow(/Unknown parent/);
    expect(() => WorldSchema.parse(world)).toThrow(/cycle/);
    expect(() => WorldSchema.parse(world)).toThrow(/Duplicate world entity/);
    expect(() => WorldSchema.parse(world)).toThrow(/Unknown material/);
    const invalid = getWorld();
    getRoom(invalid).dimensions.z = 0;
    expect(WorldSchema.safeParse(invalid).success).toBe(false);
  });

  it('checks versioned asset dependencies and preserves the legacy environment path', () => {
    const manifest = structuredClone(reference);
    const shot = manifest.shots[0]!;
    shot.requiredAssets = shot.requiredAssets.filter(
      (asset) => asset.assetId !== 'prop.lantern',
    );
    expect(() => ProjectManifestSchema.parse(manifest)).toThrow(
      /prop.lantern@1.1.0/,
    );
    delete shot.scene!.world;
    shot.scene!.characters = shot.scene!.characters.filter(
      (character) => 'asset' in character,
    );
    shot.scene!.environment = {
      assetId: 'environment.village-interior',
      version: '1.1.0',
    };
    shot.requiredAssets.push(shot.scene!.environment);
    const parsed = ProjectManifestSchema.parse(manifest);
    const compiled = compileScene(parsed.shots[0]!, parsed.video.frameRate);
    expect(compiled.environment).toEqual(shot.scene!.environment);
    expect(compiled.world).toBeUndefined();
  });
});
