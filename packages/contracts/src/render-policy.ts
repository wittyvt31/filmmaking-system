import { z } from 'zod';
import { greatestCommonDivisor } from './shared-internal.js';

export const RationalSchema = z
  .object({
    numerator: z.number().int().positive().safe(),
    denominator: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine(({ numerator, denominator }, context) => {
    if (greatestCommonDivisor(numerator, denominator) !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Rational values must be reduced to lowest terms',
      });
    }
  });

export const VideoSettingsSchema = z
  .object({
    resolution: z
      .object({
        width: z.number().int().positive().safe(),
        height: z.number().int().positive().safe(),
      })
      .strict(),
    frameRate: RationalSchema,
  })
  .strict();

const QualitySettingsSchema = z.discriminatedUnion('mode', [
  z
    .object({ mode: z.literal('crf'), value: z.number().int().min(0).max(63) })
    .strict(),
  z
    .object({
      mode: z.literal('bitrate'),
      bitsPerSecond: z.number().int().positive().safe(),
    })
    .strict(),
  z.object({ mode: z.literal('lossless') }).strict(),
]);

const BlenderRendererConfigurationSchema = z
  .object({
    executablePath: z.string().min(1).optional(),
    engine: z
      .enum(['BLENDER_EEVEE', 'CYCLES', 'BLENDER_WORKBENCH'])
      .default('BLENDER_EEVEE'),
    device: z
      .enum(['AUTO', 'CPU', 'OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'])
      .default('AUTO'),
    samples: z.number().int().positive().max(4096).optional(),
    denoising: z.boolean().default(false),
  })
  .strict();

export const RenderQualityProfileSchema = z.enum([
  'draft',
  'preview',
  'final',
  'flat',
]);
export const RenderQualityOverridesSchema = z
  .object({
    width: z.number().int().positive().safe().optional(),
    height: z.number().int().positive().safe().optional(),
    frameRate: RationalSchema.optional(),
    samples: z.number().int().positive().max(4096).optional(),
    denoising: z.boolean().optional(),
    shadows: z.enum(['off', 'low', 'high']).optional(),
    textures: z.enum(['low', 'medium', 'high']).optional(),
    compositing: z.boolean().optional(),
    glow: z.boolean().optional(),
    finalGrade: z.boolean().optional(),
  })
  .strict();

export const RenderExecutionSchema = z
  .object({
    shotConcurrency: z.number().int().min(1).max(16).default(1),
    frameWorkers: z.number().int().min(1).max(16).default(1),
    retryAttempts: z.number().int().min(1).max(3).default(1),
  })
  .strict();

export const QualityProfilePostProcessingSchema = z
  .object({
    glow: z.boolean().optional(),
    finalGrade: z.boolean().optional(),
  })
  .strict();

export const RendererSelectionSchema = z
  .object({
    id: z.literal('blender'),
    config: BlenderRendererConfigurationSchema,
  })
  .strict();

export const RenderPolicySchema = z
  .object({
    outputDimensions: z
      .object({
        width: z.number().int().positive().safe(),
        height: z.number().int().positive().safe(),
      })
      .strict(),
    frameRate: RationalSchema,
    codec: z.enum(['h264', 'hevc', 'prores', 'vp9', 'av1']),
    container: z.enum(['mp4', 'mov', 'webm']),
    pixelFormat: z.enum(['yuv420p', 'yuv422p10le', 'yuv444p10le', 'rgb24']),
    colorProfile: z.enum(['bt709', 'display-p3', 'bt2020']),
    quality: QualitySettingsSchema,
    qualityProfile: RenderQualityProfileSchema.optional(),
    qualityOverrides: RenderQualityOverridesSchema.optional(),
    qualityPostProcessing: z
      .object({
        draft: QualityProfilePostProcessingSchema.optional(),
        preview: QualityProfilePostProcessingSchema.optional(),
        final: QualityProfilePostProcessingSchema.optional(),
        flat: QualityProfilePostProcessingSchema.optional(),
      })
      .strict()
      .optional(),
    execution: RenderExecutionSchema.optional(),
    renderer: RendererSelectionSchema,
  })
  .strict()
  .refine(
    ({ codec, container }) => {
      const supportedContainers = {
        h264: ['mp4', 'mov'],
        hevc: ['mp4', 'mov'],
        prores: ['mov'],
        vp9: ['webm'],
        av1: ['mp4', 'webm'],
      } as const;
      return (supportedContainers[codec] as readonly string[]).includes(
        container,
      );
    },
    {
      path: ['container'],
      message: 'Container is not supported by the selected codec',
    },
  );

export type Rational = z.infer<typeof RationalSchema>;
export type VideoSettings = z.infer<typeof VideoSettingsSchema>;
export type RenderPolicy = z.infer<typeof RenderPolicySchema>;
export type RendererSelection = z.infer<typeof RendererSelectionSchema>;
export type RenderExecution = z.infer<typeof RenderExecutionSchema>;

/** Projection and rasterization must use the same dimensions before encoding. */
export function resolveShotRenderDimensions(
  policy: Pick<
    RenderPolicy,
    'outputDimensions' | 'qualityProfile' | 'qualityOverrides'
  >,
  shotOverrides?: RenderPolicy['qualityOverrides'],
) {
  const overrides = { ...policy.qualityOverrides, ...shotOverrides };
  const dimensions = policy.outputDimensions;
  const finalScale = Math.max(
    1,
    1920 / dimensions.width,
    1080 / dimensions.height,
  );
  const base =
    policy.qualityProfile === 'draft' || policy.qualityProfile === 'flat'
      ? { width: 854, height: 480 }
      : policy.qualityProfile === 'preview'
        ? { width: 1280, height: 720 }
        : policy.qualityProfile === 'final'
          ? {
              width: Math.ceil((dimensions.width * finalScale) / 2) * 2,
              height: Math.ceil((dimensions.height * finalScale) / 2) * 2,
            }
          : dimensions;
  const scale = overrides.width
    ? overrides.width / base.width
    : overrides.height
      ? overrides.height / base.height
      : 1;
  return {
    width: overrides.width ?? Math.ceil((base.width * scale) / 2) * 2,
    height: overrides.height ?? Math.ceil((base.height * scale) / 2) * 2,
  };
}
