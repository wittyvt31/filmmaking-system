import { z } from 'zod';
import { StableIdSchema } from './identifiers.js';
import { MotionVectorSchema } from './skeletal-motion.js';

// WXYZ, unit length. Reject ambiguous or invalid rotations at the boundary.
export const UnitQuaternionSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(
    (q) => Math.abs(Math.hypot(...q) - 1) < 1e-6,
    'Expected a unit WXYZ quaternion',
  );
export const RigidTransformSchema = z
  .object({
    position: MotionVectorSchema,
    rotation: UnitQuaternionSchema,
  })
  .strict();
export const InteractionAnchorSchema = z
  .object({
    id: StableIdSchema,
    transform: RigidTransformSchema,
  })
  .strict();
const frame = z.number().int().nonnegative().safe();
const action = z.object({
  id: StableIdSchema,
  startFrame: frame,
  endFrame: frame,
  priority: z.number().int().min(0).max(100).default(0),
});
export const InteractionActionSchema = z
  .discriminatedUnion('kind', [
    action
      .extend({ kind: z.literal('reach'), target: RigidTransformSchema })
      .strict(),
    action
      .extend({ kind: z.literal('place'), target: RigidTransformSchema })
      .strict(),
    action.extend({ kind: z.literal('carry') }).strict(),
    action.extend({ kind: z.literal('grasp') }).strict(),
    action.extend({ kind: z.literal('release') }).strict(),
  ])
  .superRefine((a, context) => {
    if (
      a.endFrame < a.startFrame ||
      (['grasp', 'release'].includes(a.kind) && a.startFrame !== a.endFrame)
    )
      context.addIssue({
        code: 'custom',
        message: 'Invalid interval or non-instantaneous grasp/release',
      });
  });
export type RigidTransform = z.infer<typeof RigidTransformSchema>;
export type InteractionAction = z.infer<typeof InteractionActionSchema>;
export type InteractionAnchor = z.infer<typeof InteractionAnchorSchema>;
