import { z } from 'zod';
import { StableIdSchema } from './identifiers.js';
import { MotionVectorSchema } from './skeletal-motion.js';

export const SpatialConstraintSchema = z
  .object({
    id: StableIdSchema,
    effector: StableIdSchema,
    chainRoot: StableIdSchema,
    target: MotionVectorSchema,
    space: z.enum(['world', 'character-local']).default('world'),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().nonnegative(),
    fadeFrames: z.number().int().nonnegative().default(0),
    tolerance: z.number().positive().max(1).default(0.005),
    priority: z.number().int().min(0).max(100).default(0),
  })
  .strict()
  .refine(
    (c) =>
      c.endFrame >= c.startFrame &&
      c.fadeFrames * 2 <= c.endFrame - c.startFrame,
    {
      message: 'Constraint interval or fade duration is invalid',
    },
  );
export type SpatialConstraint = z.infer<typeof SpatialConstraintSchema>;
