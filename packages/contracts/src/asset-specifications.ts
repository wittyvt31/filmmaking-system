import { z } from 'zod';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';
import { CharcoalStyleOverridesSchema } from './style.js';
import { nonEmptyText } from './shared-internal.js';

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

export type ProceduralAssetSpecification = z.infer<
  typeof ProceduralAssetSpecificationSchema
>;
export type AssetBuildSpecification = z.infer<
  typeof AssetBuildSpecificationSchema
>;
