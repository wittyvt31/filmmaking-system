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
        camera: z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('static') }).strict(),
            z
              .object({
                type: z.literal('pan'),
                startFrame: z.number().int().nonnegative().safe(),
                durationFrames: z.number().int().positive().safe(),
                from: z
                  .object({
                    x: z.number().min(0).max(1),
                    y: z.number().min(0).max(1),
                  })
                  .strict(),
                to: z
                  .object({
                    x: z.number().min(0).max(1),
                    y: z.number().min(0).max(1),
                  })
                  .strict(),
              })
              .strict(),
            z
              .object({
                type: z.literal('zoom'),
                startFrame: z.number().int().nonnegative().safe(),
                durationFrames: z.number().int().positive().safe(),
                fromScale: z.number().positive().max(8),
                toScale: z.number().positive().max(8),
              })
              .strict(),
          ])
          .optional(),
        instructions: z.array(nonEmptyText),
      })
      .strict(),
    requiredAssets: z.array(AssetVersionReferenceSchema),
    visualElements: z
      .array(
        z
          .object({
            id: StableIdSchema,
            asset: AssetVersionReferenceSchema,
            role: z.enum(['background', 'character', 'prop']),
            position: z
              .object({
                x: z.number().min(0).max(1),
                y: z.number().min(0).max(1),
              })
              .strict(),
            scale: z.number().positive().max(8),
            zIndex: z.number().int().min(-1000).max(1000),
            animation: z.discriminatedUnion('type', [
              z.object({ type: z.literal('static') }).strict(),
              z
                .object({
                  type: z.literal('fade-in'),
                  startFrame: z.number().int().nonnegative().safe(),
                  durationFrames: z.number().int().positive().safe(),
                })
                .strict(),
              z
                .object({
                  type: z.literal('slide-in'),
                  startFrame: z.number().int().nonnegative().safe(),
                  durationFrames: z.number().int().positive().safe(),
                  direction: z.enum(['left', 'right', 'up', 'down']),
                })
                .strict(),
              z
                .object({
                  type: z.literal('float'),
                  startFrame: z.number().int().nonnegative().safe(),
                  durationFrames: z.number().int().positive().safe(),
                  amplitudePx: z.number().positive().max(256),
                })
                .strict(),
              z
                .object({
                  type: z.literal('pulse'),
                  startFrame: z.number().int().nonnegative().safe(),
                  durationFrames: z.number().int().positive().safe(),
                  minimumScale: z.number().positive().max(8),
                  maximumScale: z.number().positive().max(8),
                })
                .strict(),
            ]),
          })
          .strict(),
      )
      .optional(),
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
