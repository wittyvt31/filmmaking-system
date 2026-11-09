import { z } from 'zod';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';
import { CharcoalStyleOverridesSchema } from './style.js';
import { CutoutRigDefinitionSchema } from './rigs.js';
import { nonEmptyText } from './shared-internal.js';

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

const ArtworkLayerProcessingSchema = z
  .object({
    featherPixels: z.number().int().nonnegative().max(32).default(0),
    smoothingPasses: z.number().int().nonnegative().max(8).default(0),
    fillHolesBelowPixels: z.number().int().nonnegative().max(100000).default(0),
    removeIslandsBelowPixels: z
      .number()
      .int()
      .nonnegative()
      .max(100000)
      .default(0),
    decontaminateEdges: z.boolean().default(false),
    alphaThreshold: z.number().min(0).max(1).default(0.01),
  })
  .strict();

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

const ArtworkComponentSchema = z
  .object({
    id: StableIdSchema,
    nodeId: StableIdSchema,
    displayName: nonEmptyText,
  })
  .strict();

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
    resolutionValidation: z
      .object({
        pixelsPerWorldUnit: z.number().positive().max(10000),
        mode: z.enum(['warn', 'error']).default('warn'),
      })
      .strict()
      .optional(),
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
      if (!nodes.has(component.nodeId))
        context.addIssue({
          code: 'custom',
          path: ['components', componentIndex, 'nodeId'],
          message: `Component references unknown node "${component.nodeId}"`,
        });
      if (
        asset.components
          .slice(0, componentIndex)
          .some((previous) => previous.id === component.id)
      )
        context.addIssue({
          code: 'custom',
          path: ['components', componentIndex, 'id'],
          message: `Duplicate component ID "${component.id}"`,
        });
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
      if (rigIds.has(rig.rigId))
        context.addIssue({
          code: 'custom',
          path: ['rigs', index, 'rigId'],
          message: `Duplicate rig ID "${rig.rigId}"`,
        });
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
        const rig = specification.rigs.find(
          (candidate) => candidate.rigId === asset.rigId,
        );
        if (!rig)
          context.addIssue({
            code: 'custom',
            path: ['assets', index, 'rigId'],
            message: `Unknown rig definition "${asset.rigId}"`,
          });
        else
          for (const control of rig.controls)
            if (!(control.id in (asset.semanticControls ?? {})))
              context.addIssue({
                code: 'custom',
                path: ['assets', index, 'semanticControls', control.id],
                message: `Rig binding is missing semantic control "${control.id}"`,
              });
      }
    }
  });

export type ArtworkPreparationSpecification = z.infer<
  typeof ArtworkPreparationSpecificationSchema
>;
