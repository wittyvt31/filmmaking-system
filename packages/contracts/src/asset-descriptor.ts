import { z } from 'zod';

const nonEmpty = z.string().min(1);
const vector3 = z.tuple([z.number(), z.number(), z.number()]);
const quaternion = z.tuple([z.number(), z.number(), z.number(), z.number()]);
const rigidTransform = z
  .object({
    position: vector3,
    rotation: quaternion,
  })
  .strict();
const identityTransform = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [1, 0, 0, 0] as [number, number, number, number],
};
export const AssetTransformSpaceSchema = z.enum(['local', 'parent', 'world']);
const semanticTarget = z.union([
  nonEmpty,
  z
    .object({
      nodeIndex: z.number().int().nonnegative(),
      path: nonEmpty.optional(),
    })
    .strict(),
]);
const capabilityMapping = z
  .object({
    capability: nonEmpty,
    handle: nonEmpty,
    required: z.boolean().default(true),
    space: AssetTransformSpaceSchema.optional(),
  })
  .strict();
const resolvedHandle = z
  .object({
    id: nonEmpty,
    kind: nonEmpty,
    nodeIndex: z.number().int().nonnegative().optional(),
    materialIndex: z.number().int().nonnegative().optional(),
    space: AssetTransformSpaceSchema,
  })
  .strict()
  .refine(
    (value) =>
      Number(value.nodeIndex !== undefined) +
        Number(value.materialIndex !== undefined) ===
      1,
    'Resolved handles must identify exactly one GLB target',
  );
const articulationJoint = z
  .object({
    id: nonEmpty,
    type: z.enum([
      'revolute',
      'prismatic',
      'fixed',
      'continuous',
      'hinge',
      'slider',
      'ball',
    ]),
    parent: nonEmpty,
    child: nonEmpty,
    pivot: nonEmpty.optional(),
    axis: vector3.optional(),
    parentTransform: rigidTransform.default(identityTransform),
    childTransform: rigidTransform.default(identityTransform),
    degreesOfFreedom: z.number().int().min(0).max(3).optional(),
    limits: z
      .object({
        lower: z.number().finite().optional(),
        upper: z.number().finite().optional(),
      })
      .strict()
      .optional(),
    defaultValue: z.number().finite().default(0),
    control: nonEmpty.optional(),
  })
  .strict();
const articulationControl = z
  .object({
    id: nonEmpty,
    handle: nonEmpty,
    channel: z.enum(['position', 'rotation', 'value']),
    joints: z.array(nonEmpty).min(1),
    defaultValue: z.number().finite().default(0),
  })
  .strict();

export const AssetDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    assetId: nonEmpty.optional(),
    assetVersion: nonEmpty.optional(),
    handles: z
      .array(
        z
          .object({
            id: nonEmpty,
            kind: z.enum([
              'bone',
              'node',
              'socket',
              'pivot',
              'attachment-socket',
              'control-target',
              'rig-reference',
              'collider',
              'joint',
              'material',
              'custom',
            ]),
            target: semanticTarget,
            space: AssetTransformSpaceSchema.default('local'),
            role: nonEmpty.optional(),
          })
          .strict(),
      )
      .default([]),
    capabilities: z
      .object({
        verified: z.array(nonEmpty).default([]),
        unsupported: z.array(nonEmpty).default([]),
        unknown: z.array(nonEmpty).default([]),
        assetClass: z
          .enum(['character', 'vehicle', 'prop', 'environment'])
          .optional(),
        requirements: z.array(nonEmpty).default([]),
        mappings: z.array(capabilityMapping).default([]),
      })
      .strict()
      .default({
        verified: [],
        unsupported: [],
        unknown: [],
        requirements: [],
        mappings: [],
      }),
    resolvedHandles: z.array(resolvedHandle).optional(),
    restTransforms: z.record(z.string(), rigidTransform).optional(),
    articulation: z
      .object({
        joints: z.array(articulationJoint).default([]),
        controls: z.array(articulationControl).default([]),
      })
      .strict()
      .default({ joints: [], controls: [] }),
    colliders: z
      .array(
        z
          .object({
            id: nonEmpty,
            shape: z.enum(['box', 'sphere', 'capsule', 'cylinder', 'mesh']),
            node: nonEmpty,
            center: vector3.optional(),
            size: vector3.optional(),
            radius: z.number().positive().optional(),
            height: z.number().positive().optional(),
          })
          .strict(),
      )
      .default([]),
    sockets: z
      .array(
        z
          .object({
            id: nonEmpty,
            node: nonEmpty,
            position: vector3,
            rotation: quaternion,
          })
          .strict(),
      )
      .default([]),
    materials: z
      .array(
        z
          .object({
            id: nonEmpty,
            name: nonEmpty.optional(),
            semantic: nonEmpty.optional(),
          })
          .strict(),
      )
      .default([]),
    rig: z
      .object({
        skeletons: z.number().int().nonnegative().default(0),
        bones: z.number().int().nonnegative().default(0),
        rootNodes: z.array(nonEmpty).default([]),
      })
      .strict()
      .default({ skeletons: 0, bones: 0, rootNodes: [] }),
    provenance: z
      .object({
        source: nonEmpty,
        importer: nonEmpty.optional(),
        importedAt: z.iso.datetime().optional(),
        notes: z.array(nonEmpty).default([]),
      })
      .strict(),
  })
  .strict();

export type AssetDescriptor = z.infer<typeof AssetDescriptorSchema>;
