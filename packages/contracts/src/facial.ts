import { z } from 'zod';
import { StableIdSchema } from './identifiers.js';
import { CameraTargetSchema } from './cinematography.js';
import {
  MotionInterpolationSchema,
  MotionVectorSchema,
} from './skeletal-motion.js';

const name = z.string().trim().min(1).max(256);
const weight = z.number().min(0).max(1);
const frame = z.number().int().nonnegative().safe();
const priority = z.number().int().min(0).max(100).default(50);
const angles = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-180).max(180),
  z.number().min(-180).max(180),
]);
const values = z.record(StableIdSchema, weight);
const envelope = z.object({
  startFrame: frame,
  endFrame: frame,
  fadeInFrames: frame.default(0),
  fadeOutFrames: frame.default(0),
  weight: weight.default(1),
  priority,
});
const checkEnvelope = (v: z.infer<typeof envelope>) =>
  v.endFrame > v.startFrame &&
  v.fadeInFrames + v.fadeOutFrames <= v.endFrame - v.startFrame;
const KeyTrack = z.object({
  control: StableIdSchema,
  keys: z
    .array(
      z
        .object({
          frame,
          value: weight,
          interpolation: MotionInterpolationSchema.default('linear'),
        })
        .strict(),
    )
    .min(1)
    .max(1024),
});
const layers = z
  .discriminatedUnion('kind', [
    envelope
      .extend({
        kind: z.literal('expression'),
        expression: StableIdSchema,
        blend: z.enum(['replace', 'additive']).default('replace'),
      })
      .strict(),
    envelope
      .merge(KeyTrack)
      .extend({
        kind: z.literal('control'),
        blend: z.enum(['replace', 'additive']).default('replace'),
      })
      .strict(),
  ])
  .refine(checkEnvelope, 'Invalid facial layer range or fades');

export const FacialRigSchema = z
  .object({
    id: StableIdSchema,
    bones: z
      .array(
        z
          .object({
            id: StableIdSchema,
            source: name,
            parent: StableIdSchema,
            head: MotionVectorSchema,
            tail: MotionVectorSchema,
            min: angles,
            max: angles,
          })
          .strict()
          .refine(
            (b) =>
              Math.hypot(...b.head.map((v, i) => v - b.tail[i]!)) > 1e-6 &&
              b.min.every((v, i) => v <= 0 && b.max[i]! >= 0),
            'Facial bone needs a nonzero axis and limits containing the rest pose',
          ),
      )
      .max(64)
      .default([]),
    controls: z.record(
      StableIdSchema,
      z
        .array(
          z.discriminatedUnion('kind', [
            z
              .object({
                kind: z.literal('morph'),
                mesh: name,
                target: name,
                amount: weight.default(1),
              })
              .strict(),
            z
              .object({
                kind: z.literal('bone'),
                joint: StableIdSchema,
                rotationDegrees: angles,
              })
              .strict(),
          ]),
        )
        .min(1)
        .max(32),
    ),
    expressions: z.record(StableIdSchema, values).default({}),
    visemes: z.record(StableIdSchema, values).default({}),
    phonemes: z.record(name, StableIdSchema).default({}),
  })
  .strict();
export const FacialPerformanceSchema = z
  .object({
    rigId: StableIdSchema,
    layers: z.array(layers).max(128).default([]),
    speech: z
      .array(
        z
          .discriminatedUnion('kind', [
            envelope
              .extend({ kind: z.literal('viseme'), id: StableIdSchema })
              .strict(),
            envelope.extend({ kind: z.literal('phoneme'), id: name }).strict(),
          ])
          .refine(checkEnvelope, 'Invalid speech cue range or fades'),
      )
      .max(2048)
      .default([]),
    blinks: z
      .array(
        z
          .object({
            control: StableIdSchema,
            startFrame: frame,
            closeFrames: frame.min(1),
            holdFrames: frame.default(0),
            openFrames: frame.min(1),
            weight: weight.default(1),
            priority: priority.default(70),
          })
          .strict(),
      )
      .max(256)
      .default([]),
    gaze: z
      .array(
        envelope
          .extend({
            joint: StableIdSchema,
            target: CameraTargetSchema,
            forward: MotionVectorSchema,
          })
          .strict()
          .refine(
            (v) => checkEnvelope(v) && Math.hypot(...v.forward) > 1e-6,
            'Invalid gaze range, fades or local forward vector',
          ),
      )
      .max(128)
      .default([]),
    overrides: z.array(KeyTrack.strict()).max(128).default([]),
  })
  .strict();
export type FacialRig = z.infer<typeof FacialRigSchema>;
export type FacialPerformance = z.infer<typeof FacialPerformanceSchema>;
