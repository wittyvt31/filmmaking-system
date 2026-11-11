import { z } from 'zod';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';
import { RenderQualityOverridesSchema } from './render-policy.js';
import { ShotAudioCueSchema, TransitionSchema } from './motion.js';
import { ShotSceneSchema } from './scene.js';
import { nonEmptyText } from './shared-internal.js';

export const ShotSchema = z
  .object({
    id: StableIdSchema,
    durationFrames: z.number().int().positive().safe(),
    visualDescription: nonEmptyText,
    renderOverrides: RenderQualityOverridesSchema.optional(),
    composition: z
      .object({
        framing: nonEmptyText,
        subjectPlacement: nonEmptyText,
        cameraMovement: nonEmptyText,
        instructions: z.array(nonEmptyText),
      })
      .strict(),
    requiredAssets: z.array(AssetVersionReferenceSchema),
    scene: ShotSceneSchema.optional(),
    audioCues: z.array(ShotAudioCueSchema).optional(),
  })
  .strict();

export const VideoTrackSchema = z
  .object({
    id: StableIdSchema,
    clips: z
      .array(
        z
          .object({
            shotId: StableIdSchema,
            startFrame: z.number().int().nonnegative().safe(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const AudioTrackSchema = z
  .object({
    id: StableIdSchema,
  })
  .strict();

export const TimelineInstructionsSchema = z
  .object({
    durationFrames: z.number().int().positive().safe(),
    videoTracks: z.array(VideoTrackSchema).min(1),
    audioTracks: z.array(AudioTrackSchema),
    transitions: z.array(TransitionSchema),
  })
  .strict();

export type Shot = z.infer<typeof ShotSchema>;
export type VideoTrack = z.infer<typeof VideoTrackSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type TimelineInstructions = z.infer<typeof TimelineInstructionsSchema>;
