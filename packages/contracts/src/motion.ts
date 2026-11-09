import { z } from 'zod';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';
import { nonEmptyText } from './shared-internal.js';

export const TransitionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('crossfade'),
      trackId: StableIdSchema,
      fromShotId: StableIdSchema,
      toShotId: StableIdSchema,
      durationFrames: z.number().int().positive().safe(),
    })
    .strict(),
  z
    .object({
      type: z.literal('wipe'),
      trackId: StableIdSchema,
      fromShotId: StableIdSchema,
      toShotId: StableIdSchema,
      durationFrames: z.number().int().positive().safe(),
      direction: z.enum(['left', 'right', 'up', 'down']),
    })
    .strict(),
  z
    .object({
      type: z.literal('dip-to-color'),
      trackId: StableIdSchema,
      fromShotId: StableIdSchema,
      toShotId: StableIdSchema,
      durationFrames: z.number().int().positive().safe(),
      color: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/, 'Expected a six-digit hex color'),
    })
    .strict(),
]);

export const ShotAudioCueSchema = z
  .object({
    id: StableIdSchema,
    asset: AssetVersionReferenceSchema,
    trackId: StableIdSchema,
    offsetFrames: z.number().int().nonnegative().safe(),
    durationFrames: z.number().int().positive().safe(),
    sourceOffsetFrames: z.number().int().nonnegative().safe().default(0),
    category: z
      .enum(['dialogue', 'narration', 'sound-effect', 'music'])
      .optional(),
    speakerId: StableIdSchema.optional(),
    text: nonEmptyText.optional(),
    lipSyncActionId: StableIdSchema.optional(),
  })
  .strict();

const SceneActionBaseSchema = z.object({
  id: StableIdSchema,
  startFrame: z.number().int().nonnegative().safe(),
  endFrame: z.number().int().positive().safe(),
});

export const CharacterActionSchema = z.discriminatedUnion('type', [
  SceneActionBaseSchema.extend({
    type: z.literal('breathing'),
    cycleFrames: z.number().int().positive().safe(),
    amplitude: z.number().positive().max(0.25),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('head-turn'),
    targetEntityId: StableIdSchema,
    maxYawDegrees: z.number().positive().max(90),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('blink'),
    intervalFrames: z.number().int().positive().safe().max(600),
    closureFrames: z.number().int().positive().safe().max(12),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('expression'),
    expressionId: z.enum(['neutral', 'worried', 'stern', 'fearful']),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('facial-variant'),
    slotId: StableIdSchema,
    variantId: StableIdSchema,
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('lip-sync'),
    visemes: z
      .array(
        z
          .object({
            startFrame: z.number().int().nonnegative().safe(),
            endFrame: z.number().int().positive().safe(),
            shape: z.enum(['closed', 'open', 'wide', 'round']),
          })
          .strict(),
      )
      .min(1),
  })
    .strict()
    .superRefine((action, context) => {
      let previousEnd = action.startFrame;
      for (const [index, viseme] of action.visemes.entries()) {
        if (
          viseme.endFrame <= viseme.startFrame ||
          viseme.startFrame < previousEnd ||
          viseme.startFrame < action.startFrame ||
          viseme.endFrame > action.endFrame
        )
          context.addIssue({
            code: 'custom',
            path: ['visemes', index],
            message:
              'Viseme intervals must be ordered, non-overlapping, and within the lip-sync action interval',
          });
        previousEnd = viseme.endFrame;
      }
    }),
  SceneActionBaseSchema.extend({
    type: z.literal('walk'),
    cycleFrames: z.number().int().positive().safe(),
    strideMeters: z.number().positive().max(2),
    distanceMeters: z.number().finite().min(-50).max(50),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('run'),
    cycleFrames: z.number().int().positive().safe(),
    strideMeters: z.number().positive().max(2.5),
    distanceMeters: z.number().finite().min(-50).max(50),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('jump'),
    heightMeters: z.number().positive().max(2),
    distanceMeters: z.number().finite().min(-50).max(50),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('kick'),
    leg: z.enum(['left', 'right']),
    targetEntityId: StableIdSchema,
    targetAnchorId: StableIdSchema.optional(),
    contactFrame: z.number().int().nonnegative().safe(),
    contactToleranceMeters: z.number().positive().max(0.5).default(0.08),
    targetImpulseMeters: z.number().positive().max(10).default(0.35),
    angleDegrees: z.number().positive().max(120),
  })
    .strict()
    .superRefine((action, context) => {
      if (action.contactFrame > action.endFrame - action.startFrame) {
        context.addIssue({
          code: 'custom',
          path: ['contactFrame'],
          message: 'Kick contactFrame must fall within the action interval',
        });
      }
    }),
  SceneActionBaseSchema.extend({
    type: z.literal('celebrate'),
    intensity: z.number().positive().max(1),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.enum(['sit', 'stand']),
    blendFrames: z.number().int().positive().safe().max(120),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('reach'),
    effector: z.enum(['left-hand', 'right-hand']),
    targetEntityId: StableIdSchema,
    targetAnchorId: StableIdSchema,
    handPose: z.enum(['open', 'relaxed']),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('grasp'),
    effector: z.enum(['left-hand', 'right-hand']),
    targetEntityId: StableIdSchema,
    targetAnchorId: StableIdSchema,
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('lift'),
    effector: z.enum(['left-hand', 'right-hand']),
    targetEntityId: StableIdSchema,
    targetAnchorId: StableIdSchema,
    verticalOffset: z.number().positive().max(2),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('place'),
    effector: z.enum(['left-hand', 'right-hand']),
    targetEntityId: StableIdSchema,
    targetAnchorId: StableIdSchema,
    targetPosition: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        z: z.number().finite(),
      })
      .strict(),
    targetRotationDegrees: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        z: z.number().finite(),
      })
      .strict()
      .optional(),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('interaction'),
    targetEntityId: StableIdSchema,
    interactionId: z.literal('look-at'),
    maxYawDegrees: z.number().positive().max(90).default(45),
  }).strict(),
  SceneActionBaseSchema.extend({
    type: z.literal('motion-clip'),
    library: AssetVersionReferenceSchema,
    clipId: StableIdSchema,
    playbackRate: z.number().positive().max(4).default(1),
    blendMode: z.enum(['replace', 'additive']).default('replace'),
  }).strict(),
]);

