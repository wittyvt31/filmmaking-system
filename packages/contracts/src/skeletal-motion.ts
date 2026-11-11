import { z } from 'zod';
import { StableIdSchema } from './identifiers.js';

export const MotionVectorSchema = z.tuple([z.number(), z.number(), z.number()]);
export const JointRotationSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-180).max(180),
  z.number().min(-180).max(180),
]);
export const MotionInterpolationSchema = z.enum([
  'linear',
  'hold',
  'ease',
  'ease-in',
  'ease-out',
  'ease-in-out',
]);
const Seconds = z.number().min(0).max(3600);
const KeySchema = z
  .object({
    time: Seconds,
    interpolation: MotionInterpolationSchema.default('linear'),
    bezier: z
      .tuple([
        z.number().min(0).max(1),
        z.number().min(0).max(1),
        z.number().min(0).max(1),
        z.number().min(0).max(1),
      ])
      .optional(),
  })
  .strict();
const RotationKeys = z
  .array(KeySchema.extend({ value: JointRotationSchema }))
  .min(1)
  .max(1024);

export const SkeletalClipSchema = z
  .object({
    id: StableIdSchema,
    rig: z
      .object({ profile: StableIdSchema, version: z.number().int().positive() })
      .strict(),
    duration: Seconds.positive(),
    rootPosition: z
      .array(KeySchema.extend({ value: MotionVectorSchema }))
      .max(1024)
      .default([]),
    rootRotation: RotationKeys.optional(),
    joints: z
      .array(z.object({ joint: StableIdSchema, keys: RotationKeys }).strict())
      .max(128)
      .default([]),
  })
  .strict()
  .superRefine((clip, context) => {
    const seen = new Set<string>();
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    if (!clip.rootPosition.length && !clip.rootRotation && !clip.joints.length)
      issue([], 'Motion clip requires at least one animation channel');
    const tracks = [
      { path: ['rootPosition'], keys: clip.rootPosition },
      { path: ['rootRotation'], keys: clip.rootRotation ?? [] },
      ...clip.joints.map((track, index) => {
        if (seen.has(track.joint))
          issue(['joints', index, 'joint'], 'Duplicate clip joint');
        seen.add(track.joint);
        return { path: ['joints', index, 'keys'], keys: track.keys };
      }),
    ];
    for (const { path, keys } of tracks)
      keys.forEach((key, index) => {
        if (
          (index === 0 && key.time !== 0) ||
          key.time > clip.duration ||
          (index > 0 && key.time <= keys[index - 1]!.time)
        )
          issue(
            [...path, index, 'time'],
            'Clip keys must start at zero and increase within the clip duration',
          );
        if (key.bezier && key.interpolation !== 'linear')
          issue(
            [...path, index, 'bezier'],
            'A custom Bézier curve replaces the named interpolation; omit interpolation or use linear',
          );
      });
  });

const PrimitiveSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('head-turn'),
      degrees: z.number().min(-75).max(75),
    })
    .strict(),
  z
    .object({
      kind: z.literal('torso-turn'),
      degrees: z.number().min(-35).max(35),
    })
    .strict(),
  z
    .object({
      kind: z.literal('arm-gesture'),
      side: z.enum(['left', 'right']),
      upperArm: JointRotationSchema,
      forearm: JointRotationSchema,
    })
    .strict(),
  z
    .object({ kind: z.literal('body-position'), offset: MotionVectorSchema })
    .strict(),
]);

export const MotionLayerSchema = z
  .object({
    id: StableIdSchema,
    startFrame: z.number().int().nonnegative().safe(),
    endFrame: z.number().int().nonnegative().safe(),
    source: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('clip'), clipId: StableIdSchema }).strict(),
      z
        .object({
          kind: z.literal('primitive'),
          primitive: PrimitiveSchema,
          duration: Seconds.positive(),
        })
        .strict(),
    ]),
    speed: z.number().min(0.05).max(20).default(1),
    loop: z.boolean().default(false),
    weight: z.number().positive().max(1).default(1),
    fadeIn: Seconds.default(0),
    fadeOut: Seconds.default(0),
    blend: z.enum(['replace', 'additive']).default('replace'),
    mask: z.array(StableIdSchema).min(1).max(128).optional(),
  })
  .strict()
  .refine((layer) => layer.endFrame > layer.startFrame, {
    path: ['endFrame'],
    message: 'Motion layer endFrame must be after startFrame',
  });

export type SkeletalClip = z.infer<typeof SkeletalClipSchema>;
export type MotionLayer = z.infer<typeof MotionLayerSchema>;
export type MotionVector = [number, number, number];
// Quaternion components are ordered W, X, Y, Z.
export type MotionQuaternion = [number, number, number, number];

export interface SampledSkeletalMotion {
  rootPosition?: MotionVector[];
  rootRotation?: MotionQuaternion[];
  rootScale?: number[];
  joints: { joint: string; rotations: MotionQuaternion[] }[];
}
