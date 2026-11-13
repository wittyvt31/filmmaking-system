import { z } from 'zod';
import { AssetTransformSpaceSchema } from './asset-descriptor.js';
import { AssetDescriptorSchema } from './asset-descriptor.js';
import { MeshDefinitionSchema } from './geometry.js';
import { MaterialSchema } from './material.js';
import { StableIdSchema } from './identifiers.js';
import { SceneTransformSchema } from './shared-internal.js';

const builderPart = z
  .object({
    id: StableIdSchema,
    meshId: StableIdSchema,
    parentId: StableIdSchema.optional(),
    transform: SceneTransformSchema,
  })
  .strict();

const builderHandle = z
  .object({
    id: z.string().min(1),
    kind: z.enum([
      'node',
      'pivot',
      'attachment-socket',
      'control-target',
      'rig-reference',
      'collider',
      'joint',
      'custom',
    ]),
    partId: StableIdSchema,
    space: AssetTransformSpaceSchema.default('local'),
    role: z.string().min(1).optional(),
  })
  .strict();

const builderJoint = z
  .object({
    id: StableIdSchema,
    type: z.enum(['revolute', 'prismatic', 'fixed', 'continuous']),
    parentPartId: StableIdSchema,
    childPartId: StableIdSchema,
    pivotPartId: StableIdSchema.optional(),
    axis: z.tuple([z.number(), z.number(), z.number()]).optional(),
    limits: z
      .object({
        lower: z.number().finite().optional(),
        upper: z.number().finite().optional(),
      })
      .strict()
      .optional(),
    defaultValue: z.number().finite().default(0),
    controlId: StableIdSchema.optional(),
  })
  .strict();