export const MotionClipLibrarySchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    libraryId: StableIdSchema,
    version: AssetVersionReferenceSchema.shape.version,
    clips: z
      .array(
        z
          .object({
            id: StableIdSchema,
            durationFrames: z.number().int().positive().safe(),
            rootMotion: z
              .object({
                control: z.enum(['root', 'hips']),
                channel: z.literal('location'),
                distance: z.tuple([
                  z.number().finite(),
                  z.number().finite(),
                  z.number().finite(),
                ]),
              })
              .strict()
              .optional(),
            tracks: z
              .array(
                z
                  .object({
                    control: z.enum([
                      'root',
                      'hips',
                      'chest',
                      'head',
                      'left-arm',
                      'right-arm',
                      'left-leg',
                      'right-leg',
                      'left-hand',
                      'right-hand',
                      'left-eye',
                      'right-eye',
                      'left-brow',
                      'right-brow',
                      'mouth',
                    ]),
                    channel: z.enum(['location', 'rotation', 'scale']),
                    region: z
                      .enum([
                        'root',
                        'torso',
                        'head',
                        'left-arm',
                        'right-arm',
                        'left-leg',
                        'right-leg',
                        'face',
                      ])
                      .optional(),
                    keyframes: z
                      .array(
                        z
                          .object({
                            frame: z.number().int().nonnegative().safe(),
                            value: z.tuple([
                              z.number().finite(),
                              z.number().finite(),
                              z.number().finite(),
                            ]),
                            interpolation: z
                              .enum([
                                'linear',
                                'ease-in',
                                'ease-out',
                                'ease-in-out',
                                'cubic-bezier',
                                'hold',
                              ])
                              .default('linear'),
                            bezier: z
                              .tuple([
                                z.number().min(0).max(1),
                                z.number().min(0).max(1),
                                z.number().min(0).max(1),
                                z.number().min(0).max(1),
                              ])
                              .optional(),
                          })
                          .strict(),
                      )
                      .min(2),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((library, context) => {
    const clipIds = new Set<string>();
    for (const [clipIndex, clip] of library.clips.entries()) {
      if (clipIds.has(clip.id))
        context.addIssue({
          code: 'custom',
          path: ['clips', clipIndex, 'id'],
          message: `Duplicate motion clip ID "${clip.id}"`,
        });
      clipIds.add(clip.id);
      for (const [trackIndex, track] of clip.tracks.entries()) {
        let lastFrame = -1;
        for (const [keyframeIndex, keyframe] of track.keyframes.entries()) {
          if (
            keyframe.frame <= lastFrame ||
            keyframe.frame > clip.durationFrames
          )
            context.addIssue({
              code: 'custom',
              path: [
                'clips',
                clipIndex,
                'tracks',
                trackIndex,
                'keyframes',
                keyframeIndex,
              ],
              message:
                'Motion keyframes must be strictly increasing and inside the clip duration',
            });
          lastFrame = keyframe.frame;
        }
      }
    }
  });

export type Transition = z.infer<typeof TransitionSchema>;
export type ShotAudioCue = z.infer<typeof ShotAudioCueSchema>;
export type CharacterAction = z.infer<typeof CharacterActionSchema>;
export type MotionClipLibrary = z.infer<typeof MotionClipLibrarySchema>;
