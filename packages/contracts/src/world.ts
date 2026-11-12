import { z } from 'zod';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';
import { SceneTransformSchema } from './shared-internal.js';
import { MaterialSchema } from './material.js';
import {
  AssemblyDefinitionSchema,
  ImportedMaterialsSchema,
  MeshDefinitionSchema,
} from './geometry.js';
import {
  ColliderSchema,
  PhysicsSettingsSchema,
  RigidBodySchema,
  type PhysicsSettings,
} from './physics.js';
import { SecondaryMotionConfigurationSchema } from './secondary-motion.js';

const length = z.number().min(0.001).max(10_000);

const SurfaceSchema = z
  .object({
    thickness: length,
    materialId: StableIdSchema,
  })
  .strict();

const OpeningBase = z.object({
  id: StableIdSchema,
  offset: z.number().min(0).max(10_000),
  width: length,
  height: length,
  frame: z
    .object({ width: length, materialId: StableIdSchema })
    .strict()
    .optional(),
});

const OpeningSchema = z.discriminatedUnion('kind', [
  OpeningBase.extend({
    kind: z.literal('door'),
    leaf: SurfaceSchema.extend({
      angleDegrees: z.number().min(-180).max(180).default(0),
    }).optional(),
  }).strict(),
  OpeningBase.extend({
    kind: z.literal('window'),
    sillHeight: length,
  }).strict(),
]);

const WallSchema = SurfaceSchema.extend({
  side: z.enum(['north', 'south', 'east', 'west']),
  openings: z.array(OpeningSchema).max(32).default([]),
});

const DimensionsSchema = z.object({ x: length, y: length, z: length }).strict();
const RoomSchema = z
  .object({
    kind: z.literal('room'),
    dimensions: DimensionsSchema,
    floor: SurfaceSchema,
    ceiling: SurfaceSchema.optional(),
    walls: z.array(WallSchema).max(4),
  })
  .strict();

const EntitySchema = z
  .object({
    id: StableIdSchema,
    parentId: StableIdSchema.optional(),
    transform: SceneTransformSchema,
    physics: RigidBodySchema.optional(),
    secondaryMotion: SecondaryMotionConfigurationSchema.optional(),
    colliders: z.array(ColliderSchema).min(1).max(64).optional(),
    geometry: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('group') }).strict(),
      z
        .object({
          kind: z.literal('box'),
          dimensions: DimensionsSchema,
          materialId: StableIdSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('asset'),
          asset: AssetVersionReferenceSchema,
          materialOverrides: ImportedMaterialsSchema.optional(),
        })
        .strict(),
      z.object({ kind: z.literal('mesh'), meshId: StableIdSchema }).strict(),
      z
        .object({ kind: z.literal('assembly'), assemblyId: StableIdSchema })
        .strict(),
      RoomSchema,
    ]),
  })
  .strict();

type Room = z.infer<typeof RoomSchema>;
export type WorldWall = Room['walls'][number];
export type WorldOpening = WorldWall['openings'][number];
export const openingBottom = (opening: WorldOpening) =>
  opening.kind === 'door' ? 0 : opening.sillHeight;
export const wallSpan = (
  dimensions: Room['dimensions'],
  side: WorldWall['side'],
) => (side === 'north' || side === 'south' ? dimensions.x : dimensions.y);

type Issue = (path: (string | number)[], message: string) => void;

