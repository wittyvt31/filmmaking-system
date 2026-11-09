import { z } from 'zod';

export const StableIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Must be a stable identifier');

export const AssetVersionReferenceSchema = z
  .object({
    assetId: StableIdSchema,
    version: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._+-]*$/,
        'Must identify an immutable asset version',
      )
      .refine(
        (value) => !['latest', 'current', 'head'].includes(value.toLowerCase()),
        {
          message: 'Mutable version aliases are not allowed',
        },
      ),
  })
  .strict();

export type AssetVersionReference = z.infer<typeof AssetVersionReferenceSchema>;
