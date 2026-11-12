import { z } from 'zod';
import { ArticulatedContactSchema } from './contact-graph.js';
import { StableIdSchema } from './identifiers.js';
import { MotionVectorSchema } from './skeletal-motion.js';

/** Core execution request. Loads act on B with equal and opposite loads on A.
 * Direction is world-space and fixed at activation. Forces are in N, impulses in N s.
 * Duration is seconds; event activation uses the contact's startFrame.
 */
export const ContactLoadSchema = z
  .object({
    contact: ArticulatedContactSchema,
    direction: MotionVectorSchema.refine(
      (v) => Math.abs(Math.hypot(...v) - 1) < 1e-6,
      'Expected a unit impact direction',
    ),
    forceNewtons: z.number().nonnegative().max(1e6).default(0),
    impulseNewtonSeconds: z.number().nonnegative().max(1e6).default(0),
    durationSeconds: z.number().positive().max(60),
  })
  .strict();

export const CharacterResponseSchema = z
  .object({
    entityId: StableIdSchema,
    massKg: z.number().min(0.001).max(10000),
    recoveryFrequencyHz: z.number().min(0.01).max(30).default(2),
    maxDisplacementMeters: z.number().positive().max(10).default(0.5),
    /** Horizontal support radius around the authored root. Exceeding it requests a step. */
    supportRadiusMeters: z.number().positive().max(5).default(0.15),
    rootLocked: z.boolean().default(false),
    stagger: z
      .object({
        effector: StableIdSchema,
        chainRoot: StableIdSchema,
        swingSeconds: z.number().min(0.05).max(2).default(0.2),
        holdSeconds: z.number().nonnegative().max(4).default(0.25),
        clearanceMeters: z.number().positive().max(1).default(0.07),
      })
      .strict()
      .optional(),
    joints: z
      .array(
        z
          .object({
            joint: StableIdSchema,
            inertiaKgMetersSquared: z.number().min(0.000001).max(10000),
            maxRecoilDegrees: z.number().positive().max(90).default(15),
          })
          .strict(),
      )
      .max(128)
      .default([]),
  })
  .strict()
  .refine(
    (v) => new Set(v.joints.map((j) => j.joint)).size === v.joints.length,
    'Duplicate response joint',
  );

export const ContactResponseRequestSchema = z
  .object({
    version: z.literal(1),
    loads: z.array(ContactLoadSchema).max(256),
    characters: z.array(CharacterResponseSchema).min(1).max(128),
  })
  .strict()
  .superRefine((v, ctx) => {
    const ids = new Set(v.characters.map((c) => c.entityId));
    if (
      ids.size !== v.characters.length ||
      new Set(v.loads.map((l) => l.contact.id)).size !== v.loads.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate character or contact load ID',
      });
    for (const load of v.loads)
      if (
        !ids.has(load.contact.a.entityId) ||
        !ids.has(load.contact.b.entityId)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Both contact participants require response settings',
        });
  });
export type ContactResponseRequest = z.infer<
  typeof ContactResponseRequestSchema
>;
