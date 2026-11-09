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
  })
  .strict();
export type CharcoalStyleOverrides = z.infer<
  typeof CharcoalStyleOverridesSchema
>;
