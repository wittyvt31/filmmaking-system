import { z } from 'zod';
import type { WorldPhysicalJoint } from './world-joints.js';
import { StableIdSchema } from './identifiers.js';
import { MotionVectorSchema } from './skeletal-motion.js';
import { RigidTransformSchema, type RigidTransform } from './interactions.js';

const length = z.number().min(0.001).max(10000);
const fraction = z.number().min(0).max(1);
const frame = z.number().int().nonnegative().safe();
const movableMode = z.enum(['kinematic', 'dynamic']);
export const ColliderShapeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('box'),
      dimensions: z.tuple([length, length, length]),
    })
    .strict(),
  z.object({ kind: z.literal('sphere'), radius: length }).strict(),
  z
    .object({ kind: z.literal('cylinder'), radius: length, height: length })
    .strict(),
  z
    .object({
      kind: z.literal('capsule'),
      radius: length,
      segmentLength: length,
    })
    .strict(),
]);
export const ColliderSchema = z
  .object({
    id: StableIdSchema,
    shape: ColliderShapeSchema,
    pose: RigidTransformSchema.default({
      position: [0, 0, 0],
      rotation: [1, 0, 0, 0],
    }),
  })
  .strict();
export const RigidBodySchema = z
  .object({
    mode: z.enum(['static', 'kinematic', 'dynamic']).default('static'),
    massKg: z.number().positive().max(1e6).default(1),
    friction: fraction.default(0.5),
    restitution: fraction.default(0),
    linearDamping: fraction.default(0.04),
    angularDamping: fraction.default(0.1),
    releaseOnInteraction: z.boolean().default(false),
    followCharacter: z
      .object({
        characterId: StableIdSchema,
        joint: StableIdSchema.optional(),
        offset: RigidTransformSchema,
      })
      .strict()
      .optional(),
    transitions: z
      .array(z.object({ frame, mode: movableMode }).strict())
      .max(128)
      .default([]),
    keyframes: z
      .array(z.object({ frame, pose: RigidTransformSchema }).strict())
      .max(1024)
      .default([]),
  })
  .strict();
export const PhysicsSettingsSchema = z
  .object({
    gravity: MotionVectorSchema.default([0, 0, -9.81]),
    substeps: z.number().int().min(1).max(32).default(8),
    solverIterations: z.number().int().min(1).max(128).default(20),
  })
  .strict();

export type ColliderShape = z.infer<typeof ColliderShapeSchema>;
export type CollisionProxy = {
  id: string;
  entityId: string;
  shape: ColliderShape;
  pose: RigidTransform;
};
export type PhysicsSettings = z.infer<typeof PhysicsSettingsSchema>;
export type RigidBody = z.infer<typeof RigidBodySchema>;
export interface PhysicsSimulation {
  version: 1;
  settings: PhysicsSettings;
  joints?: WorldPhysicalJoint[];
  bodies: {
    entityId: string;
    initialPose: RigidTransform;
    properties: Omit<
      RigidBody,
      'keyframes' | 'transitions' | 'releaseOnInteraction' | 'followCharacter'
    >;
    colliders: CollisionProxy[];
    transitions: RigidBody['transitions'];
    keyframes: RigidBody['keyframes'];
    followCharacter?: NonNullable<RigidBody['followCharacter']>;
  }[];
}
