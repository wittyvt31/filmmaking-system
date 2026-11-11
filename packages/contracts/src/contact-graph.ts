import { z } from 'zod';
import { StableIdSchema } from './identifiers.js';
import { RigidTransformSchema } from './interactions.js';

const frame = z.number().int().nonnegative().safe();
/** Anchor transforms are relative to the bone tail in its posed local basis. */
export const ContactEndpointSchema = z
  .object({
    entityId: StableIdSchema,
    boneId: StableIdSchema,
    chainRoot: StableIdSchema,
    anchor: RigidTransformSchema,
  })
  .strict();
/** Inclusive intervals; ramps return to the sampled authored relationship on release. */
export const ArticulatedContactSchema = z
  .object({
    id: StableIdSchema,
    a: ContactEndpointSchema,
    b: ContactEndpointSchema,
    relativePose: RigidTransformSchema,
    channels: z.enum(['position', 'orientation', 'pose']).default('pose'),
    startFrame: frame,
    endFrame: frame,
    blendInFrames: frame.default(0),
    blendOutFrames: frame.default(0),
    priority: z.number().int().min(0).max(100).default(0),
    positionTolerance: z.number().positive().max(1).default(0.005),
    angularTolerance: z.number().positive().max(Math.PI).default(0.01),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      c.endFrame < c.startFrame ||
      c.blendInFrames + c.blendOutFrames > c.endFrame - c.startFrame
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid contact interval or overlapping transition ramps',
      });
    if (c.a.entityId === c.b.entityId && c.a.boneId === c.b.boneId)
      ctx.addIssue({
        code: 'custom',
        message: 'Contact endpoints must be distinct',
      });
  });
export const ContactGraphSchema = z
  .object({
    version: z.literal(1),
    contacts: z.array(ArticulatedContactSchema).max(256),
  })
  .strict()
  .superRefine((graph, ctx) => {
    if (new Set(graph.contacts.map((c) => c.id)).size !== graph.contacts.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate contact ID' });
  });
export type ContactGraph = z.infer<typeof ContactGraphSchema>;
export type ArticulatedContact = z.infer<typeof ArticulatedContactSchema>;
export type ContactEndpoint = z.infer<typeof ContactEndpointSchema>;
