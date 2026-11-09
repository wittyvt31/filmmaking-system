import { z } from 'zod';
import { StableIdSchema } from './identifiers.js';
import { RenderPolicySchema, VideoSettingsSchema } from './render-policy.js';
import { ShotSchema, TimelineInstructionsSchema } from './shots.js';

export const ProjectManifestShapeSchema = z
  .object({
    projectId: StableIdSchema,
    version: z
      .string()
      .regex(
        /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
        'Expected a semantic project version',
      ),
    video: VideoSettingsSchema,
    renderPolicy: RenderPolicySchema,
    shots: z.array(ShotSchema).min(1),
    timeline: TimelineInstructionsSchema,
  })
  .strict();

export type ProjectManifestData = z.infer<typeof ProjectManifestShapeSchema>;
export type ManifestRefinementContext = Parameters<
  Parameters<typeof ProjectManifestShapeSchema.superRefine>[0]
>[1];
