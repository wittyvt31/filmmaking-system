import { z } from 'zod';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';
import { RenderPolicySchema, VideoSettingsSchema } from './render-policy.js';
import { ShotSchema, TimelineInstructionsSchema } from './shots.js';
import { nonEmptyText } from './shared-internal.js';

export const PreparedScreenplaySchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    projectId: StableIdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    video: VideoSettingsSchema,
    renderPolicy: RenderPolicySchema,
    videoTrackId: StableIdSchema.default('video.main'),
    scenes: z
      .array(
        z
          .object({
            id: StableIdSchema,
            title: nonEmptyText,
            shots: z.array(ShotSchema).min(1),
          })
          .strict(),
      )
      .min(1),
    timeline: TimelineInstructionsSchema.optional(),
  })
  .strict();

export const ProductionPackageSchema = z
  .object({
    packageVersion: z.literal('1.0.0'),
    projectId: StableIdSchema,
    status: z.enum(['prepared', 'approved']),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    dependencySha256: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    dependencies: z.array(
      z
        .object({
          assetId: StableIdSchema,
          version: AssetVersionReferenceSchema.shape.version,
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          assetRecordSha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    approval: z
      .object({ approvedBy: nonEmptyText, approvedAt: z.iso.datetime() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((pkg, context) => {
    if (
      new Set(
        pkg.dependencies.map(({ assetId, version }) => `${assetId}@${version}`),
      ).size !== pkg.dependencies.length
    )
      context.addIssue({
        code: 'custom',
        path: ['dependencies'],
        message: 'Production package dependencies must be unique',
      });
    if ((pkg.status === 'approved') !== Boolean(pkg.approval))
      context.addIssue({
        code: 'custom',
        path: ['approval'],
        message:
          'Approved packages require approval metadata, and prepared packages must not contain it',
      });
  });

export type ProductionPackage = z.infer<typeof ProductionPackageSchema>;
export type PreparedScreenplay = z.infer<typeof PreparedScreenplaySchema>;
