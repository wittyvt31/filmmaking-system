import { z } from 'zod';
import { StableIdSchema } from './identifiers.js';
import { UnitQuaternionSchema } from './interactions.js';
import {
  MotionInterpolationSchema,
  MotionVectorSchema,
} from './skeletal-motion.js';

const frame = z.number().int().nonnegative().safe();
const fraction = z.number().min(0).max(1);
const positive = z.number().min(0.001).max(100000);
const focal = z.number().min(1).max(2000);
const zero = (): [number, number, number] => [0, 0, 0];
export const CameraTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('point'), position: MotionVectorSchema }).strict(),
  z
    .object({
      kind: z.literal('entity'),
      entityId: StableIdSchema,
      joint: StableIdSchema.optional(),
      offset: MotionVectorSchema.default(zero),
    })
    .strict(),
]);
const Key = z.object({
  frame,
  interpolation: MotionInterpolationSchema.default('linear'),
  easing: z.tuple([fraction, fraction, fraction, fraction]).optional(),
});
const scalarKeys = (value: z.ZodNumber) =>
  z.array(Key.extend({ value }).strict()).min(1).max(1024);
const positionKeys = z
  .array(
    Key.extend({
      value: MotionVectorSchema,
      outControl: MotionVectorSchema.optional(),
      inControl: MotionVectorSchema.optional(),
    }).strict(),
  )
  .min(1)
  .max(1024);
const BehaviorSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['dolly', 'crane', 'pan', 'tilt']),
      keys: scalarKeys(z.number().min(-10000).max(10000)),
    })
    .strict(),
  z
    .object({
      kind: z.literal('orbit'),
      target: CameraTargetSchema,
      keys: scalarKeys(z.number().min(-10000).max(10000)),
    })
    .strict(),
  z
    .object({ kind: z.literal('tracking'), target: CameraTargetSchema })
    .strict(),
  z
    .object({
      kind: z.literal('handheld'),
      seed: z.number().int().min(0).max(0xffffffff),
      positionAmplitude: z.number().min(0).max(2),
      rotationAmplitude: z.number().min(0).max(30),
      frequencyHz: z.number().min(0.01).max(24),
    })
    .strict(),
]);
const CameraRigSchema = z
  .object({
    id: StableIdSchema,
    position: positionKeys,
    orientation: z
      .array(Key.extend({ value: UnitQuaternionSchema }).strict())
      .min(1)
      .max(1024)
      .optional(),
    lookAt: CameraTargetSchema.optional(),
    optics: z
      .object({
        focalLength: focal.default(50),
        focalLengthKeys: scalarKeys(focal).optional(),
        sensor: z
          .object({
            width: z.number().min(1).max(100),
            height: z.number().min(1).max(100),
            fit: z.enum(['horizontal', 'vertical']),
          })
          .strict()
          .default({ width: 36, height: 24, fit: 'horizontal' }),
        aperture: z.number().min(0.1).max(128).default(5.6),
        blades: z
          .union([z.literal(0), z.number().int().min(3).max(16)])
          .default(0),
        depthOfField: z.boolean().default(false),
        focus: z
          .discriminatedUnion('kind', [
            z
              .object({
                kind: z.literal('distance'),
                distance: positive,
                keys: scalarKeys(positive).optional(),
              })
              .strict(),
            z
              .object({ kind: z.literal('target'), target: CameraTargetSchema })
              .strict(),
          ])
          .default({ kind: 'distance', distance: 10 }),
        clipNear: positive.default(0.05),
        clipFar: positive.default(1000),
      })
      .strict()
      .prefault({}),
    behaviors: z.array(BehaviorSchema).max(16).default([]),
    framing: z
      .object({
        target: CameraTargetSchema,
        x: fraction.default(0.5),
        y: fraction.optional(),
        headroom: fraction.optional(),
      })
      .strict()
      .refine(
        (v) => v.y === undefined || v.headroom === undefined,
        'Choose screen y or headroom, not both',
      )
      .optional(),
    visibility: z
      .array(
        z
          .object({
            target: CameraTargetSchema,
            margin: z.number().min(0).max(0.49).default(0),
            occlusion: z.enum(['none', 'proxies']).default('none'),
          })
          .strict(),
      )
      .max(32)
      .default([]),
  })
  .strict();

export const CinematographySchema = z
  .object({
    type: z.literal('rigs'),
    rigs: z.array(CameraRigSchema).min(1).max(24),
    cuts: z
      .array(
        z
          .object({
            cameraId: StableIdSchema,
            startFrame: frame,
            endFrame: frame,
          })
          .strict(),
      )
      .min(1)
      .max(1024),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [i, rig] of value.rigs.entries()) {
      const issue = (field: string, message: string) =>
        ctx.addIssue({ code: 'custom', path: ['rigs', i, field], message });
      if (ids.has(rig.id)) issue('id', 'Duplicate camera rig');
      ids.add(rig.id);
      if (
        Number(!!rig.orientation) +
          Number(!!rig.lookAt) +
          Number(!!rig.framing) !==
        1
      )
        issue(
          'orientation',
          'Specify exactly one of orientation, lookAt or framing',
        );
      if (rig.optics.clipNear >= rig.optics.clipFar)
        issue('optics', 'Camera near clip must be below far clip');
      const tracks = [
        rig.position,
        rig.orientation,
        rig.optics.focalLengthKeys,
        rig.optics.focus.kind === 'distance'
          ? rig.optics.focus.keys
          : undefined,
        ...rig.behaviors.flatMap((b) => ('keys' in b ? [b.keys] : [])),
      ];
      if (
        tracks.some((keys) =>
          keys?.some((k, j) => j > 0 && k.frame <= keys[j - 1]!.frame),
        )
      )
        issue(
          'position',
          'Camera keyframes must be strictly increasing within each track',
        );
    }
    let end = 0;
    for (const [i, cut] of value.cuts.entries()) {
      if (
        !ids.has(cut.cameraId) ||
        cut.startFrame !== end ||
        cut.endFrame <= cut.startFrame
      )
        ctx.addIssue({
          code: 'custom',
          path: ['cuts', i],
          message:
            'Camera cuts must reference a rig and form consecutive nonempty ranges from frame 0',
        });
      end = cut.endFrame;
    }
  });

export type CameraRig = z.infer<typeof CameraRigSchema>;
export type CameraTarget = z.infer<typeof CameraTargetSchema>;
export type Cinematography = z.infer<typeof CinematographySchema>;
export interface CameraSample {
  position: z.infer<typeof MotionVectorSchema>;
  orientation: z.infer<typeof UnitQuaternionSchema>;
  focalLength: number;
  focusDistance: number;
}
export interface CompiledCinematography {
  aspect: number;
  rigs: {
    id: string;
    optics: Omit<
      CameraRig['optics'],
      'focalLengthKeys' | 'focus' | 'focalLength'
    >;
    frames: CameraSample[];
  }[];
  cuts: Cinematography['cuts'];
}

export function cameraFitsShot(camera: Cinematography, durationFrames: number) {
  return (
    camera.cuts.at(-1)?.endFrame === durationFrames &&
    camera.rigs.every((rig) =>
      [
        rig.position,
        rig.orientation,
        rig.optics.focalLengthKeys,
        rig.optics.focus.kind === 'distance'
          ? rig.optics.focus.keys
          : undefined,
        ...rig.behaviors.flatMap((b) => ('keys' in b ? [b.keys] : [])),
      ].every((keys) => !keys || keys.at(-1)!.frame < durationFrames),
    )
  );
}
