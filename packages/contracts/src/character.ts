import { z } from 'zod';
import { AssetVersionReferenceSchema, StableIdSchema } from './identifiers.js';
import { CharacterActionSchema } from './motion.js';
import {
  MotionInterpolationSchema,
  MotionLayerSchema,
  type SampledSkeletalMotion,
} from './skeletal-motion.js';
import { SceneTransformSchema, UnitColorSchema } from './shared-internal.js';

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
      joint('shin.' + side, 'thigh.' + side, [-150, -15, -15], [30, 15, 15]),
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

const CharacterMaterialSchema = z
  .object({
    color: UnitColorSchema,
    roughness: z.number().min(0).max(1).default(0.72),
    metallic: z.number().min(0).max(1).default(0),
  })
  .strict();

const SourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('procedural'),
      body: BodySchema,
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
  sampledMotion?: SampledSkeletalMotion;
}
