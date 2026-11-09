import { z } from 'zod';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';

export const RigSemanticControlSchema = z.enum([
  'root',
  'hips',
  'torso',
  'chest',
  'head',
  'left-arm',
  'right-arm',
  'left-upper-arm',
  'right-upper-arm',
  'left-forearm',
  'right-forearm',
  'left-leg',
  'right-leg',
  'left-hand',
  'right-hand',
  'left-eye',
  'right-eye',
  'left-brow',
  'right-brow',
  'mouth',
  'hair',
  'cloth',
]);

export const CutoutRigDefinitionSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    rigId: StableIdSchema,
    version: AssetVersionReferenceSchema.shape.version,
    template: z.enum(['humanoid-cutout']),
    minimumSeamOverlapPixels: z.number().nonnegative().max(512).default(4),
    controls: z
      .array(
        z
          .object({
            id: RigSemanticControlSchema,
            parentId: RigSemanticControlSchema.optional(),
            pivot: z
              .object({ x: z.number().finite(), y: z.number().finite() })
              .strict(),
            zOrder: z.number().int().min(-1000).max(1000).default(0),
            limitsDegrees: z
              .object({
                min: z.number().finite().min(-360).max(360),
                max: z.number().finite().min(-360).max(360),
              })
              .strict()
              .optional(),
            seamOverlapPixels: z.number().nonnegative().max(512).optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((rig, context) => {
    const ids = new Set<string>();
    rig.controls.forEach((control, index) => {
      if (ids.has(control.id))
        context.addIssue({
          code: 'custom',
          path: ['controls', index, 'id'],
          message: `Duplicate rig control "${control.id}"`,
        });
      ids.add(control.id);
      if (control.parentId === control.id)
        context.addIssue({
          code: 'custom',
          path: ['controls', index, 'parentId'],
          message: 'A rig control cannot parent itself',
        });
      if (
        control.limitsDegrees &&
        control.limitsDegrees.min > control.limitsDegrees.max
      )
        context.addIssue({
          code: 'custom',
          path: ['controls', index, 'limitsDegrees'],
          message: 'Joint minimum must not exceed maximum',
        });
      if (
        control.seamOverlapPixels !== undefined &&
        control.seamOverlapPixels < rig.minimumSeamOverlapPixels
      )
        context.addIssue({
          code: 'custom',
          path: ['controls', index, 'seamOverlapPixels'],
          message: `Seam overlap is below rig minimum (${rig.minimumSeamOverlapPixels}px)`,
        });
    });
    for (const [index, control] of rig.controls.entries())
      if (control.parentId && !ids.has(control.parentId))
        context.addIssue({
          code: 'custom',
          path: ['controls', index, 'parentId'],
          message: `Unknown parent control "${control.parentId}"`,
        });
  });