function validateRoom(
  room: Room,
  material: (id: string, path: (string | number)[]) => void,
  issue: Issue,
) {
  material(room.floor.materialId, ['floor', 'materialId']);
  if (room.ceiling)
    material(room.ceiling.materialId, ['ceiling', 'materialId']);
  const sides = new Set<string>();
  const openingIds = new Set<string>();
  room.walls.forEach((wall, index) => {
    const path = ['walls', index];
    if (sides.has(wall.side))
      issue([...path, 'side'], 'A room can have only one wall per side');
    sides.add(wall.side);
    material(wall.materialId, [...path, 'materialId']);
    wall.openings.forEach((opening, openingIndex) => {
      const openingPath = [...path, 'openings', openingIndex];
      if (openingIds.has(opening.id))
        issue([...openingPath, 'id'], 'Duplicate opening ID in room');
      openingIds.add(opening.id);
      const bottom = openingBottom(opening);
      if (
        opening.offset + opening.width > wallSpan(room.dimensions, wall.side) ||
        bottom + opening.height > room.dimensions.z
      )
        issue(
          openingPath,
          'Opening must fit within the interior span and height of its wall',
        );
      const frameWidth = opening.frame?.width ?? 0;
      if (opening.frame) {
        material(opening.frame.materialId, [
          ...openingPath,
          'frame',
          'materialId',
        ]);
        if (
          2 * frameWidth >= opening.width ||
          (opening.kind === 'door' ? 1 : 2) * frameWidth >= opening.height
        )
          issue(
            [...openingPath, 'frame', 'width'],
            'Frame must leave a positive clear opening',
          );
      }
      if (opening.kind === 'door' && opening.leaf) {
        material(opening.leaf.materialId, [
          ...openingPath,
          'leaf',
          'materialId',
        ]);
        if (opening.leaf.thickness > wall.thickness)
          issue(
            [...openingPath, 'leaf', 'thickness'],
            'Door leaf cannot be thicker than the wall',
          );
      }
      if (
        wall.openings
          .slice(0, openingIndex)
          .some(
            (other) =>
              opening.offset < other.offset + other.width &&
              other.offset < opening.offset + opening.width &&
              bottom < openingBottom(other) + other.height &&
              openingBottom(other) < bottom + opening.height,
          )
      )
        issue(openingPath, 'Wall openings must not overlap');
    });
  });
}

