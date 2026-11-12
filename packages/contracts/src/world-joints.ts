import { z } from 'zod';
import { PhysicalJointSchema } from './articulated-dynamics.js';

/** A Bullet joint between world entities, including proxies for character accessories. */
export const WorldPhysicalJointSchema = PhysicalJointSchema.safeExtend({
  maxMotorImpulse: z.number().positive().finite().default(1),
  motorKeys: z
    .array(
      z
        .object({
          frame: z.number().int().nonnegative().safe(),
          velocity: z.number().finite(),
        })
        .strict(),
    )
    .max(1024)
    .default([]),
}).superRefine((joint, context) => {
  const issue = (message: string) =>
    context.addIssue({ code: 'custom', message });
  if (joint.drive || joint.damping)
    issue(
      'Bullet joints support velocity motors. Position drives and joint damping require the core solver',
    );
  if (joint.kind === 'ball' && joint.maximum !== Math.PI && joint.maximum !== 0)
    issue(
      'Bullet ball joints must be unlocked (maximum pi) or locked (maximum zero)',
    );
  if (joint.motorKeys.length && !joint.motor)
    issue('Motor keys require a motor');
  if (
    joint.motorKeys.some(
      (key, i) => i > 0 && key.frame <= joint.motorKeys[i - 1]!.frame,
    )
  )
    issue('Motor keys must have strictly increasing frames');
});
export type WorldPhysicalJoint = z.infer<typeof WorldPhysicalJointSchema>;
