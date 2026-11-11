import { z } from 'zod';
import { MotionVectorSchema } from './skeletal-motion.js';

export const LocomotionSchema = z
  .object({
    waypoints: z
      .array(
        z
          .object({
            frame: z.number().int().nonnegative().safe(),
            position: MotionVectorSchema,
            yawDegrees: z.number().min(-180).max(180),
            easing: z.enum(['smooth', 'linear']).default('smooth'),
          })
          .strict(),
      )
      .min(2)
      .max(128),
    stepSeconds: z.number().min(0.15).max(2).default(0.38),
    strideMeters: z.number().min(0.02).max(1).default(0.32),
    swingHeight: z.number().min(0.01).max(0.3).default(0.09),
    maxStepHeight: z.number().min(0).max(0.3).default(0.16),
    floorHeight: z.number().default(0),
    obstacleRadius: z.number().min(0).max(1).default(0.16),
  })
  .strict()
  .superRefine(({ waypoints }, context) => {
    for (let i = 0; i < waypoints.length; i++) {
      if (
        i === 0
          ? waypoints[i]!.frame !== 0
          : waypoints[i]!.frame <= waypoints[i - 1]!.frame
      )
        context.addIssue({
          code: 'custom',
          path: ['waypoints', i, 'frame'],
          message: 'Locomotion frames must start at zero and strictly increase',
        });
    }
  });
export type Locomotion = z.infer<typeof LocomotionSchema>;
