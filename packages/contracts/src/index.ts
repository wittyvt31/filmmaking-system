import { createHash } from 'node:crypto';
import { canonicalizeEx } from 'json-canonicalize';
import { z } from 'zod';

const nonEmptyText = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'Must contain at least one non-whitespace character',
  });

const UnitColorSchema = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);
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

const ProceduralCharacterSpecSchema = z
  .object({
    assetId: StableIdSchema,
    version: AssetVersionReferenceSchema.shape.version,
    kind: z.literal('character'),
    displayName: nonEmptyText,
    heightMeters: z.number().positive().min(0.8).max(2.5),
    build: z.enum(['slender', 'average', 'stocky']),
    ageYears: z.number().int().min(18).max(100),
    hair: z.enum(['short-wavy', 'receding-wavy', 'bald']),
    facialHair: z.enum(['none', 'moustache', 'full-beard']),
    clothing: z.enum(['kurta-dhoti', 'kurta-pajama', 'shawl']),
    expression: z.enum(['neutral', 'worried', 'stern']),
    bodyProportions: z
      .object({
        headScale: z.number().min(0.7).max(1.4).default(1),
        shoulderWidth: z.number().min(0.7).max(1.4).default(1),
        armLength: z.number().min(0.7).max(1.4).default(1),
        legLength: z.number().min(0.7).max(1.4).default(1),
      })
      .strict()
      .optional(),
    materialOverrides: z
      .object({
        skin: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
        clothing: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
        hair: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ProceduralEnvironmentSpecSchema = z
  .object({
    assetId: StableIdSchema,
    version: AssetVersionReferenceSchema.shape.version,
    kind: z.literal('environment'),
    displayName: nonEmptyText,
    period: nonEmptyText,
    architectureType: z
      .enum(['interior-room', 'courtyard', 'exterior-facade'])
      .default('interior-room'),
    widthMeters: z.number().positive().max(30),
    depthMeters: z.number().positive().max(30),
    heightMeters: z.number().positive().max(12),
    features: z
      .array(
        z.enum([
          'timber-beams',
          'wooden-door',
          'barred-window',
          'roof-eaves',
          'column-porch',
          'stone-course',
        ]),
      )
      .min(1),
    materialOverrides: z
      .object({
        wall: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
        wood: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
        ground: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ProceduralFurnitureSpecSchema = z
  .object({
    assetId: StableIdSchema,
    version: AssetVersionReferenceSchema.shape.version,
    kind: z.literal('furniture'),
    displayName: nonEmptyText,
    furnitureType: z.enum([
      'chair',
      'table',
      'stool',
      'bench',
      'bed',
      'cabinet',
    ]),
    widthMeters: z.number().positive().max(5),
    heightMeters: z.number().positive().max(5),
    depthMeters: z.number().positive().max(5),
  })
  .strict();

const GeometryComponentBaseSchema = z.object({
  id: StableIdSchema,
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
  materialTone: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
});
const ProceduralGeometryComponentSchema = z.discriminatedUnion('type', [
  GeometryComponentBaseSchema.extend({
    type: z.literal('box'),
    dimensions: z.tuple([
      z.number().positive(),
      z.number().positive(),
      z.number().positive(),
    ]),
    bevel: z.number().min(0).max(1).default(0),
  }).strict(),
  GeometryComponentBaseSchema.extend({
    type: z.literal('ellipsoid'),
    radii: z.tuple([
      z.number().positive(),
      z.number().positive(),
      z.number().positive(),
    ]),
  }).strict(),
  GeometryComponentBaseSchema.extend({
    type: z.literal('cylinder'),
    radius: z.number().positive(),
    depth: z.number().positive(),
    vertices: z.number().int().min(6).max(64).default(16),
  }).strict(),
  GeometryComponentBaseSchema.extend({
    type: z.literal('stroke'),
    points: z
      .array(
        z.tuple([
          z.number().finite(),
          z.number().finite(),
          z.number().finite(),
        ]),
      )
      .min(2)
      .max(128),
    width: z.number().positive().max(0.2),
  }).strict(),
]);

const ProceduralPropSpecSchema = z
  .object({
    assetId: StableIdSchema,
    version: AssetVersionReferenceSchema.shape.version,
    kind: z.literal('prop'),
    displayName: nonEmptyText,
    propType: z.enum(['rotary-telephone', 'kerosene-lantern', 'custom']),
    scale: z.number().positive().max(5),
    geometry: z.array(ProceduralGeometryComponentSchema).default([]),
    anchors: z
      .array(
        z
          .object({
            id: StableIdSchema,
            position: z
              .object({
                x: z.number().finite(),
                y: z.number().finite(),
                z: z.number().finite(),
              })
              .strict(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const ProceduralAssetSpecificationSchema = z.discriminatedUnion('kind', [
  ProceduralCharacterSpecSchema,
  ProceduralEnvironmentSpecSchema,
  ProceduralFurnitureSpecSchema,
  ProceduralPropSpecSchema,
]);

export const AssetBuildSpecificationSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    projectId: StableIdSchema,
    seed: z.number().int().nonnegative().safe(),
    style: z
      .object({
        id: z.literal('charcoal_horror'),
        version: AssetVersionReferenceSchema.shape.version,
        overrides: CharcoalStyleOverridesSchema.optional(),
      })
      .strict(),
    assets: z.array(ProceduralAssetSpecificationSchema).min(1),
  })
  .strict()
  .superRefine((specification, context) => {
    const ids = new Set<string>();
    for (const [index, asset] of specification.assets.entries()) {
      if (ids.has(asset.assetId))
        context.addIssue({
          code: 'custom',
          path: ['assets', index, 'assetId'],
          message: `Duplicate procedural asset ID "${asset.assetId}"`,
        });
      ids.add(asset.assetId);
      if (asset.kind === 'prop') {
        if (asset.propType === 'custom' && asset.geometry.length === 0) {
          context.addIssue({
            code: 'custom',
            path: ['assets', index, 'geometry'],
            message: 'Custom props require at least one geometry component',
          });
        }
        const componentIds = new Set<string>();
        for (const [componentIndex, component] of asset.geometry.entries()) {
          if (componentIds.has(component.id))
            context.addIssue({
              code: 'custom',
              path: ['assets', index, 'geometry', componentIndex, 'id'],
              message: `Duplicate prop component ID "${component.id}"`,
            });
          componentIds.add(component.id);
        }
        const anchorIds = new Set<string>();
        for (const [anchorIndex, anchor] of asset.anchors.entries()) {
          if (anchorIds.has(anchor.id))
            context.addIssue({
              code: 'custom',
              path: ['assets', index, 'anchors', anchorIndex, 'id'],
              message: `Duplicate prop anchor ID "${anchor.id}"`,
            });
          anchorIds.add(anchor.id);
        }
      }
    }
  });

export const RationalSchema = z
  .object({
    numerator: z.number().int().positive().safe(),
    denominator: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine(({ numerator, denominator }, context) => {
    if (greatestCommonDivisor(numerator, denominator) !== 1) {
      context.addIssue({
        code: 'custom',
        message: 'Rational values must be reduced to lowest terms',
      });
    }
  });

export const VideoSettingsSchema = z
  .object({
    resolution: z
      .object({
        width: z.number().int().positive().safe(),
        height: z.number().int().positive().safe(),
      })
      .strict(),
    frameRate: RationalSchema,
  })
  .strict();

const QualitySettingsSchema = z.discriminatedUnion('mode', [
  z
    .object({ mode: z.literal('crf'), value: z.number().int().min(0).max(63) })
    .strict(),
  z
    .object({
      mode: z.literal('bitrate'),
      bitsPerSecond: z.number().int().positive().safe(),
    })
    .strict(),
  z.object({ mode: z.literal('lossless') }).strict(),
]);

const RemotionRendererConfigurationSchema = z
  .object({
    compositionId: StableIdSchema,
    concurrency: z.number().int().positive().safe().optional(),
  })
  .strict();

const BlenderRendererConfigurationSchema = z
  .object({
    executablePath: z.string().min(1).optional(),
    engine: z
      .enum(['BLENDER_EEVEE', 'CYCLES', 'BLENDER_WORKBENCH'])
      .default('BLENDER_EEVEE'),
    device: z
      .enum(['AUTO', 'CPU', 'OPTIX', 'CUDA', 'HIP', 'METAL', 'ONEAPI'])
      .default('AUTO'),
    samples: z.number().int().positive().max(4096).optional(),
    denoising: z.boolean().default(false),
  })
  .strict();

export const RenderQualityProfileSchema = z.enum(['draft', 'preview', 'final']);
export const RenderQualityOverridesSchema = z
  .object({
    width: z.number().int().positive().safe().optional(),
    height: z.number().int().positive().safe().optional(),
    frameRate: RationalSchema.optional(),
    samples: z.number().int().positive().max(4096).optional(),
    denoising: z.boolean().optional(),
    shadows: z.enum(['off', 'low', 'high']).optional(),
    textures: z.enum(['low', 'medium', 'high']).optional(),
    compositing: z.boolean().optional(),
  })
  .strict();

export const RendererSelectionSchema = z.discriminatedUnion('id', [
  z
    .object({
      id: z.literal('remotion'),
      config: RemotionRendererConfigurationSchema,
    })
    .strict(),
  z
    .object({
      id: z.literal('blender'),
      config: BlenderRendererConfigurationSchema,
    })
    .strict(),
]);

export const RenderPolicySchema = z
  .object({
    outputDimensions: z
      .object({
        width: z.number().int().positive().safe(),
        height: z.number().int().positive().safe(),
      })
      .strict(),
    frameRate: RationalSchema,
    codec: z.enum(['h264', 'hevc', 'prores', 'vp9', 'av1']),
    container: z.enum(['mp4', 'mov', 'webm']),
    pixelFormat: z.enum(['yuv420p', 'yuv422p10le', 'yuv444p10le', 'rgb24']),
    colorProfile: z.enum(['bt709', 'display-p3', 'bt2020']),
    quality: QualitySettingsSchema,
    qualityProfile: RenderQualityProfileSchema.optional(),
    qualityOverrides: RenderQualityOverridesSchema.optional(),
    renderer: RendererSelectionSchema,
  })
  .strict()
  .refine(
    ({ codec, container }) => {
      const supportedContainers = {
        h264: ['mp4', 'mov'],
        hevc: ['mp4', 'mov'],
        prores: ['mov'],
        vp9: ['webm'],
        av1: ['mp4', 'webm'],
      } as const;
      return (supportedContainers[codec] as readonly string[]).includes(
        container,
      );
    },
    {
      path: ['container'],
      message: 'Container is not supported by the selected codec',
    },
  );

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

const SceneTransformSchema = z
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
                    region: z.enum(['root', 'torso', 'head', 'left-arm', 'right-arm', 'left-leg', 'right-leg', 'face']).optional(),
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
                            interpolation: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out', 'cubic-bezier', 'hold']).default('linear'),
                            bezier: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
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

const NormalizedPivotSchema = z
  .object({
    x: z.number().finite().min(0).max(1).default(0.5),
    y: z.number().finite().min(0).max(1).default(0.5),
  })
  .strict();

const SceneGroupSchema = z
  .object({
    id: StableIdSchema,
    parentId: StableIdSchema.optional(),
    transform: SceneTransformSchema,
  })
  .strict();

const SceneLayerSchema = z
  .object({
    id: StableIdSchema,
    asset: AssetVersionReferenceSchema,
    role: z.enum(['character', 'prop', 'foreground']),
    parentId: StableIdSchema.optional(),
    transform: SceneTransformSchema,
    pivot: NormalizedPivotSchema.default({ x: 0.5, y: 0.5 }),
    size: z
      .object({
        width: z.number().positive().max(1000),
        height: z.number().positive().max(1000),
      })
      .strict()
      .optional(),
    opacity: z.number().finite().min(0).max(1).default(1),
    order: z.number().int().safe().min(-1000).max(1000).default(0),
  })
  .strict();

const SceneCameraTargetSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();

const SceneCameraSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('push-in'),
      startFrame: z.number().int().nonnegative().safe(),
      durationFrames: z.number().int().positive().safe(),
      fromDistance: z.number().positive(),
      toDistance: z.number().positive(),
      target: SceneCameraTargetSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('pan'),
      startFrame: z.number().int().nonnegative().safe(),
      durationFrames: z.number().int().positive().safe(),
      distance: z.number().positive(),
      fromTarget: SceneCameraTargetSchema,
      toTarget: SceneCameraTargetSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('zoom'),
      startFrame: z.number().int().nonnegative().safe(),
      durationFrames: z.number().int().positive().safe(),
      distance: z.number().positive(),
      target: SceneCameraTargetSchema,
      fromFocalLength: z.number().positive().min(10).max(300),
      toFocalLength: z.number().positive().min(10).max(300),
    })
    .strict(),
  z
    .object({
      type: z.literal('static'),
      distance: z.number().positive(),
      target: SceneCameraTargetSchema,
      focalLength: z.number().positive().min(10).max(300).default(50),
    })
    .strict(),
]);

const SceneLightBaseSchema = z.object({
  id: StableIdSchema,
  position: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      z: z.number().finite(),
    })
    .strict(),
  target: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      z: z.number().finite(),
    })
    .strict(),
  color: UnitColorSchema,
  energy: z.number().positive().max(100_000),
});
const SceneLightSchema = z.discriminatedUnion('type', [
  SceneLightBaseSchema.extend({
    type: z.literal('area'),
    size: z.number().positive().max(100),
  }).strict(),
  SceneLightBaseSchema.extend({
    type: z.literal('point'),
    radius: z.number().min(0).max(100),
  }).strict(),
  SceneLightBaseSchema.extend({
    type: z.literal('spot'),
    coneAngleRadians: z.number().positive().max(Math.PI),
  }).strict(),
]);

export const ShotSceneSchema = z
  .object({
    stylePreset: z.literal('charcoal_horror'),
    styleVersion: AssetVersionReferenceSchema.shape.version.default('1.2.0'),
    animationLibraryVersion:
      AssetVersionReferenceSchema.shape.version.default('1.0.0'),
    styleOverrides: CharcoalStyleOverridesSchema.optional(),
    motionLibraries: z.array(AssetVersionReferenceSchema).default([]),
    environment: AssetVersionReferenceSchema,
    groups: z.array(SceneGroupSchema).default([]),
    layers: z.array(SceneLayerSchema).default([]),
    characters: z
      .array(
        z
          .object({
            id: StableIdSchema,
            artwork: AssetVersionReferenceSchema,
            rig: AssetVersionReferenceSchema.optional(),
            transform: SceneTransformSchema,
            actions: z.array(CharacterActionSchema).default([]),
          })
          .strict(),
      )
      .default([]),
    props: z
      .array(
        z
          .object({
            id: StableIdSchema,
            artwork: AssetVersionReferenceSchema,
            transform: SceneTransformSchema,
          })
          .strict(),
      )
      .default([]),
    lights: z.array(SceneLightSchema).default([]),
    camera: SceneCameraSchema,
  })
  .strict()
  .superRefine((scene, context) => {
    const lightIds = new Set<string>();
    scene.lights.forEach((light, index) => {
      if (lightIds.has(light.id))
        context.addIssue({
          code: 'custom',
          path: ['lights', index, 'id'],
          message: `Duplicate light ID "${light.id}"`,
        });
      lightIds.add(light.id);
    });
    if (
      scene.camera.type === 'push-in' &&
      scene.camera.toDistance >= scene.camera.fromDistance
    ) {
      context.addIssue({
        code: 'custom',
        path: ['camera', 'toDistance'],
        message: 'A push-in must end closer to the subject than it begins',
      });
    }
    const nodes = [
      ...scene.groups.map((node) => ({ ...node, kind: 'group' as const })),
      ...scene.layers.map((node) => ({ ...node, kind: 'layer' as const })),
    ];
    const nodeIds = new Set<string>();
    for (const [index, node] of nodes.entries()) {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: 'custom',
          path: [node.kind === 'group' ? 'groups' : 'layers', index, 'id'],
          message: `Duplicate artwork node ID "${node.id}"`,
        });
      }
      nodeIds.add(node.id);
    }
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    for (const [index, node] of nodes.entries()) {
      if (node.parentId && !nodeById.has(node.parentId)) {
        context.addIssue({
          code: 'custom',
          path: [
            node.kind === 'group' ? 'groups' : 'layers',
            index,
            'parentId',
          ],
          message: `Artwork node "${node.id}" has unknown parent "${node.parentId}"`,
        });
      }
      const ancestry = new Set([node.id]);
      let parentId = node.parentId;
      while (parentId) {
        if (ancestry.has(parentId)) {
          context.addIssue({
            code: 'custom',
            path: [
              node.kind === 'group' ? 'groups' : 'layers',
              index,
              'parentId',
            ],
            message: `Artwork hierarchy contains a cycle at "${parentId}"`,
          });
          break;
        }
        ancestry.add(parentId);
        parentId = nodeById.get(parentId)?.parentId;
      }
    }
  });

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

export const ProjectManifestSchema = z
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
  .strict()
  .superRefine((manifest, context) => {
    const issue = (path: (string | number)[], message: string) => {
      context.addIssue({ code: 'custom', path, message });
    };
    const shotById = new Map<string, (typeof manifest.shots)[number]>();
    manifest.shots.forEach((shot, index) => {
      if (shotById.has(shot.id)) {
        issue(['shots', index, 'id'], `Duplicate shot ID "${shot.id}"`);
      } else {
        shotById.set(shot.id, shot);
      }
    });

    const trackIds = new Set<string>();
    manifest.timeline.videoTracks.forEach((track, index) => {
      if (trackIds.has(track.id))
        issue(
          ['timeline', 'videoTracks', index, 'id'],
          `Duplicate track ID "${track.id}"`,
        );
      trackIds.add(track.id);
    });
    manifest.timeline.audioTracks.forEach((track, index) => {
      if (trackIds.has(track.id))
        issue(
          ['timeline', 'audioTracks', index, 'id'],
          `Duplicate track ID "${track.id}"`,
        );
      trackIds.add(track.id);
    });

    const clipsByShot = new Map<
      string,
      { trackId: string; startFrame: number; endFrame: number; index: number }[]
    >();
    const clipsByTrack = new Map<
      string,
      { shotId: string; startFrame: number; endFrame: number; index: number }[]
    >();
    manifest.timeline.videoTracks.forEach((track, trackIndex) => {
      const clips = clipsByTrack.get(track.id) ?? [];
      track.clips.forEach((clip, clipIndex) => {
        const shot = shotById.get(clip.shotId);
        if (!shot) {
          issue(
            [
              'timeline',
              'videoTracks',
              trackIndex,
              'clips',
              clipIndex,
              'shotId',
            ],
            `Unknown shot ID "${clip.shotId}"`,
          );
          return;
        }
        const endFrame = clip.startFrame + shot.durationFrames;
        if (
          !Number.isSafeInteger(endFrame) ||
          endFrame > manifest.timeline.durationFrames
        ) {
          issue(
            ['timeline', 'videoTracks', trackIndex, 'clips', clipIndex],
            'Clip end must be within timeline duration',
          );
        }
        clips.push({
          shotId: clip.shotId,
          startFrame: clip.startFrame,
          endFrame,
          index: clipIndex,
        });
        const placements = clipsByShot.get(clip.shotId) ?? [];
        placements.push({
          trackId: track.id,
          startFrame: clip.startFrame,
          endFrame,
          index: clipIndex,
        });
        clipsByShot.set(clip.shotId, placements);
      });
      clipsByTrack.set(track.id, clips);
    });

    for (const [shotId, shot] of shotById) {
      const placements = clipsByShot.get(shotId) ?? [];
      if (placements.length !== 1) {
        issue(
          ['shots', manifest.shots.indexOf(shot), 'id'],
          `Shot "${shotId}" must appear exactly once on a video track`,
        );
      }
    }

    const audioTrackIds = new Set(
      manifest.timeline.audioTracks.map((track) => track.id),
    );
    const cueIds = new Set<string>();
    manifest.shots.forEach((shot, shotIndex) => {
      const elementIds = new Set<string>();
      const requiredAssets = new Set(
        shot.requiredAssets.map(
          (asset) => `${asset.assetId}\u0000${asset.version}`,
        ),
      );
      for (const [elementIndex, element] of (
        shot.visualElements ?? []
      ).entries()) {
        if (elementIds.has(element.id)) {
          issue(
            ['shots', shotIndex, 'visualElements', elementIndex, 'id'],
            `Duplicate visual element ID "${element.id}"`,
          );
        }
        elementIds.add(element.id);
        if (
          !requiredAssets.has(
            `${element.asset.assetId}\u0000${element.asset.version}`,
          )
        ) {
          issue(
            ['shots', shotIndex, 'visualElements', elementIndex, 'asset'],
            'Visual element asset must also be listed in requiredAssets',
          );
        }
        if (
          element.animation.type !== 'static' &&
          element.animation.startFrame + element.animation.durationFrames >
            shot.durationFrames
        ) {
          issue(
            ['shots', shotIndex, 'visualElements', elementIndex, 'animation'],
            'Animation must fit within its shot duration',
          );
        }
        if (
          element.animation.type === 'pulse' &&
          element.animation.minimumScale > element.animation.maximumScale
        ) {
          issue(
            ['shots', shotIndex, 'visualElements', elementIndex, 'animation'],
            'Pulse minimumScale must not exceed maximumScale',
          );
        }
      }
      const camera = shot.composition.camera;
      if (
        camera &&
        camera.type !== 'static' &&
        camera.startFrame + camera.durationFrames > shot.durationFrames
      ) {
        issue(
          ['shots', shotIndex, 'composition', 'camera'],
          'Camera movement must fit within its shot duration',
        );
      }
      if (shot.scene) {
        if (manifest.renderPolicy.renderer.id !== 'blender') {
          issue(
            ['shots', shotIndex, 'scene'],
            'Structured scene instructions require the Blender renderer',
          );
        }
        const references = new Set(
          shot.requiredAssets.map(
            (reference) => `${reference.assetId}\u0000${reference.version}`,
          ),
        );
        const sceneReferences = [
          shot.scene.environment,
          ...shot.scene.motionLibraries,
          ...shot.scene.layers.map((layer) => layer.asset),
          ...shot.scene.characters.flatMap((character) => [
            character.artwork,
            ...(character.rig ? [character.rig] : []),
          ]),
          ...shot.scene.props.map((prop) => prop.artwork),
        ];
        for (const reference of sceneReferences) {
          if (
            !references.has(`${reference.assetId}\u0000${reference.version}`)
          ) {
            issue(
              ['shots', shotIndex, 'scene'],
              `Scene asset ${reference.assetId}@${reference.version} must also appear in requiredAssets`,
            );
          }
        }
        const entityIds = new Set<string>();
        for (const entityId of [
          ...shot.scene.groups.map((group) => group.id),
          ...shot.scene.layers.map((layer) => layer.id),
          ...shot.scene.characters.map((character) => character.id),
          ...shot.scene.props.map((prop) => prop.id),
        ]) {
          if (entityIds.has(entityId))
            issue(
              ['shots', shotIndex, 'scene'],
              `Duplicate scene entity ID "${entityId}"`,
            );
          entityIds.add(entityId);
        }
        if (
          shot.scene.camera.type !== 'static' &&
          shot.scene.camera.startFrame + shot.scene.camera.durationFrames >
            shot.durationFrames
        ) {
          issue(
            ['shots', shotIndex, 'scene', 'camera'],
            'Scene camera movement must fit within its shot duration',
          );
        }
        shot.scene.characters.forEach((character, characterIndex) => {
          if (character.actions.length > 0 && !character.rig) {
            issue(
              [
                'shots',
                shotIndex,
                'scene',
                'characters',
                characterIndex,
                'rig',
              ],
              'Character actions require a versioned rig asset',
            );
          }
          const actionIds = new Set<string>();
          character.actions.forEach((action, actionIndex) => {
            if (actionIds.has(action.id))
              issue(
                [
                  'shots',
                  shotIndex,
                  'scene',
                  'characters',
                  characterIndex,
                  'actions',
                  actionIndex,
                  'id',
                ],
                `Duplicate character action ID "${action.id}"`,
              );
            actionIds.add(action.id);
            if (
              action.endFrame <= action.startFrame ||
              action.endFrame > shot.durationFrames
            ) {
              issue(
                [
                  'shots',
                  shotIndex,
                  'scene',
                  'characters',
                  characterIndex,
                  'actions',
                  actionIndex,
                ],
                'Character action must have a positive interval within the shot',
              );
            }
            if (action.type === 'motion-clip') {
              const libraryKey = `${action.library.assetId}\u0000${action.library.version}`;
              if (
                !shot.scene?.motionLibraries.some(
                  (library) =>
                    `${library.assetId}\u0000${library.version}` === libraryKey,
                )
              )
                issue(
                  [
                    'shots',
                    shotIndex,
                    'scene',
                    'characters',
                    characterIndex,
                    'actions',
                    actionIndex,
                    'library',
                  ],
                  'Motion clip library must be pinned in scene.motionLibraries',
                );
            }
            if (
              (action.type === 'head-turn' ||
                action.type === 'interaction' ||
                action.type === 'reach' ||
                action.type === 'grasp' ||
                action.type === 'lift' ||
                action.type === 'place') &&
              !entityIds.has(action.targetEntityId)
            ) {
              issue(
                [
                  'shots',
                  shotIndex,
                  'scene',
                  'characters',
                  characterIndex,
                  'actions',
                  actionIndex,
                  'targetEntityId',
                ],
                `Unknown scene target "${action.targetEntityId}"`,
              );
            }
            if (
              action.type === 'reach' ||
              action.type === 'grasp' ||
              action.type === 'lift' ||
              action.type === 'place'
            ) {
              const earlierActions = character.actions.slice(0, actionIndex);
              const matching = earlierActions.filter(
                (candidate) =>
                  (candidate.type === 'reach' ||
                    candidate.type === 'grasp' ||
                    candidate.type === 'lift' ||
                    candidate.type === 'place') &&
                  candidate.effector === action.effector &&
                  candidate.targetEntityId === action.targetEntityId,
              );
              const previous = matching.at(-1);
              if (action.type === 'grasp' && previous?.type !== 'reach') {
                issue(
                  [
                    'shots',
                    shotIndex,
                    'scene',
                    'characters',
                    characterIndex,
                    'actions',
                    actionIndex,
                  ],
                  'A grasp must follow a reach to the same target using the same effector',
                );
              }
              if (action.type === 'lift' && previous?.type !== 'grasp') {
                issue(
                  [
                    'shots',
                    shotIndex,
                    'scene',
                    'characters',
                    characterIndex,
                    'actions',
                    actionIndex,
                  ],
                  'A lift must follow a grasp of the same target using the same effector',
                );
              }
              if (action.type === 'place' && previous?.type !== 'lift') {
                issue(
                  [
                    'shots',
                    shotIndex,
                    'scene',
                    'characters',
                    characterIndex,
                    'actions',
                    actionIndex,
                  ],
                  'A place must follow a lift of the same target using the same effector',
                );
              }
            }
          });
        });
      }
      shot.audioCues?.forEach((cue, cueIndex) => {
        if (cueIds.has(cue.id))
          issue(
            ['shots', shotIndex, 'audioCues', cueIndex, 'id'],
            `Duplicate audio cue ID "${cue.id}"`,
          );
        cueIds.add(cue.id);
        if (cue.category === 'dialogue' && (!cue.speakerId || !cue.text)) {
          issue(
            ['shots', shotIndex, 'audioCues', cueIndex],
            'Dialogue cues require both a speaker ID and prepared dialogue text',
          );
        }
        if (cue.category === 'narration' && !cue.text) {
          issue(
            ['shots', shotIndex, 'audioCues', cueIndex, 'text'],
            'Narration cues require prepared narration text',
          );
        }
        if (
          cue.speakerId &&
          !shot.scene?.characters.some(
            (character) => character.id === cue.speakerId,
          )
        ) {
          issue(
            ['shots', shotIndex, 'audioCues', cueIndex, 'speakerId'],
            `Unknown dialogue speaker "${cue.speakerId}"`,
          );
        }
        if (cue.lipSyncActionId) {
          const speaker = shot.scene?.characters.find(
            (character) => character.id === cue.speakerId,
          );
          const action = speaker?.actions.find(
            (candidate) =>
              candidate.id === cue.lipSyncActionId &&
              candidate.type === 'lip-sync',
          );
          if (!action) {
            issue(
              ['shots', shotIndex, 'audioCues', cueIndex, 'lipSyncActionId'],
              `Lip-sync action "${cue.lipSyncActionId}" must belong to the dialogue speaker`,
            );
          } else if (
            action.startFrame > cue.offsetFrames ||
            action.endFrame < cue.offsetFrames + cue.durationFrames
          ) {
            issue(
              ['shots', shotIndex, 'audioCues', cueIndex, 'lipSyncActionId'],
              'Lip-sync action must cover the complete dialogue cue interval',
            );
          }
        }
        if (!audioTrackIds.has(cue.trackId)) {
          issue(
            ['shots', shotIndex, 'audioCues', cueIndex, 'trackId'],
            `Unknown audio track ID "${cue.trackId}"`,
          );
        }
        if (cue.offsetFrames + cue.durationFrames > shot.durationFrames) {
          issue(
            ['shots', shotIndex, 'audioCues', cueIndex],
            'Audio cue must fit within its shot duration',
          );
        }
        const placement = clipsByShot.get(shot.id)?.[0];
        if (
          placement &&
          placement.startFrame + cue.offsetFrames + cue.durationFrames >
            manifest.timeline.durationFrames
        ) {
          issue(
            ['shots', shotIndex, 'audioCues', cueIndex],
            'Audio cue end must be within timeline duration',
          );
        }
      });
    });

    const transitions = new Map<
      string,
      (typeof manifest.timeline.transitions)[number]
    >();
    manifest.timeline.transitions.forEach((transition, index) => {
      const key = `${transition.trackId}\u0000${transition.fromShotId}\u0000${transition.toShotId}`;
      if (transitions.has(key))
        issue(
          ['timeline', 'transitions', index],
          'Duplicate transition for the same shot pair',
        );
      transitions.set(key, transition);
      const clips = clipsByTrack.get(transition.trackId);
      const from = clips?.find((clip) => clip.shotId === transition.fromShotId);
      const to = clips?.find((clip) => clip.shotId === transition.toShotId);
      if (!from || !to) {
        issue(
          ['timeline', 'transitions', index],
          'Transition shots must exist on the referenced video track',
        );
        return;
      }
      const overlapFrames =
        Math.min(from.endFrame, to.endFrame) -
        Math.max(from.startFrame, to.startFrame);
      if (
        from.startFrame >= to.startFrame ||
        overlapFrames !== transition.durationFrames
      ) {
        issue(
          ['timeline', 'transitions', index],
          'Transition duration must exactly match a forward overlap between its shots',
        );
      }
    });

    manifest.timeline.videoTracks.forEach((track, trackIndex) => {
      const clips = [...(clipsByTrack.get(track.id) ?? [])].sort(
        (left, right) =>
          left.startFrame - right.startFrame || left.index - right.index,
      );
      for (let leftIndex = 0; leftIndex < clips.length; leftIndex += 1) {
        const left = clips[leftIndex];
        if (!left) continue;
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < clips.length;
          rightIndex += 1
        ) {
          const right = clips[rightIndex];
          if (!right || right.startFrame >= left.endFrame) break;
          const key = `${track.id}\u0000${left.shotId}\u0000${right.shotId}`;
          if (!transitions.has(key)) {
            issue(
              ['timeline', 'videoTracks', trackIndex, 'clips', right.index],
              `Overlap between "${left.shotId}" and "${right.shotId}" requires an explicit transition`,
            );
          }
        }
      }
    });

    if (
      manifest.video.resolution.width !==
        manifest.renderPolicy.outputDimensions.width ||
      manifest.video.resolution.height !==
        manifest.renderPolicy.outputDimensions.height
    ) {
      issue(
        ['renderPolicy', 'outputDimensions'],
        'Render output dimensions must match global video settings',
      );
    }
    if (
      manifest.video.frameRate.numerator !==
        manifest.renderPolicy.frameRate.numerator ||
      manifest.video.frameRate.denominator !==
        manifest.renderPolicy.frameRate.denominator
    ) {
      issue(
        ['renderPolicy', 'frameRate'],
        'Render frame rate must match global video settings',
      );
    }
  });

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

export type AssetVersionReference = z.infer<typeof AssetVersionReferenceSchema>;
export type ProceduralAssetSpecification = z.infer<
  typeof ProceduralAssetSpecificationSchema
>;
export type AssetBuildSpecification = z.infer<
  typeof AssetBuildSpecificationSchema
>;

const ArtworkTransformSchema = z
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

export const RigSemanticControlSchema = z.enum([
  'root', 'hips', 'torso', 'chest', 'head',
  'left-arm', 'right-arm', 'left-upper-arm', 'right-upper-arm',
  'left-forearm', 'right-forearm', 'left-leg', 'right-leg',
  'left-hand', 'right-hand', 'left-eye', 'right-eye',
  'left-brow', 'right-brow', 'mouth', 'hair', 'cloth',
]);

export const CutoutRigDefinitionSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  rigId: StableIdSchema,
  version: AssetVersionReferenceSchema.shape.version,
  template: z.enum(['humanoid-cutout']),
  minimumSeamOverlapPixels: z.number().nonnegative().max(512).default(4),
  controls: z.array(z.object({
    id: RigSemanticControlSchema,
    parentId: RigSemanticControlSchema.optional(),
    pivot: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
    zOrder: z.number().int().min(-1000).max(1000).default(0),
    limitsDegrees: z.object({ min: z.number().finite().min(-360).max(360), max: z.number().finite().min(-360).max(360) }).strict().optional(),
    seamOverlapPixels: z.number().nonnegative().max(512).optional(),
  }).strict()).min(1),
}).strict().superRefine((rig, context) => {
  const ids = new Set<string>();
  rig.controls.forEach((control, index) => {
    if (ids.has(control.id)) context.addIssue({ code: 'custom', path: ['controls', index, 'id'], message: `Duplicate rig control "${control.id}"` });
    ids.add(control.id);
    if (control.parentId === control.id) context.addIssue({ code: 'custom', path: ['controls', index, 'parentId'], message: 'A rig control cannot parent itself' });
    if (control.limitsDegrees && control.limitsDegrees.min > control.limitsDegrees.max) context.addIssue({ code: 'custom', path: ['controls', index, 'limitsDegrees'], message: 'Joint minimum must not exceed maximum' });
    if (control.seamOverlapPixels !== undefined && control.seamOverlapPixels < rig.minimumSeamOverlapPixels) context.addIssue({ code: 'custom', path: ['controls', index, 'seamOverlapPixels'], message: `Seam overlap is below rig minimum (${rig.minimumSeamOverlapPixels}px)` });
  });
  for (const [index, control] of rig.controls.entries()) if (control.parentId && !ids.has(control.parentId)) context.addIssue({ code: 'custom', path: ['controls', index, 'parentId'], message: `Unknown parent control "${control.parentId}"` });
});

