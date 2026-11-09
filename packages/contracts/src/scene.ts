import { z } from 'zod';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';
import {
  CharcoalStyleOverridesSchema,
  STYLE_DEFINITION_REGISTRY,
} from './style.js';
import { CharacterActionSchema } from './motion.js';
import { SceneTransformSchema, UnitColorSchema } from './shared-internal.js';

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
    stylePreset: z.string().min(1).max(64),
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
    const legacy = scene.stylePreset === 'charcoal_horror' && scene.styleVersion === '1.1.0';
    const registered = STYLE_DEFINITION_REGISTRY.some(
      (definition) => definition.id === scene.stylePreset && definition.version === scene.styleVersion,
    );
    if (!legacy && !registered)
      context.addIssue({ code: 'custom', path: ['stylePreset'], message: `Unknown style/version "${scene.stylePreset}@${scene.styleVersion}"` });
    if (scene.styleVersion !== '2.0.0' && scene.styleOverrides) {
      const versionTwoOnly = ['edgeBreakup', 'edgeSoftness', 'shadowSmudge', 'graphiteSheen', 'contrastCurve', 'paperWhitePoint', 'hazeDrift', 'dustDensity', 'glow', 'finalGrade', 'shadows'];
      for (const field of versionTwoOnly) {
        if (Object.hasOwn(scene.styleOverrides, field))
          context.addIssue({ code: 'custom', path: ['styleOverrides', field], message: `${field} is only supported by charcoal_horror 2.0.0` });
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

export type ShotScene = z.infer<typeof ShotSceneSchema>;
