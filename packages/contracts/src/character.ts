import { z } from 'zod';
import { SpatialConstraintSchema } from './spatial-constraints.js';
import { LocomotionSchema } from './locomotion.js';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';
import { CharacterActionSchema } from './motion.js';
import {
  MotionInterpolationSchema,
  MotionLayerSchema,
  type SampledSkeletalMotion,
} from './skeletal-motion.js';
import { SceneTransformSchema } from './shared-internal.js';
import { CharacterMaterialSchema, MaterialSchema } from './material.js';
import { ImportedMaterialsSchema } from './geometry.js';
import { FacialPerformanceSchema } from './facial.js';

type Vector = readonly [number, number, number];
type Joint = { id: string; parent?: string; min: Vector; max: Vector };
function joint(
  id: string,
  parent: string | undefined,
  min: Vector,
  max: Vector,
): Joint {
  return { id, ...(parent ? { parent } : {}), min, max };
}

export const FilmieHumanoid = {
  id: 'FilmieHumanoid',
  version: 1,
  joints: [
    joint('pelvis', undefined, [-35, -35, -50], [35, 35, 50]),
    joint('spine', 'pelvis', [-45, -35, -40], [45, 35, 40]),
    joint('chest', 'spine', [-45, -35, -45], [45, 35, 45]),
    joint('neck', 'chest', [-40, -55, -35], [40, 55, 35]),
    joint('head', 'neck', [-50, -75, -45], [50, 75, 45]),
    ...(['L', 'R'] as const).flatMap((side) => [
      joint('upper_arm.' + side, 'chest', [-125, -100, -120], [125, 100, 120]),
      joint(
        'forearm.' + side,
        'upper_arm.' + side,
        [-150, -75, -30],
        [150, 75, 30],
      ),
      joint('hand.' + side, 'forearm.' + side, [-75, -35, -40], [75, 35, 40]),
      joint('thigh.' + side, 'pelvis', [-130, -55, -50], [80, 55, 50]),
      joint('shin.' + side, 'thigh.' + side, [-150, -15, -15], [145, 15, 15]),
      joint('foot.' + side, 'shin.' + side, [-60, -30, -30], [60, 30, 30]),
    ]),
  ] as readonly Joint[],
} as const;

const profiles = [FilmieHumanoid] as const;
export function findRigProfile(id: string, version: number) {
  return profiles.find(
    (profile) => profile.id === id && profile.version === version,
  );
}

const RigSchema = z
  .object({ profile: StableIdSchema, version: z.number().int().positive() })
  .strict();
const sourceName = z.string().trim().min(1).max(256);
export const RigJointMapSchema = z.record(StableIdSchema, sourceName);
const RestPoint = z.tuple([
  z.number().min(-10).max(10),
  z.number().min(-10).max(10),
  z.number().min(-10).max(10),
]);
const RestSkeletonSchema = z.record(
  StableIdSchema,
  z
    .object({ head: RestPoint, tail: RestPoint })
    .strict()
    .refine(
      ({ head, tail }) =>
        Math.hypot(...head.map((v, i) => v - tail[i]!)) > 1e-5,
      'Rest joint must have nonzero length',
    ),
);
export function validateRigJointMap(
  rig: z.infer<typeof RigSchema>,
  mapping: z.infer<typeof RigJointMapSchema>,
) {
  const profile = findRigProfile(rig.profile, rig.version);
  return (
    !!profile &&
    Object.keys(mapping).length === profile.joints.length &&
    profile.joints.every(({ id }) => Object.hasOwn(mapping, id)) &&
    new Set(Object.values(mapping)).size === profile.joints.length
  );
}
const BodySchema = z
  .object({
    height: z.number().min(0.5).max(3),
    shoulderWidth: z.number().min(0.17).max(0.36).default(0.24),
    hipWidth: z.number().min(0.12).max(0.28).default(0.18),
    legLength: z.number().min(0.4).max(0.58).default(0.49),
    armLength: z.number().min(0.28).max(0.43).default(0.36),
    build: z.number().min(0.65).max(1.35).default(1),
  })
  .strict()
  .refine((body) => body.hipWidth <= body.shoulderWidth * 1.25, {
    path: ['hipWidth'],
    message: 'Hip width must be at most 1.25 times shoulder width',
  });

const SourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('procedural'),
      body: BodySchema,
      radialSegments: z.number().int().min(12).max(48).optional(),
      appearance: z
        .object({
          skin: CharacterMaterialSchema,
          top: CharacterMaterialSchema,
          trousers: CharacterMaterialSchema,
          shoes: CharacterMaterialSchema,
          hair: CharacterMaterialSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('imported'),
      asset: AssetVersionReferenceSchema,
      body: BodySchema,
      jointMap: RigJointMapSchema.optional(),
      restSkeleton: RestSkeletonSchema.optional(),
      materials: z.array(MaterialSchema).max(64).optional(),
      materialOverrides: ImportedMaterialsSchema.optional(),
    })
    .strict(),
]);

const RotationSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-180).max(180),
  z.number().min(-180).max(180),
]);
const FrameSchema = z.object({
  frame: z.number().int().nonnegative().safe(),
  interpolation: MotionInterpolationSchema.default('linear'),
});
const PosesSchema = z
  .object({
    root: z
      .array(FrameSchema.extend({ transform: SceneTransformSchema }).strict())
      .max(1024)
      .default([]),
    joints: z
      .array(
        z
          .object({
            joint: StableIdSchema,
            keys: z
              .array(
                FrameSchema.extend({
                  rotationDegrees: RotationSchema,
                }).strict(),
              )
              .min(1)
              .max(1024),
          })
          .strict(),
      )
      .max(128)
      .default([]),
  })
  .strict();

export const RiggedCharacterSchema = z
  .object({
    id: StableIdSchema,
    parentId: StableIdSchema.optional(),
    transform: SceneTransformSchema,
    rig: RigSchema,
    source: SourceSchema,
    poses: PosesSchema.default({ root: [], joints: [] }),
    motion: z.array(MotionLayerSchema).max(64).default([]),
    constraints: z.array(SpatialConstraintSchema).max(32).default([]),
    locomotion: LocomotionSchema.optional(),
    facial: FacialPerformanceSchema.optional(),
    deformation: z
      .object({
        skinning: z.enum(['linear', 'preserve-volume']).optional(),
        subdivision: z.number().int().min(0).max(2).optional(),
      })
      .strict()
      .optional(),
    morphs: z
      .array(
        z
          .object({
            mesh: sourceName,
            target: sourceName,
            keys: z
              .array(
                FrameSchema.extend({
                  value: z.number().min(0).max(1),
                }).strict(),
              )
              .min(1)
              .max(1024),
          })
          .strict(),
      )
      .max(128)
      .optional(),
    actions: z.tuple([]).default([]),
  })
  .strict()
  .superRefine((character, context) => {
    const issue = (path: (string | number)[], message: string) =>
      context.addIssue({ code: 'custom', path, message });
    const profile = findRigProfile(
      character.rig.profile,
      character.rig.version,
    );
    if (!profile) issue(['rig'], 'Unknown rig profile or version');
    if (character.source.kind === 'imported') {
      const { jointMap, restSkeleton, materials, materialOverrides } =
        character.source;
      if (jointMap && !validateRigJointMap(character.rig, jointMap))
        issue(
          ['source', 'jointMap'],
          'Rig mapping must bind each profile joint to a distinct source bone',
        );
      if (
        restSkeleton &&
        (!profile ||
          Object.keys(restSkeleton).length !== profile.joints.length ||
          profile.joints.some(({ id }) => !Object.hasOwn(restSkeleton, id)))
      )
        issue(
          ['source', 'restSkeleton'],
          'Rest skeleton must describe exactly the profile joints',
        );
      const ids = new Set(materials?.map((m) => m.id));
      if (ids.size !== (materials?.length ?? 0))
        issue(['source', 'materials'], 'Duplicate character material ID');
      const slots =
        materialOverrides?.mode === 'slots' ? materialOverrides.slots : [];
      if (new Set(slots.map((s) => s.source)).size !== slots.length)
        issue(
          ['source', 'materialOverrides'],
          'Duplicate source material slot',
        );
      for (const id of materialOverrides?.mode === 'all'
        ? [materialOverrides.materialId]
        : slots.map((s) => s.materialId))
        if (!ids.has(id))
          issue(
            ['source', 'materialOverrides'],
            'Unknown character material ' + id,
          );
    } else if (character.morphs?.length)
      issue(['morphs'], 'Morph targets require an imported character asset');
    const validateOrder = (
      keys: readonly { frame: number }[],
      path: (string | number)[],
    ) => {
      keys.forEach((key, index) => {
        if (index > 0 && keys[index - 1]!.frame >= key.frame)
          issue(
            [...path, index, 'frame'],
            'Pose keyframes must be in strictly increasing frame order',
          );
      });
    };
    validateOrder(character.poses.root, ['poses', 'root']);
    const morphTargets = new Set<string>();
    character.morphs?.forEach((track, index) => {
      const key = JSON.stringify([track.mesh, track.target]);
      if (morphTargets.has(key))
        issue(['morphs', index], 'Duplicate morph track');
      morphTargets.add(key);
      validateOrder(track.keys, ['morphs', index, 'keys']);
    });
    const seen = new Set<string>();
    character.poses.joints.forEach((track, index) => {
      const path = ['poses', 'joints', index];
      if (seen.has(track.joint))
        issue([...path, 'joint'], 'Duplicate joint track');
      seen.add(track.joint);
      const bone = profile?.joints.find(
        (candidate) => candidate.id === track.joint,
      );
      if (!bone && profile)
        issue(
          [...path, 'joint'],
          'Unknown joint "' + track.joint + '" for ' + profile.id,
        );
      validateOrder(track.keys, [...path, 'keys']);
      if (bone)
        track.keys.forEach((key, keyIndex) => {
          if (
            key.rotationDegrees.some(
              (value, axis) =>
                value < bone.min[axis]! || value > bone.max[axis]!,
            )
          )
            issue(
              [...path, 'keys', keyIndex, 'rotationDegrees'],
              'Joint rotation exceeds ' + bone.id + ' limits',
            );
        });
    });
  });

