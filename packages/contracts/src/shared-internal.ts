import { z } from 'zod';

export const nonEmptyText = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'Must contain at least one non-whitespace character',
  });

export const UnitColorSchema = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);

export const SceneTransformSchema = z
  .object({
    position: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        z: z.number().finite(),
      })
      .strict(),
    rotationDegrees: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        z: z.number().finite(),
      })
      .strict(),
    scale: z.number().positive().max(100),
  })
  .strict();

export function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}