export const WorldSchema = z
  .object({
    schemaVersion: z.literal(1),
    physics: PhysicsSettingsSchema.optional(),
    materials: z.array(MaterialSchema).max(256).default([]),
    meshes: z.array(MeshDefinitionSchema).max(256).optional(),
    assemblies: z.array(AssemblyDefinitionSchema).max(128).optional(),
    entities: z.array(EntitySchema).min(1).max(2048),
  })
  .strict()
  .superRefine((world, context) => {
    const issue: Issue = (path, message) =>
      context.addIssue({ code: 'custom', path, message });
    const materials = new Set<string>();
    world.materials.forEach(({ id }, index) => {
      if (materials.has(id))
        issue(['materials', index, 'id'], 'Duplicate material ID');
      materials.add(id);
    });
    const entities = new Map<string, number>();
    const meshes = new Set<string>();
    (world.meshes ?? []).forEach((mesh, i) => {
      if (meshes.has(mesh.id)) issue(['meshes', i, 'id'], 'Duplicate mesh ID');
      meshes.add(mesh.id);
      if (!materials.has(mesh.materialId))
        issue(['meshes', i, 'materialId'], 'Unknown mesh material');
    });
    const assemblies = new Set<string>();
    (world.assemblies ?? []).forEach((assembly, i) => {
      if (assemblies.has(assembly.id))
        issue(['assemblies', i, 'id'], 'Duplicate assembly ID');
      assemblies.add(assembly.id);
      const parts = new Map(assembly.parts.map((part) => [part.id, part]));
      if (parts.size !== assembly.parts.length)
        issue(['assemblies', i, 'parts'], 'Duplicate assembly part ID');
      const checked = new Set<string>();
      for (const [j, part] of assembly.parts.entries()) {
        const path = ['assemblies', i, 'parts', j];
        if (!meshes.has(part.meshId))
          issue([...path, 'meshId'], 'Unknown assembly mesh');
        if (part.parentId && !parts.has(part.parentId))
          issue([...path, 'parentId'], 'Unknown assembly parent');
        const chain = new Set<string>();
        for (
          let id: string | undefined = part.id;
          id && !checked.has(id);
          id = parts.get(id)?.parentId
        ) {
          if (chain.has(id)) {
            issue([...path, 'parentId'], 'Assembly hierarchy contains a cycle');
            break;
          }
          chain.add(id);
        }
        for (const id of chain) checked.add(id);
      }
    });
    let instances = 0;
    world.entities.forEach((entity, index) => {
      if (entities.has(entity.id))
        issue(['entities', index, 'id'], 'Duplicate world entity ID');
      entities.set(entity.id, index);
      const base = ['entities', index, 'geometry'];
      if (
        entity.colliders &&
        new Set(entity.colliders.map((c) => c.id)).size !==
          entity.colliders.length
      )
        issue(['entities', index, 'colliders'], 'Duplicate collider ID');
      const material = (id: string, path: (string | number)[]) => {
        if (!materials.has(id))
          issue([...base, ...path], 'Unknown material "' + id + '"');
      };
      if (entity.geometry.kind === 'box')
        material(entity.geometry.materialId, ['materialId']);
      if (
        entity.geometry.kind === 'mesh' &&
        !meshes.has(entity.geometry.meshId)
      )
        issue([...base, 'meshId'], 'Unknown world mesh');
      if (entity.geometry.kind === 'assembly') {
        const assemblyId = entity.geometry.assemblyId;
        const assembly = world.assemblies?.find(
          (item) => item.id === assemblyId,
        );
        if (!assembly) issue([...base, 'assemblyId'], 'Unknown world assembly');
        else instances += assembly.parts.length;
      }
      if (entity.geometry.kind === 'asset') {
        const overrides = entity.geometry.materialOverrides;
        if (overrides?.mode === 'all')
          material(overrides.materialId, ['materialOverrides', 'materialId']);
        if (overrides?.mode === 'slots') {
          const slots = new Set<string>();
          overrides.slots.forEach((slot, i) => {
            if (slots.has(slot.source))
              issue(
                [...base, 'materialOverrides', 'slots', i, 'source'],
                'Duplicate source material slot name',
              );
            slots.add(slot.source);
            material(slot.materialId, [
              'materialOverrides',
              'slots',
              i,
              'materialId',
            ]);
          });
        }
      }
      if (entity.geometry.kind === 'room')
        validateRoom(entity.geometry, material, (path, message) =>
          issue([...base, ...path], message),
        );
    });
    if (instances > 16384)
      issue(['entities'], 'World exceeds 16,384 assembly part instances');
    const visited = new Set<string>();
    world.entities.forEach((entity, index) => {
      if (entity.parentId && !entities.has(entity.parentId))
        issue(['entities', index, 'parentId'], 'Unknown parent entity');
      const chain = new Set<string>();
      let id: string | undefined = entity.id;
      while (id && !visited.has(id)) {
        if (chain.has(id)) {
          issue(
            ['entities', index, 'parentId'],
            'World hierarchy contains a cycle',
          );
          break;
        }
        chain.add(id);
        const parentIndex = entities.get(id);
        id =
          parentIndex === undefined
            ? undefined
            : world.entities[parentIndex]?.parentId;
      }
      for (const member of chain) visited.add(member);
    });
  });

export type World = z.infer<typeof WorldSchema>;
export type WorldEntity = World['entities'][number];

export interface WorldBox {
  id: string;
  position: { x: number; y: number; z: number };
  dimensions: z.infer<typeof DimensionsSchema>;
  materialId: string;
  rotationDegrees?: number;
}

export type CompiledWorldEntity = Omit<WorldEntity, 'geometry'> &
  (
    | { boxes: WorldBox[] }
    | { meshId: string }
    | { assemblyId: string }
    | {
        asset: z.infer<typeof AssetVersionReferenceSchema>;
        materialOverrides?: z.infer<typeof ImportedMaterialsSchema>;
      }
  );

export interface CompiledWorld {
  schemaVersion: 1;
  materials: World['materials'];
  meshes?: NonNullable<World['meshes']>;
  assemblies?: NonNullable<World['assemblies']>;
  entities: CompiledWorldEntity[];
  physics?: PhysicsSettings;
  sha256: string;
}
