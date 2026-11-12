import { z } from 'zod';
import { UnitColorSchema } from './shared-internal.js';
import { AssetVersionReferenceSchema } from './identifiers.js';

export const VisualSettingsSchema = z
  .object({
    exposure: z.number().min(-10).max(10).optional(),
    defaultLights: z.boolean().optional(),
    environment: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('color'),
            color: UnitColorSchema,
            strength: z.number().min(0).max(100),
          })
          .strict(),
        z
          .object({
            kind: z.literal('image'),
            asset: AssetVersionReferenceSchema,
            strength: z.number().min(0).max(100),
            rotationDegrees: z.number().min(-360).max(360).optional(),
          })
          .strict(),
      ])
      .optional(),
    saturation: z.number().min(0).max(2).optional(),
    roughnessScale: z.number().positive().max(4).optional(),
    celBands: z.number().int().min(2).max(8).optional(),
  })
  .strict();
export type VisualSettings = z.infer<typeof VisualSettingsSchema>;

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
    shading: z.enum(['physical', 'stylized', 'cel', 'charcoal']),
  })
  .strict();
export type StyleDefinition = z.infer<typeof StyleDefinitionSchema>;

export const STYLE_DEFINITION_REGISTRY = [
  StyleDefinitionSchema.parse({
    id: 'charcoal_horror',
    version: '1.2.0',
    shading: 'charcoal',
  }),
  StyleDefinitionSchema.parse({
    id: 'charcoal_horror',
    version: '2.0.0',
    shading: 'charcoal',
  }),
  StyleDefinitionSchema.parse({
    id: 'realistic_cgi',
    version: '1.0.0',
    shading: 'physical',
  }),
  StyleDefinitionSchema.parse({
    id: 'stylized_3d',
    version: '1.0.0',
    shading: 'stylized',
  }),
  StyleDefinitionSchema.parse({
    id: 'cel_shading',
    version: '1.0.0',
    shading: 'cel',
  }),
] as const;
