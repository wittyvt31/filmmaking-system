import { z } from 'zod';

const nonEmpty = z.string().min(1);
const vector3 = z.tuple([z.number(), z.number(), z.number()]);
const quaternion = z.tuple([z.number(), z.number(), z.number(), z.number()]);

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
              'collider',
              'joint',
              'material',
              'custom',
            ]),
            target: nonEmpty,
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
      })
      .strict()
      .default({ verified: [], unsupported: [], unknown: [] }),
    articulation: z
      .object({
        joints: z
          .array(
            z
              .object({
                id: nonEmpty,
                type: z.enum(['fixed', 'hinge', 'slider', 'ball']),
                parent: nonEmpty,
                child: nonEmpty,
                axis: vector3.optional(),
                limits: z
                  .object({
                    lower: z.number().optional(),
                    upper: z.number().optional(),
                  })
                  .strict()
                  .optional(),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .default({ joints: [] }),
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
