import {
  findRigProfile,
  type MotionLayer,
  type PreparedCharacter,
  type Rational,
  type SampledSkeletalMotion,
  type SceneRetargetProfile,
  type SkeletalClip,
} from '@filmmaking/contracts';
import {
  quaternion,
  multiply,
  sameHemisphere,
  identity,
} from './motion-math.js';
import { rotateVector } from './rigid-transforms.js';
import { retargetFrame, validateRetargetCompatibility } from './retargeting.js';
import { sampleCharacterMotion } from './skeletal-motion.js';

export function sampleRetargetedMotion(
  target: PreparedCharacter,
  layers: readonly MotionLayer[],
  profile: SceneRetargetProfile,
  clips: ReadonlyMap<string, SkeletalClip>,
  frames: number,
  fps: Rational,
): SampledSkeletalMotion {
  const fail = (reason: string): never => {
    throw new TypeError(
      `Retarget profile "${profile.id}" on "${target.id}": ${reason}`,
    );
  };
  if (!layers.length) fail('requires at least one motion layer');
  const rig = findRigProfile(
    profile.sourceRig.profile,
    profile.sourceRig.version,
  );
  if (!rig) return fail('unsupported source rig');
  const rest = profile.sourceRest;
  if (
    Object.keys(rest).length !== rig.joints.length ||
    rig.joints.some(({ id }) => !Object.hasOwn(rest, id))
  )
    fail('source rest skeleton must define every source rig joint');
  const unparented = { ...target };
  delete unparented.parentId;
  const source: PreparedCharacter = {
    ...unparented,
    id: profile.id,
    rig: profile.sourceRig,
    bones: rig.joints.map((joint) => ({ ...joint, ...rest[joint.id]! })),
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotationDegrees: { x: 0, y: 0, z: 0 },
      scale: 1,
    },
    poses: { root: [], joints: [] },
  };
  // Transfer in actor space. Parenting and target placement are applied by the production pipeline.
  const transferTarget = { ...unparented, poses: { root: [], joints: [] } };
  const compatible = validateRetargetCompatibility(
    source,
    transferTarget,
    profile.mapping,
  );
  if (compatible.length)
    fail(
      compatible
        .map(({ subject, message }) => subject + ': ' + message)
        .join('; '),
    );
  const sampled = sampleCharacterMotion(source, layers, clips, frames, fps);
  if (!sampled) return fail('motion layers do not produce any channels');
  const mapped = new Set(profile.mapping.joints.map(({ source }) => source));
  for (const track of sampled.joints)
    if (!mapped.has(track.joint))
      fail('animated source joint has no mapping: ' + track.joint);
  const authored = sampleCharacterMotion(target, [], clips, frames, fps);
  const authoredJoints = new Set(authored?.joints.map(({ joint }) => joint));
  if (
    frames * (profile.mapping.joints.length + authoredJoints.size + 3) >
    250_000
  )
    fail('exceeds 250,000 retarget motion samples');
  const tracks = new Map(
    profile.mapping.joints
      .filter(({ target }) => !authoredJoints.has(target))
      .map(({ target }) => [
        target,
        {
          joint: target,
          rotations: [] as SampledSkeletalMotion['joints'][number]['rotations'],
        },
      ]),
  );
  const output: SampledSkeletalMotion = {
    ...authored,
    joints: [...tracks.values(), ...(authored?.joints ?? [])],
  };
  const { position, rotationDegrees, scale } = target.transform;
  const placement = quaternion([
    rotationDegrees.x,
    rotationDegrees.y,
    rotationDegrees.z,
  ]);
  // Keep absent channels absent so target locomotion can supply the root trajectory.
  if (!authored?.rootPosition && sampled.rootPosition) output.rootPosition = [];
  if (!authored?.rootRotation && sampled.rootRotation) output.rootRotation = [];
  for (let frame = 0; frame < frames; frame++) {
    const result = retargetFrame(
      source,
      transferTarget,
      sampled,
      frame,
      profile.mapping,
    );
    const errors = result.diagnostics.filter(
      ({ code, subject }) =>
        code !== 'joint-limit' || !authoredJoints.has(subject),
    );
    if (errors.length)
      fail(
        `frame ${frame}: ` +
          errors
            .map(({ subject, message }) => subject + ': ' + message)
            .join('; '),
      );
    for (const { joint, rotations } of result.motion.joints) {
      const keys = tracks.get(joint)?.rotations;
      if (keys)
        keys.push(sameHemisphere(keys.at(-1) ?? identity, rotations[0]!));
    }
    if (!authored?.rootPosition && output.rootPosition) {
      const [x, y, z] = rotateVector(
        placement,
        result.motion.rootPosition![0]!,
      );
      output.rootPosition.push([
        position.x + x * scale,
        position.y + y * scale,
        position.z + z * scale,
      ]);
    }
    if (!authored?.rootRotation && output.rootRotation)
      output.rootRotation.push(
        sameHemisphere(
          output.rootRotation.at(-1) ?? placement,
          multiply(placement, result.motion.rootRotation![0]!),
        ),
      );
  }
  return output;
}
