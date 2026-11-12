import { z } from 'zod';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';
import {
  CharcoalStyleOverridesSchema,
  STYLE_DEFINITION_REGISTRY,
  VisualSettingsSchema,
} from './style.js';
import { SceneCharacterSchema } from './character.js';
import { SkeletalClipSchema } from './skeletal-motion.js';
import { SceneTransformSchema, UnitColorSchema } from './shared-internal.js';
import { WorldSchema } from './world.js';
import { ObjectInteractionSchema } from './interactions.js';
import { ContactGraphSchema } from './contact-graph.js';
import { SceneContactResponseSchema } from './contact-response.js';
import { CinematographySchema } from './cinematography.js';

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
  shadows: z.boolean().optional(),
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
    blend: z.number().min(0).max(1).optional(),
  }).strict(),
  SceneLightBaseSchema.extend({
    type: z.literal('sun'),
    angularDiameterRadians: z.number().min(0).max(Math.PI),
  }).strict(),
]);

export const ShotSceneSchema = z
  .object({
    stylePreset: z.string().min(1).max(64),
    styleVersion: AssetVersionReferenceSchema.shape.version.default('1.2.0'),
    animationLibraryVersion:
      AssetVersionReferenceSchema.shape.version.default('1.0.0'),
    styleOverrides: CharcoalStyleOverridesSchema.optional(),
    visualSettings: VisualSettingsSchema.optional(),
    motionLibraries: z.array(AssetVersionReferenceSchema).default([]),
    motionClips: z.array(SkeletalClipSchema).max(128).default([]),
    environment: AssetVersionReferenceSchema.optional(),
    world: WorldSchema.optional(),
    characters: z.array(SceneCharacterSchema).default([]),
    interactions: z.array(ObjectInteractionSchema).max(32).default([]),
    contactGraph: ContactGraphSchema.optional(),
    contactResponse: SceneContactResponseSchema.optional(),
    props: z
      .array(
        z
          .object({
            id: StableIdSchema,
            asset: AssetVersionReferenceSchema,
            transform: SceneTransformSchema,
          })
          .strict(),
      )
      .default([]),
    lights: z.array(SceneLightSchema).default([]),
    camera: z.union([SceneCameraSchema, CinematographySchema]),
  })
  .strict()
  .superRefine((scene, context) => {
    if (Boolean(scene.world) === Boolean(scene.environment))
      context.addIssue({
        code: 'custom',
        path: ['world'],
        message: 'Specify exactly one of world or a prepared environment asset',
      });
    const registered = STYLE_DEFINITION_REGISTRY.find(
      (definition) =>
        definition.id === scene.stylePreset &&
        definition.version === scene.styleVersion,
    );
    if (!registered)
      context.addIssue({
        code: 'custom',
        path: ['stylePreset'],
        message: `Unknown style/version "${scene.stylePreset}@${scene.styleVersion}"`,
      });
    if (registered?.shading !== 'charcoal' && scene.styleOverrides)
      context.addIssue({
        code: 'custom',
        path: ['styleOverrides'],
        message: 'Legacy style overrides require a charcoal profile',
      });
    if (
      scene.visualSettings?.celBands !== undefined &&
      registered?.shading !== 'cel'
    )
      context.addIssue({
        code: 'custom',
        path: ['visualSettings', 'celBands'],
        message: 'Cel bands require the cel shading profile',
      });
    if (
      (scene.visualSettings?.saturation !== undefined ||
        scene.visualSettings?.roughnessScale !== undefined) &&
      registered?.shading !== 'stylized'
    )
      context.addIssue({
        code: 'custom',
        path: ['visualSettings'],
        message:
          'Saturation and roughness scaling require the stylized 3D profile',
      });
    if (scene.styleVersion !== '2.0.0' && scene.styleOverrides) {
      const versionTwoOnly = [
        'edgeBreakup',
        'edgeSoftness',
        'shadowSmudge',
        'graphiteSheen',
        'contrastCurve',
        'paperWhitePoint',
        'hazeDrift',
        'dustDensity',
        'glow',
        'finalGrade',
        'shadows',
      ];
      for (const field of versionTwoOnly) {
        if (Object.hasOwn(scene.styleOverrides, field))
          context.addIssue({
            code: 'custom',
            path: ['styleOverrides', field],
            message: `${field} is only supported by charcoal_horror 2.0.0`,
          });
      }
    }
  })
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
    const entityIds = new Set<string>();
    scene.world?.entities.forEach((entity) => entityIds.add(entity.id));
    const worldIds = new Set(entityIds);
    scene.characters.forEach((character, index) => {
      if (
        'parentId' in character &&
        character.parentId &&
        !worldIds.has(character.parentId)
      )
        context.addIssue({
          code: 'custom',
          path: ['characters', index, 'parentId'],
          message: 'Character parent must be a world entity',
        });
    });
    for (const [index, entity] of [
      ...scene.characters.map((item) => ({
        ...item,
        kind: 'characters' as const,
      })),
      ...scene.props.map((item) => ({ ...item, kind: 'props' as const })),
    ].entries()) {
      if (entityIds.has(entity.id))
        context.addIssue({
          code: 'custom',
          path: [entity.kind, index, 'id'],
          message: `Duplicate scene entity ID "${entity.id}"`,
        });
      entityIds.add(entity.id);
    }
  });

export type ShotScene = z.infer<typeof ShotSceneSchema>;

/** Visual dependencies are pinned in the same registry as other shot assets. */
export function visualAssetReferences(scene?: ShotScene) {
  if (!scene) return [];
  const materials = [
    ...(scene.world?.materials ?? []),
    ...scene.characters.flatMap((character) => {
      if (!('source' in character)) return [];
      return character.source.kind === 'procedural'
        ? Object.values(character.source.appearance)
        : (character.source.materials ?? []);
    }),
  ];
  const references = materials.flatMap((material) =>
    Object.values(material?.textures ?? {}).flatMap((texture) =>
      texture ? [texture.asset] : [],
    ),
  );
  if (scene.visualSettings?.environment?.kind === 'image')
    references.push(scene.visualSettings.environment.asset);
  return references;
}