export const ProceduralAssetDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    assetId: StableIdSchema,
    assetVersion: z.string().min(1),
    kind: z.enum([
      'mechanical-prop',
      'architectural-structure',
      'modular-environment',
      'furniture',
      'articulated-assembly',
    ]),
    materials: z.array(MaterialSchema).min(1).max(128),
    meshes: z.array(MeshDefinitionSchema).min(1).max(256),
    parts: z.array(builderPart).min(1).max(256),
    handles: z.array(builderHandle).default([]),
    joints: z.array(builderJoint).default([]),
    capabilities: z
      .object({
        assetClass: z
          .enum(['character', 'vehicle', 'prop', 'environment'])
          .optional(),
        verified: z.array(z.string().min(1)).default([]),
        unsupported: z.array(z.string().min(1)).default([]),
        unknown: z.array(z.string().min(1)).default([]),
        requirements: z.array(z.string().min(1)).default([]),
        mappings: z
          .array(
            z
              .object({
                capability: z.string().min(1),
                handle: z.string().min(1),
                required: z.boolean().default(true),
                space: AssetTransformSpaceSchema.optional(),
              })
              .strict(),
          )
          .default([]),
      })
      .strict()
      .default({
        verified: [],
        unsupported: [],
        unknown: [],
        requirements: [],
        mappings: [],
      }),
    colliders: AssetDescriptorSchema.shape.colliders.default([]),
    sockets: AssetDescriptorSchema.shape.sockets.default([]),
    provenance: z
      .object({
        source: z.string().min(1),
        importer: z.string().optional(),
        notes: z.array(z.string().min(1)).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const materialIds = new Set(
      definition.materials.map((material) => material.id),
    );
    const meshIds = new Set(definition.meshes.map((mesh) => mesh.id));
    const partIds = new Set<string>();
    for (const [index, material] of definition.materials.entries())
      if (
        definition.materials.some(
          (other, otherIndex) => otherIndex < index && other.id === material.id,
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: ['materials', index, 'id'],
          message: 'Duplicate material ID',
        });
    for (const [index, mesh] of definition.meshes.entries()) {
      if (!materialIds.has(mesh.materialId))
        ctx.addIssue({
          code: 'custom',
          path: ['meshes', index, 'materialId'],
          message: `Unknown material "${mesh.materialId}"`,
        });
      if (
        definition.meshes.some(
          (other, otherIndex) => otherIndex < index && other.id === mesh.id,
        )
      )
        ctx.addIssue({
          code: 'custom',
          path: ['meshes', index, 'id'],
          message: 'Duplicate mesh ID',
        });
    }
    for (const [index, part] of definition.parts.entries()) {
      if (partIds.has(part.id))
        ctx.addIssue({
          code: 'custom',
          path: ['parts', index, 'id'],
          message: 'Duplicate part ID',
        });
      partIds.add(part.id);
      if (!meshIds.has(part.meshId))
        ctx.addIssue({
          code: 'custom',
          path: ['parts', index, 'meshId'],
          message: `Unknown mesh "${part.meshId}"`,
        });
      if (part.parentId === part.id)
        ctx.addIssue({
          code: 'custom',
          path: ['parts', index, 'parentId'],
          message: 'Part cannot parent itself',
        });
    }
    for (const part of definition.parts)
      if (part.parentId && !partIds.has(part.parentId))
        ctx.addIssue({
          code: 'custom',
          path: ['parts'],
          message: `Unknown parent part "${part.parentId}"`,
        });
    for (const handle of definition.handles)
      if (!partIds.has(handle.partId))
        ctx.addIssue({
          code: 'custom',
          path: ['handles'],
          message: `Unknown handle part "${handle.partId}"`,
        });
    const handleIds = new Set<string>();
    for (const [index, handle] of definition.handles.entries()) {
      if (handleIds.has(handle.id))
        ctx.addIssue({
          code: 'custom',
          path: ['handles', index, 'id'],
          message: 'Duplicate handle ID',
        });
      handleIds.add(handle.id);
    }
    const jointIds = new Set<string>();
    for (const joint of definition.joints) {
      if (jointIds.has(joint.id))
        ctx.addIssue({
          code: 'custom',
          path: ['joints'],
          message: `Duplicate joint ID "${joint.id}"`,
        });
      jointIds.add(joint.id);
      if (!partIds.has(joint.parentPartId) || !partIds.has(joint.childPartId))
        ctx.addIssue({
          code: 'custom',
          path: ['joints'],
          message: `Joint "${joint.id}" references an unknown part`,
        });
      if (joint.parentPartId === joint.childPartId)
        ctx.addIssue({
          code: 'custom',
          path: ['joints'],
          message: `Joint "${joint.id}" cannot connect a part to itself`,
        });
      if (
        joint.limits?.lower !== undefined &&
        joint.limits.upper !== undefined &&
        joint.limits.lower > joint.limits.upper
      )
        ctx.addIssue({
          code: 'custom',
          path: ['joints'],
          message: `Joint "${joint.id}" has inverted limits`,
        });
      if (
        joint.axis &&
        Math.hypot(...joint.axis) < 1e-8 &&
        joint.type !== 'fixed'
      )
        ctx.addIssue({
          code: 'custom',
          path: ['joints'],
          message: `Joint "${joint.id}" requires a nonzero axis`,
        });
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (partId: string) => {
      if (visiting.has(partId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['parts'],
          message: 'Part hierarchy contains a cycle',
        });
        return;
      }
      if (visited.has(partId)) return;
      visiting.add(partId);
      const parent = definition.parts.find(
        (part) => part.id === partId,
      )?.parentId;
      if (parent) visit(parent);
      visiting.delete(partId);
      visited.add(partId);
    };
    for (const part of definition.parts) visit(part.id);
    if (
      definition.joints.length &&
      definition.parts.some((part) => part.transform.scale !== 1)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['parts'],
        message:
          'Articulated procedural parts must use unit scale so rest transforms remain physical',
      });
  });

export type ProceduralAssetDefinition = z.infer<
  typeof ProceduralAssetDefinitionSchema
>;