const ArtworkLayerProcessingSchema = z.object({
  featherPixels: z.number().int().nonnegative().max(32).default(0),
  smoothingPasses: z.number().int().nonnegative().max(8).default(0),
  fillHolesBelowPixels: z.number().int().nonnegative().max(100000).default(0),
  removeIslandsBelowPixels: z.number().int().nonnegative().max(100000).default(0),
  decontaminateEdges: z.boolean().default(false),
  alphaThreshold: z.number().min(0).max(1).default(0.01),
}).strict();

const ArtworkGroupSchema = z
  .object({
    id: StableIdSchema,
    parentId: StableIdSchema.optional(),
    transform: ArtworkTransformSchema,
  })
  .strict();

const ArtworkLayerSchema = z
  .object({
    id: StableIdSchema,
    source: AssetVersionReferenceSchema,
    manualMatte: AssetVersionReferenceSchema.optional(),
    processing: ArtworkLayerProcessingSchema.default(
      ArtworkLayerProcessingSchema.parse({}),
    ),
    parentId: StableIdSchema.optional(),
    transform: ArtworkTransformSchema,
    size: z
      .object({
        width: z.number().positive().max(100),
        height: z.number().positive().max(100),
      })
      .strict(),
    pivot: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .strict()
      .default({ x: 0.5, y: 0.5 }),
    opacity: z.number().min(0).max(1).default(1),
    order: z.number().int().min(-1000).max(1000).default(0),
    variantSlot: StableIdSchema.optional(),
    variantId: StableIdSchema.optional(),
  })
  .strict()
  .superRefine((layer, context) => {
    if (Boolean(layer.variantSlot) !== Boolean(layer.variantId))
      context.addIssue({
        code: 'custom',
        path: ['variantId'],
        message: 'Artwork variants require both variantSlot and variantId',
      });
  });

