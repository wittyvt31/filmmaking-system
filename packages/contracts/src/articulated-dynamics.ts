import { z } from 'zod';
import { StableIdSchema } from './identifiers.js';
import { RigidTransformSchema } from './interactions.js';
import { MotionVectorSchema } from './skeletal-motion.js';
import { PhysicsSettingsSchema } from './physics.js';

const finite = z.number().finite();
const frame = z.number().int().nonnegative().safe();
const mode = z.enum(['static', 'kinematic', 'dynamic']);
const identity: z.infer<typeof RigidTransformSchema> = {
  position: [0, 0, 0],
  rotation: [1, 0, 0, 0],
};
/** Joint coordinates use anchor A's local X axis. Angles are radians, lengths metres. */
export const PhysicalJointSchema = z
  .object({
    id: StableIdSchema,
    kind: z.enum(['fixed', 'hinge', 'slider', 'ball']),
    bodyA: StableIdSchema,
    bodyB: StableIdSchema,
    anchorA: RigidTransformSchema.default(identity),
    anchorB: RigidTransformSchema.default(identity),
    minimum: finite.default(0),
    maximum: finite.default(0),
    damping: finite.nonnegative().default(0),
    motor: z
      .object({
        velocity: finite,
        maxRate: finite.positive(),
      })
      .strict()
      .optional(),
    drive: z
      .object({
        target: finite,
        stiffness: finite.nonnegative(),
        maxRate: finite.positive(),
      })
      .strict()
      .optional(),
    collideConnected: z.boolean().default(false),
  })
  .strict()
  .superRefine((j, c) => {
    const issue = (message: string) => c.addIssue({ code: 'custom', message });
    if (j.bodyA === j.bodyB || j.minimum > j.maximum)
      issue('Invalid joint bodies or limits');
    if ((j.kind === 'fixed' || j.kind === 'ball') && (j.motor || j.drive))
      issue('Scalar motors/drives require a hinge or slider');
    if (j.kind === 'fixed' && (j.minimum !== 0 || j.maximum !== 0))
      issue('Fixed joints have zero limits');
    if (j.kind === 'ball' && (j.minimum !== 0 || j.maximum > Math.PI))
      issue('Ball limit is a cone angle in [0, pi]');
    if (j.kind === 'hinge' && (j.minimum < -Math.PI || j.maximum > Math.PI))
      issue('Hinge limits must be within [-pi, pi]');
    if (j.drive && (j.drive.target < j.minimum || j.drive.target > j.maximum))
      issue('Drive target exceeds limits');
  });
export const ArticulatedAssemblySchema = z
  .object({
    version: z.literal(1),
    settings: PhysicsSettingsSchema,
    positionTolerance: finite.positive().default(0.001),
    angularTolerance: finite.positive().default(0.001),
    bodies: z
      .array(
        z
          .object({
            id: StableIdSchema,
            pose: RigidTransformSchema,
            mode,
            massKg: finite.positive(),
            inertiaKgM2: finite.positive(),
            linearDamping: finite.nonnegative().default(0),
            angularDamping: finite.nonnegative().default(0),
            collisionGroup: z.number().int().min(0).max(0x7fffffff).default(1),
            collisionMask: z
              .number()
              .int()
              .min(0)
              .max(0x7fffffff)
              .default(0x7fffffff),
            authored: z
              .array(z.object({ frame, pose: RigidTransformSchema }).strict())
              .default([]),
            transitions: z
              .array(z.object({ frame, mode }).strict())
              .default([]),
            loads: z
              .array(
                z
                  .object({
                    startFrame: frame,
                    endFrame: frame,
                    force: MotionVectorSchema.default([0, 0, 0]),
                    torque: MotionVectorSchema.default([0, 0, 0]),
                  })
                  .strict()
                  .refine(
                    (l) => l.endFrame >= l.startFrame,
                    'Invalid load interval',
                  ),
              )
              .default([]),
          })
          .strict(),
      )
      .min(1)
      .max(256),
    joints: z.array(PhysicalJointSchema).max(512),
  })
  .strict()
  .superRefine((a, c) => {
    const issue = (message: string) => c.addIssue({ code: 'custom', message });
    const ids = new Set(a.bodies.map((b) => b.id));
    if (
      ids.size !== a.bodies.length ||
      new Set(a.joints.map((j) => j.id)).size !== a.joints.length
    )
      issue('Duplicate body or joint ID');
    for (const j of a.joints)
      if (!ids.has(j.bodyA) || !ids.has(j.bodyB))
        issue('Unknown joint body: ' + j.id);
    for (const b of a.bodies) {
      for (const keys of [b.authored, b.transitions])
        if (keys.some((k, i) => i > 0 && k.frame <= keys[i - 1]!.frame))
          issue('Body keys must be strictly ordered: ' + b.id);
      for (const t of b.transitions)
        if (
          t.mode === 'kinematic' &&
          !b.authored.some((k) => k.frame === t.frame)
        )
          issue('Kinematic takeover requires an exact authored pose: ' + b.id);
      if (b.mode === 'kinematic' && b.authored[0]?.frame !== 0)
        issue('Kinematic body requires frame zero pose: ' + b.id);
    }
  });
export type ArticulatedAssembly = z.infer<typeof ArticulatedAssemblySchema>;
export type PhysicalJoint = z.infer<typeof PhysicalJointSchema>;