const LegacyCharacterSchema = z
  .object({
    id: StableIdSchema,
    asset: AssetVersionReferenceSchema,
    transform: SceneTransformSchema,
    actions: z.array(CharacterActionSchema).default([]),
  })
  .strict();

export const SceneCharacterSchema = z.union([
  LegacyCharacterSchema,
  RiggedCharacterSchema,
]);
export type RiggedCharacter = z.infer<typeof RiggedCharacterSchema>;
export type SceneCharacter = z.infer<typeof SceneCharacterSchema>;

export function resolveRigJointMap(
  character: Pick<RiggedCharacter, 'rig' | 'source'>,
  metadata: Readonly<Record<string, unknown>>,
) {
  if (character.source.kind !== 'imported') return undefined;
  const candidate = character.source.jointMap ?? metadata['rigJointMap'];
  if (candidate === undefined) return undefined;
  const mapping = RigJointMapSchema.parse(candidate);
  if (!validateRigJointMap(character.rig, mapping))
    throw new TypeError(
      'Rig mapping must bind each profile joint to a distinct source bone',
    );
  return mapping;
}

export function characterAsset(character: SceneCharacter) {
  if ('asset' in character) return character.asset;
  return character.source.kind === 'imported'
    ? character.source.asset
    : undefined;
}

export interface PreparedCharacter {
  id: string;
  parentId?: string;
  transform: RiggedCharacter['transform'];
  rig: RiggedCharacter['rig'];
  source: RiggedCharacter['source'];
  bones: {
    id: string;
    parent?: string;
    head: Vector;
    tail: Vector;
    min: Vector;
    max: Vector;
  }[];
  poses: RiggedCharacter['poses'];
  deformation?: NonNullable<RiggedCharacter['deformation']>;
  morphs?: NonNullable<RiggedCharacter['morphs']>;
  facialBoneMap?: Record<string, string>;
  sampledMotion?: SampledSkeletalMotion;
}
