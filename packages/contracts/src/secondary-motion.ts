import { z } from 'zod';
import { ColliderSchema } from './physics.js';
import { RigidTransformSchema } from './interactions.js';
import { MotionVectorSchema } from './skeletal-motion.js';
import { StableIdSchema } from './identifiers.js';

const frame = z.number().int().nonnegative().safe();
const positive = z.number().positive().finite();
const nonNegative = z.number().nonnegative().finite();

export const SecondaryMotionLimitSchema = z
  .object({
    min: MotionVectorSchema,
    max: MotionVectorSchema,
  })
  .strict()
  .refine(({ min, max }) => min.every((value, index) => value <= max[index]!), {
    message: 'Secondary motion limits must have min <= max',
  });

export const SecondaryMotionOverrideSchema = z
  .object({
    frame,
    pose: RigidTransformSchema,
  })
  .strict();

export const SecondaryMotionNodeSchema = z
  .object({
    id: StableIdSchema,
    parentId: StableIdSchema.optional(),
    kind: z.enum(['chain', 'attachment', 'skeletal-control']),
    restPose: RigidTransformSchema,
    massKg: positive.default(1),
    stiffness: nonNegative.default(80),
    damping: nonNegative.default(12),
    gravity: MotionVectorSchema.default([0, 0, -9.81]),
    drag: z.number().min(0).max(1).default(0),
    motionLimit: SecondaryMotionLimitSchema.optional(),
    maxSpeed: positive.optional(),
    radius: nonNegative.default(0),
    anchored: z.boolean().default(false),
    overrides: z.array(SecondaryMotionOverrideSchema).max(4096).default([]),
  })
  .strict();

export const SecondaryMotionSettingsSchema = z
  .object({
    frameRate: z
      .object({ numerator: positive.int(), denominator: positive.int() })
      .strict(),
    substeps: z.number().int().min(1).max(64).default(4),
    solverIterations: z.number().int().min(1).max(32).default(4),
    deterministicSeed: z.number().int().safe().default(0),
  })
  .strict();

export const SecondaryMotionConfigurationSchema = z
  .object({
    nodes: z.array(SecondaryMotionNodeSchema).max(1024),
    colliders: z.array(ColliderSchema).max(4096).default([]),
    substeps: z.number().int().min(1).max(64).default(4),
    solverIterations: z.number().int().min(1).max(32).default(4),
    deterministicSeed: z.number().int().safe().default(0),
  })
  .strict()
  .superRefine((configuration, context) => {
    const ids = new Set<string>();
    configuration.nodes.forEach((node, index) => {
      if (ids.has(node.id))
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          message: 'Duplicate secondary motion node ID',
        });
      ids.add(node.id);
    });
    configuration.nodes.forEach((node, index) => {
      if (node.parentId && !ids.has(node.parentId))
        context.addIssue({
          code: 'custom',
          path: ['nodes', index, 'parentId'],
          message:
            'Secondary motion node parent must be in the same configuration',
        });
    });
  });

export const SecondaryMotionBakeSchema = z
  .object({
    frameCount: z.number().int().nonnegative().safe(),
    settings: SecondaryMotionSettingsSchema,
    nodes: z.array(SecondaryMotionNodeSchema).max(1024),
    colliders: z.array(ColliderSchema).max(4096).default([]),
  })
  .strict();

export type SecondaryMotionLimit = z.infer<typeof SecondaryMotionLimitSchema>;
export type SecondaryMotionOverride = z.infer<
  typeof SecondaryMotionOverrideSchema
>;
export type SecondaryMotionNode = z.infer<typeof SecondaryMotionNodeSchema>;
export type SecondaryMotionSettings = z.infer<
  typeof SecondaryMotionSettingsSchema
>;
export type SecondaryMotionConfiguration = z.infer<
  typeof SecondaryMotionConfigurationSchema
>;
export type SecondaryMotionBake = z.infer<typeof SecondaryMotionBakeSchema>;
export type SecondaryMotionAuthoredPose = {
  nodeId: string;
  frame: number;
  pose: z.infer<typeof RigidTransformSchema>;
};
export type SecondaryMotionFrame = {
  frame: number;
  poses: {
    nodeId: string;
    local: z.infer<typeof RigidTransformSchema>;
    world: z.infer<typeof RigidTransformSchema>;
  }[];
};
