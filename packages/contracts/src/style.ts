import { z } from 'zod';
import { UnitColorSchema } from './shared-internal.js';

export const CharcoalStyleOverridesSchema = z
  .object({
    palette: z
      .object({
        shadow: UnitColorSchema.optional(),
        graphite: UnitColorSchema.optional(),
        paper: UnitColorSchema.optional(),
      })
      .strict()
      .optional(),
    lighting: z
      .object({
        keyColor: UnitColorSchema.optional(),
        keyEnergy: z.number().positive().max(5000).optional(),
        keySize: z.number().positive().max(50).optional(),
        keyPosition: z
          .tuple([
            z.number().finite(),
            z.number().finite(),
            z.number().finite(),
          ])
          .optional(),
        ambientFill: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    grainScale: z.number().positive().max(200).optional(),
    grainStrength: z.number().min(0).max(1).optional(),
    vignetteStrength: z.number().min(0).max(1).optional(),
    hazeStrength: z.number().min(0).max(1).optional(),
    paperFiberScale: z.number().positive().max(2000).optional(),
    paperOpacity: z.number().min(0).max(0.35).optional(),
    lineBoilStrength: z.number().min(0).max(1).optional(),
    boilFps: z.number().positive().max(240).optional(),
    edgeBreakup: z.number().min(0).max(1).optional(),
    edgeSoftness: z.number().min(0).max(1).optional(),
    shadowSmudge: z.number().min(0).max(1).optional(),
    graphiteSheen: z.number().min(0).max(1).optional(),
    contrastCurve: z
      .tuple([z.number().min(0).max(2), z.number().min(0).max(2)])
      .optional(),
    paperWhitePoint: z.number().min(0).max(1).optional(),
    hazeDrift: z.number().min(0).max(10).optional(),
    dustDensity: z.number().min(0).max(100).optional(),
    glow: z.boolean().optional(),
    finalGrade: z.boolean().optional(),
    shadows: z.enum(['off', 'contact', 'soft-cast']).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.contrastCurve && value.contrastCurve[0] >= value.contrastCurve[1])
      context.addIssue({
        code: 'custom',
        path: ['contrastCurve'],
        message: 'contrastCurve low point must be below its high point',
      });
  });
export type CharcoalStyleOverrides = z.infer<
  typeof CharcoalStyleOverridesSchema
>;

export const StyleDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    renderer: z.literal('blender'),
    parameters: z.record(z.string(), z.unknown()),
  })
  .strict();
export type StyleDefinition = z.infer<typeof StyleDefinitionSchema>;

export const STYLE_DEFINITION_REGISTRY = [
  StyleDefinitionSchema.parse({
    id: 'charcoal_horror',
    version: '1.2.0',
    renderer: 'blender',
    parameters: {},
  }),
  StyleDefinitionSchema.parse({
    id: 'charcoal_horror',
    version: '2.0.0',
    renderer: 'blender',
    parameters: {},
  }),
] as const;
