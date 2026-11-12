import { z } from 'zod';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';
import { UnitColorSchema } from './shared-internal.js';

const fraction = z.number().min(0).max(1);
const TextureSchema = z
  .object({
    asset: AssetVersionReferenceSchema,
    scale: z.number().positive().max(1000).optional(),
  })
  .strict();

const surface = {
  color: UnitColorSchema,
  metallic: fraction.default(0),
  opacity: fraction.optional(),
  ior: z.number().min(1).max(4).optional(),
  transmission: fraction.optional(),
  emission: z
    .object({ color: UnitColorSchema, strength: z.number().min(0).max(1000) })
    .strict()
    .optional(),
  textures: z
    .object({
      color: TextureSchema.optional(),
      roughness: TextureSchema.optional(),
      metallic: TextureSchema.optional(),
      opacity: TextureSchema.optional(),
    })
    .strict()
    .optional(),
  procedural: z
    .object({
      kind: z.enum(['noise', 'checker']),
      scale: z.number().positive().max(1000),
      color: UnitColorSchema,
    })
    .strict()
    .optional(),
};

export const MaterialSchema = z
  .object({
    id: StableIdSchema,
    ...surface,
    roughness: fraction.default(0.65),
  })
  .strict();

export const CharacterMaterialSchema = z
  .object({
    ...surface,
    roughness: fraction.default(0.72),
  })
  .strict();
