import {
  canonicalJsonSha256,
  compareStrings,
  openingBottom,
  wallSpan,
  type CompiledWorld,
  type CompiledWorldEntity,
  type World,
  type WorldBox,
  type WorldEntity,
  type WorldWall,
} from '@filmmaking/contracts';

type Room = Extract<WorldEntity['geometry'], { kind: 'room' }>;
const ordered = <T extends { id: string }>(items: readonly T[]) =>
  [...items].sort((left, right) => compareStrings(left.id, right.id));

function wallBuilder(
  room: Room,
  wall: WorldWall,
  west: number,
  east: number,
): WorldBox[] {
  const boxes: WorldBox[] = [];
  const horizontal = wall.side === 'north' || wall.side === 'south';
  const span = wallSpan(room.dimensions, wall.side);
  const normal =
    (((horizontal ? room.dimensions.y : room.dimensions.x) + wall.thickness) /
      2) *
    (wall.side === 'north' || wall.side === 'east' ? 1 : -1);
  function add(
    id: string,
    start: number,
    width: number,
    bottom: number,
    height: number,
    materialId: string,
  ) {
    if (width <= 0 || height <= 0) return;
    const along = start + width / 2 - span / 2;
    boxes.push({
      id: wall.side + '.' + id,
      materialId,
      position: {
        x: horizontal ? along : normal,
        y: horizontal ? normal : along,
        z: bottom + height / 2,
      },
      dimensions: {
        x: horizontal ? width : wall.thickness,
        y: horizontal ? wall.thickness : width,
        z: height,
      },
    });
  }

  const start = horizontal ? -west : 0;
  const end = span + (horizontal ? east : 0);
  const openings = ordered(wall.openings);
  const cuts = [
    ...new Set([
      start,
      end,
      ...openings.flatMap((opening) => [
        opening.offset,
        opening.offset + opening.width,
      ]),
    ]),
  ].sort((a, b) => a - b);
  for (let i = 0; i < cuts.length - 1; i++) {
    const left = cuts[i]!;
    const right = cuts[i + 1]!;
    let bottom = 0;
    const holes = openings
      .filter(
        (opening) =>
          opening.offset <= left && right <= opening.offset + opening.width,
      )
      .sort((a, b) => openingBottom(a) - openingBottom(b));
    for (const [j, opening] of holes.entries()) {
      add(
        'wall.' + i + '.' + j,
        left,
        right - left,
        bottom,
        openingBottom(opening) - bottom,
        wall.materialId,
      );
      bottom = openingBottom(opening) + opening.height;
    }
    add(
      'wall.' + i + '.top',
      left,
      right - left,
      bottom,
      room.dimensions.z - bottom,
      wall.materialId,
    );
  }
  for (const opening of openings) {
    const { offset, width, height, frame } = opening;
    const bottom = openingBottom(opening);
    const trim = frame?.width ?? 0;
    if (frame) {
      add(opening.id + '.left', offset, trim, bottom, height, frame.materialId);
      add(
        opening.id + '.right',
        offset + width - trim,
        trim,
        bottom,
        height,
        frame.materialId,
      );
      add(
        opening.id + '.head',
        offset + trim,
        width - 2 * trim,
        bottom + height - trim,
        trim,
        frame.materialId,
      );
      if (opening.kind === 'window')
        add(
          opening.id + '.sill',
          offset + trim,
          width - 2 * trim,
          bottom,
          trim,
          frame.materialId,
        );
    }
    if (opening.kind === 'door' && opening.leaf) {
      const leafWidth = width - 2 * trim;
      const hinge = offset + trim - span / 2;
      const angle = opening.leaf.angleDegrees + (horizontal ? 0 : 90);
      const radians = (angle * Math.PI) / 180;
      boxes.push({
        id: wall.side + '.' + opening.id + '.leaf',
        materialId: opening.leaf.materialId,
        dimensions: {
          x: leafWidth,
          y: opening.leaf.thickness,
          z: height - trim,
        },
        position: {
          x:
            (horizontal ? hinge : normal) + (leafWidth / 2) * Math.cos(radians),
          y:
            (horizontal ? normal : hinge) + (leafWidth / 2) * Math.sin(radians),
          z: (height - trim) / 2,
        },
        rotationDegrees: angle,
      });
    }
  }
  return boxes;
}

function roomBuilder(room: Room): WorldBox[] {
  const walls = new Map(room.walls.map((wall) => [wall.side, wall]));
  const thickness = (side: WorldWall['side']) =>
    walls.get(side)?.thickness ?? 0;
  const west = thickness('west');
  const east = thickness('east');
  const north = thickness('north');
  const south = thickness('south');
  const slab = (id: string, surface: Room['floor'], z: number): WorldBox => ({
    id,
    materialId: surface.materialId,
    position: { x: (east - west) / 2, y: (north - south) / 2, z },
    dimensions: {
      x: room.dimensions.x + west + east,
      y: room.dimensions.y + north + south,
      z: surface.thickness,
    },
  });
  return [
    slab('floor', room.floor, -room.floor.thickness / 2),
    ...(room.ceiling
      ? [
          slab(
            'ceiling',
            room.ceiling,
            room.dimensions.z + room.ceiling.thickness / 2,
          ),
        ]
      : []),
    ...[...walls.keys()]
      .sort()
      .flatMap((side) => wallBuilder(room, walls.get(side)!, west, east)),
  ];
}

function compileEntity({
  geometry,
  ...entity
}: WorldEntity): CompiledWorldEntity {
  switch (geometry.kind) {
    case 'asset':
      return {
        ...entity,
        asset: geometry.asset,
        ...(geometry.materialOverrides
          ? { materialOverrides: geometry.materialOverrides }
          : {}),
      };
    case 'mesh':
      return { ...entity, meshId: geometry.meshId };
    case 'assembly':
      return { ...entity, assemblyId: geometry.assemblyId };
    case 'group':
      return { ...entity, boxes: [] };
    case 'room':
      return { ...entity, boxes: roomBuilder(geometry) };
    case 'box':
      return {
        ...entity,
        boxes: [
          {
            id: 'body',
            dimensions: geometry.dimensions,
            materialId: geometry.materialId,
            position: { x: 0, y: 0, z: 0 },
          },
        ],
      };
  }
}

// A scene compiler supplies a validated world. Keep the resulting geometry local
// to each entity so hierarchy, rotation and scale remain explicit.
function hierarchyOrder<
  T extends { id: string; parentId?: string | undefined },
>(items: readonly T[]) {
  const children = new Map<string | undefined, T[]>();
  for (const entity of ordered(items)) {
    const siblings = children.get(entity.parentId) ?? [];
    siblings.push(entity);
    children.set(entity.parentId, siblings);
  }
  const queue = [...(children.get(undefined) ?? [])];
  for (const entity of queue) queue.push(...(children.get(entity.id) ?? []));
  return queue;
}

export function compileWorld(world: World): CompiledWorld {
  const geometry = {
    schemaVersion: world.schemaVersion,
    ...(world.physics ? { physics: world.physics } : {}),
    materials: ordered(world.materials),
    ...(world.meshes?.length ? { meshes: ordered(world.meshes) } : {}),
    ...(world.assemblies?.length
      ? {
          assemblies: ordered(world.assemblies).map((a) => ({
            ...a,
            parts: hierarchyOrder(a.parts),
          })),
        }
      : {}),
    entities: hierarchyOrder(world.entities).map(compileEntity),
  };
  return { ...geometry, sha256: canonicalJsonSha256(geometry) };
}