const ArtworkVariantSlotSchema = z
  .object({
    id: StableIdSchema,
    defaultVariant: StableIdSchema,
    variants: z
      .array(
        z
          .object({
            id: StableIdSchema,
            layerIds: z.array(StableIdSchema).min(1),
          })
          .strict(),
      )
      .min(2),
  })
  .strict();

const ArtworkAnchorSchema = z
  .object({
    id: StableIdSchema,
    parentId: StableIdSchema,
    position: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        z: z.number().finite(),
      })
      .strict(),
  })
  .strict();

const ArtworkComponentSchema = z.object({
  id: StableIdSchema,
  nodeId: StableIdSchema,
  displayName: nonEmptyText,
}).strict();

const ArtworkPackageAssetSchema = z
  .object({
    assetId: StableIdSchema,
    version: AssetVersionReferenceSchema.shape.version,
    kind: z.enum(['character', 'environment', 'prop']),
    displayName: nonEmptyText,
    groups: z.array(ArtworkGroupSchema).max(256).default([]),
    layers: z.array(ArtworkLayerSchema).min(1).max(512),
    variantSlots: z.array(ArtworkVariantSlotSchema).max(64).default([]),
    anchors: z.array(ArtworkAnchorSchema).max(256).default([]),
    components: z.array(ArtworkComponentSchema).max(128).default([]),
    rigId: StableIdSchema.optional(),
    resolutionValidation: z.object({
      pixelsPerWorldUnit: z.number().positive().max(10000),
      mode: z.enum(['warn', 'error']).default('warn'),
    }).strict().optional(),
    semanticControls: z
      .partialRecord(
        z.enum([
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
        StableIdSchema,
      )
      .optional(),
  })
  .strict()
  .superRefine((asset, context) => {
    const nodes = new Map<
      string,
      { parentId?: string; path: (string | number)[] }
    >();
    const nodeList = [
      ...asset.groups.map((node, index) => ({
        ...node,
        path: ['groups', index] as (string | number)[],
      })),
      ...asset.layers.map((node, index) => ({
        ...node,
        path: ['layers', index] as (string | number)[],
      })),
    ];
    for (const node of nodeList) {
      if (nodes.has(node.id))
        context.addIssue({
          code: 'custom',
          path: [...node.path, 'id'],
          message: `Duplicate artwork node ID "${node.id}"`,
        });
      nodes.set(node.id, {
        ...(node.parentId ? { parentId: node.parentId } : {}),
        path: node.path,
      });
    }
    for (const [componentIndex, component] of asset.components.entries()) {
      if (!nodes.has(component.nodeId)) context.addIssue({ code: 'custom', path: ['components', componentIndex, 'nodeId'], message: `Component references unknown node "${component.nodeId}"` });
      if (asset.components.slice(0, componentIndex).some((previous) => previous.id === component.id)) context.addIssue({ code: 'custom', path: ['components', componentIndex, 'id'], message: `Duplicate component ID "${component.id}"` });
    }
    for (const [control, nodeId] of Object.entries(
      asset.semanticControls ?? {},
    )) {
      if (!nodes.has(nodeId))
        context.addIssue({
          code: 'custom',
          path: ['semanticControls', control],
          message: `Semantic control "${control}" references unknown artwork node "${nodeId}"`,
        });
    }
    for (const node of nodeList) {
      if (node.parentId && !nodes.has(node.parentId))
        context.addIssue({
          code: 'custom',
          path: [...node.path, 'parentId'],
          message: `Unknown artwork parent "${node.parentId}"`,
        });
      const visited = new Set<string>([node.id]);
      let parentId = node.parentId;
      while (parentId) {
        if (visited.has(parentId)) {
          context.addIssue({
            code: 'custom',
            path: [...node.path, 'parentId'],
            message: `Artwork hierarchy contains a cycle through "${parentId}"`,
          });
          break;
        }
        visited.add(parentId);
        parentId = nodes.get(parentId)?.parentId;
      }
    }
    const slots = new Set<string>();
    for (const [slotIndex, slot] of asset.variantSlots.entries()) {
      if (slots.has(slot.id))
        context.addIssue({
          code: 'custom',
          path: ['variantSlots', slotIndex, 'id'],
          message: `Duplicate variant slot "${slot.id}"`,
        });
      slots.add(slot.id);
      const variants = new Set<string>();
      for (const [variantIndex, variant] of slot.variants.entries()) {
        if (variants.has(variant.id))
          context.addIssue({
            code: 'custom',
            path: ['variantSlots', slotIndex, 'variants', variantIndex, 'id'],
            message: `Duplicate variant "${variant.id}"`,
          });
        variants.add(variant.id);
        if (new Set(variant.layerIds).size !== variant.layerIds.length)
          context.addIssue({
            code: 'custom',
            path: [
              'variantSlots',
              slotIndex,
              'variants',
              variantIndex,
              'layerIds',
            ],
            message: 'Variant layer IDs must be unique',
          });
        for (const layerId of variant.layerIds) {
          const layer = asset.layers.find(
            (candidate) => candidate.id === layerId,
          );
          if (
            !layer ||
            layer.variantSlot !== slot.id ||
            layer.variantId !== variant.id
          )
            context.addIssue({
              code: 'custom',
              path: [
                'variantSlots',
                slotIndex,
                'variants',
                variantIndex,
                'layerIds',
              ],
              message: `Layer "${layerId}" must declare this exact variant slot and ID`,
            });
        }
      }
      if (!variants.has(slot.defaultVariant))
        context.addIssue({
          code: 'custom',
          path: ['variantSlots', slotIndex, 'defaultVariant'],
          message: 'Default variant must name a declared variant',
        });
    }
    for (const [layerIndex, layer] of asset.layers.entries()) {
      if (layer.variantSlot && !slots.has(layer.variantSlot))
        context.addIssue({
          code: 'custom',
          path: ['layers', layerIndex, 'variantSlot'],
          message: `Unknown variant slot "${layer.variantSlot}"`,
        });
      if (
        layer.variantSlot &&
        !asset.variantSlots
          .find((slot) => slot.id === layer.variantSlot)
          ?.variants.some(
            (variant) =>
              variant.id === layer.variantId &&
              variant.layerIds.includes(layer.id),
          )
      )
        context.addIssue({
          code: 'custom',
          path: ['layers', layerIndex, 'variantId'],
          message: 'Variant layer must be listed by its declared slot variant',
        });
    }
    const anchorIds = new Set<string>();
    for (const [index, anchor] of asset.anchors.entries()) {
      if (anchorIds.has(anchor.id))
        context.addIssue({
          code: 'custom',
          path: ['anchors', index, 'id'],
          message: `Duplicate anchor ID "${anchor.id}"`,
        });
      anchorIds.add(anchor.id);
      if (!nodes.has(anchor.parentId))
        context.addIssue({
          code: 'custom',
          path: ['anchors', index, 'parentId'],
          message: `Unknown anchor parent "${anchor.parentId}"`,
        });
    }
  });

export const ArtworkPreparationSpecificationSchema = z
  .object({
    schemaVersion: z.literal('1.0.0'),
    projectId: StableIdSchema,
    style: z
      .object({
        id: z.literal('charcoal_horror'),
        version: AssetVersionReferenceSchema.shape.version,
        overrides: CharcoalStyleOverridesSchema.optional(),
      })
      .strict(),
    rigs: z.array(CutoutRigDefinitionSchema).default([]),
    assets: z.array(ArtworkPackageAssetSchema).min(1),
  })
  .strict()
  .superRefine((specification, context) => {
    const ids = new Set<string>();
    const rigIds = new Set<string>();
    for (const [index, rig] of specification.rigs.entries()) {
      if (rigIds.has(rig.rigId)) context.addIssue({ code: 'custom', path: ['rigs', index, 'rigId'], message: `Duplicate rig ID "${rig.rigId}"` });
      rigIds.add(rig.rigId);
    }
    for (const [index, asset] of specification.assets.entries()) {
      const key = `${asset.assetId}@${asset.version}`;
      if (ids.has(key))
        context.addIssue({
          code: 'custom',
          path: ['assets', index],
          message: `Duplicate immutable artwork asset ${key}`,
        });
      ids.add(key);
      if (asset.rigId) {
        const rig = specification.rigs.find((candidate) => candidate.rigId === asset.rigId);
        if (!rig) context.addIssue({ code: 'custom', path: ['assets', index, 'rigId'], message: `Unknown rig definition "${asset.rigId}"` });
        else for (const control of rig.controls) if (!(control.id in (asset.semanticControls ?? {}))) context.addIssue({ code: 'custom', path: ['assets', index, 'semanticControls', control.id], message: `Rig binding is missing semantic control "${control.id}"` });
      }
    }
  });

export type ArtworkPreparationSpecification = z.infer<
  typeof ArtworkPreparationSpecificationSchema
>;
export type Rational = z.infer<typeof RationalSchema>;
export type VideoSettings = z.infer<typeof VideoSettingsSchema>;
export type RenderPolicy = z.infer<typeof RenderPolicySchema>;
export type RendererSelection = z.infer<typeof RendererSelectionSchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type ShotAudioCue = z.infer<typeof ShotAudioCueSchema>;
export type CharacterAction = z.infer<typeof CharacterActionSchema>;
export type MotionClipLibrary = z.infer<typeof MotionClipLibrarySchema>;
export type ShotScene = z.infer<typeof ShotSceneSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type VideoTrack = z.infer<typeof VideoTrackSchema>;
export type AudioTrack = z.infer<typeof AudioTrackSchema>;
export type TimelineInstructions = z.infer<typeof TimelineInstructionsSchema>;
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;
export type ProductionPackage = z.infer<typeof ProductionPackageSchema>;
export type PreparedScreenplay = z.infer<typeof PreparedScreenplaySchema>;

export interface CompiledSceneInstruction {
  version: string;
  shotId: string;
  durationFrames: number;
  frameRate: Rational;
  animationLibraryVersion: string;
  style: {
    id: 'charcoal_horror';
    version: string;
    palette: {
      shadow: readonly number[];
      graphite: readonly number[];
      paper: readonly number[];
    };
    lighting: {
      keyColor: readonly number[];
      keyEnergy: number;
      keySize: number;
      keyPosition: readonly number[];
      ambientFill: number;
    };
    grainScale: number;
    grainStrength: number;
    vignetteStrength: number;
    hazeStrength: number;
    paperFiberScale: number;
    paperOpacity: number;
    lineBoilStrength: number;
    boilFps?: number;
  };
  environment: z.infer<typeof AssetVersionReferenceSchema>;
  groups: z.infer<typeof ShotSceneSchema>['groups'];
  layers: z.infer<typeof ShotSceneSchema>['layers'];
  characters: z.infer<typeof ShotSceneSchema>['characters'];
  props: z.infer<typeof ShotSceneSchema>['props'];
  lights: z.infer<typeof ShotSceneSchema>['lights'];
  camera: z.infer<typeof ShotSceneSchema>['camera'];
  cameraKeyframes: {
    frame: number;
    distance: number;
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    focalLength: number;
  }[];
  actions: {
    characterId: string;
    action: CharacterAction;
    interval: { startFrame: number; endFrame: number };
  }[];
  motionCurves: {
    characterId: string;
    control: string;
    channel: 'location' | 'rotation' | 'scale';
    frame: number;
    value: readonly number[];
    blendMode: 'replace' | 'additive';
  }[];
  sha256: string;
}

export type RenderArtifactType =
  'video/mp4' | 'image-sequence/png' | 'image/png';

export interface RendererIdentity {
  id: string;
  version: string;
}

export interface RendererCapabilities {
  identity: RendererIdentity;
  artifactTypes: readonly RenderArtifactType[];
  videoCodecs: readonly string[];
  pixelFormats: readonly string[];
  colorProfiles: readonly string[];
}

export interface RendererAssetInput {
  assetId: string;
  version: string;
  type: string;
  sourceUri: string;
  localPath: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}

export type RenderArtifactRequest =
  | { type: 'video/mp4'; outputPath: string }
  | { type: 'image-sequence/png'; outputDirectory: string }
  | { type: 'image/png'; outputPath: string; frame: number };

export interface RenderShotRequest {
  jobId: string;
  shot: Shot;
  scene?: CompiledSceneInstruction;
  assets: readonly RendererAssetInput[];
  settings: RenderPolicy;
  artifact: RenderArtifactRequest;
  randomSeed: number;
  cacheDirectory: string;
  receiptPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RenderOutputChecksum {
  path: string;
  sha256: string;
  bytes: number;
}

export interface RenderReceiptBase {
  jobId: string;
  shotId: string;
  renderer: RendererIdentity;
  fingerprint: string;
  startedAt: string;
  completedAt: string;
  outputPaths: string[];
  outputChecksums: RenderOutputChecksum[];
  logs: string[];
  metrics: Record<string, number | string | boolean>;
  requestedRenderer?: string;
  actualRenderer?: string;
  fallbackUsed?: boolean;
  degraded?: boolean;
  warnings?: string[];
  completedWithWarning?: boolean;
}

export interface SuccessfulRenderReceipt extends RenderReceiptBase {
  status: 'success';
  artifactType: RenderArtifactType;
}

export interface FailedRenderReceipt extends RenderReceiptBase {
  status: 'failure';
  error: {
    code: RendererErrorCode;
    message: string;
    retryable: boolean;
  };
}

export type RenderShotResult =
  | { status: 'success'; receipt: SuccessfulRenderReceipt; cacheHit: boolean }
  | {
      status: 'failure';
      receipt: FailedRenderReceipt;
      error: FailedRenderReceipt['error'];
    };

export type RendererErrorCode =
  | 'INVALID_INSTRUCTIONS'
  | 'MISSING_ASSET'
  | 'UNSUPPORTED_ARTIFACT'
  | 'UNSUPPORTED_SETTINGS'
  | 'RENDER_CRASHED'
  | 'TIMEOUT'
  | 'INTERRUPTED'
  | 'INCOMPLETE_OUTPUT'
  | 'CACHE_ERROR'
  | 'IO_ERROR';

export interface ArtifactInspectionRequest {
  artifactType: RenderArtifactType;
  path: string;
  expectedFrameCount?: number;
  expectedWidth?: number;
  expectedHeight?: number;
  expectedFrameRate?: Rational;
  expectedCodec?: string;
  expectedPixelFormat?: string;
  expectedColorProfile?: string;
}

export interface ArtifactInspection {
  artifactType: RenderArtifactType;
  outputChecksums: RenderOutputChecksum[];
  frameCount?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  codec?: string;
  pixelFormat?: string;
  colorProfile?: string;
}

export type RendererOperationResult<T> =
  | { status: 'success'; value: T }
  | {
      status: 'failure';
      error: { code: RendererErrorCode; message: string; retryable: boolean };
    };

export interface RendererAdapter {
  readonly identity: RendererIdentity;
  inspectCapabilities(): Promise<RendererOperationResult<RendererCapabilities>>;
  renderShot(request: RenderShotRequest): Promise<RenderShotResult>;
  inspectArtifact(
    request: ArtifactInspectionRequest,
  ): Promise<RendererOperationResult<ArtifactInspection>>;
}

export function parseProjectManifest(input: unknown): ProjectManifest {
  return ProjectManifestSchema.parse(input);
}

function assertJsonData(
  value: unknown,
  ancestors = new WeakSet<object>(),
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON cannot contain non-finite numbers');
    }
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(
      `Canonical JSON cannot contain values of type "${typeof value}"`,
    );
  }
  if (ancestors.has(value)) {
    throw new TypeError('Canonical JSON cannot contain circular references');
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError('Canonical JSON cannot contain sparse arrays');
      }
      assertJsonData(value[index], ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON objects must be plain objects');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError('Canonical JSON cannot contain symbol keys');
    }
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError(
          'Canonical JSON objects cannot contain accessor properties',
        );
      }
      assertJsonData(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

export function canonicalJson(value: unknown): string {
  assertJsonData(value);
  return canonicalizeEx(value, { strictUndefined: true });
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
