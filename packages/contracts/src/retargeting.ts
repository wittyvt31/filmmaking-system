import { z } from 'zod';
import { StableIdSchema } from './identifiers.js';
import { UnitQuaternionSchema } from './interactions.js';
import { MotionVectorSchema } from './skeletal-motion.js';

/** Proper rotations only; reflected/left-handed coordinates must be normalized by the importer. */
export const RetargetProfileSchema = z
  .object({
    version: z.literal(1),
    joints: z
      .array(
        z
          .object({
            semantic: StableIdSchema,
            source: StableIdSchema,
            target: StableIdSchema,
          })
          .strict(),
      )
      .min(1),
    coordinateRotation: UnitQuaternionSchema.default([1, 0, 0, 0]),
    translationScale: z.number().finite().positive().default(1),
    sourceOrigin: MotionVectorSchema.default([0, 0, 0]),
    targetOrigin: MotionVectorSchema.default([0, 0, 0]),
  })
  .strict()
  .superRefine((profile, context) => {
    for (const field of ['semantic', 'source', 'target'] as const) {
      const names = profile.joints.map((joint) => joint[field]);
      if (new Set(names).size !== names.length)
        context.addIssue({
          code: 'custom',
          message: `Duplicate retarget ${field}`,
        });
    }
  });
export type RetargetProfile = z.infer<typeof RetargetProfileSchema>;
