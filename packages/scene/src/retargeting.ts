import {
  RetargetProfileSchema,
  SpatialConstraintSchema,
  type RetargetProfile,
  type PreparedCharacter,
  type SampledSkeletalMotion,
  type MotionQuaternion as Q,
  type MotionVector as V,
  type SpatialConstraint,
} from '@filmmaking/contracts';
import {
  identity,
  multiply,
  withinLimits,
  quaternion,
  sampleCurve,
  slerp,
} from './motion-math.js';
import {
  conjugate,
  rotateVector,
  angularDistance,
} from './rigid-transforms.js';
import { prepareKinematics, constrainMotion } from './spatial-constraints.js';

export interface RetargetDiagnostic {
  code: 'compatibility' | 'joint-limit' | 'constraint';
  subject: string;
  message: string;
  positionError?: number;
  angularError?: number;
}
export interface RetargetFrameResult {
  success: boolean;
  motion: SampledSkeletalMotion;
  diagnostics: RetargetDiagnostic[];
}

/** Validate ancestry between mapped joints; unmapped intermediate/twist joints are allowed. */
export function validateRetargetCompatibility(
  source: PreparedCharacter,
  target: PreparedCharacter,
  input: RetargetProfile,
): RetargetDiagnostic[] {
  const profile = RetargetProfileSchema.parse(input);
  const errors: RetargetDiagnostic[] = [];
  const fail = (subject: string, message: string) =>
    errors.push({ code: 'compatibility', subject, message });
  for (const rig of [source, target]) {
    const names = new Set(rig.bones.map((b) => b.id));
    if (names.size !== rig.bones.length) fail(rig.id, 'Duplicate bone IDs');
    for (const bone of rig.bones) {
      if (
        ![...bone.head, ...bone.tail, ...bone.min, ...bone.max].every(
          Number.isFinite,
        ) ||
        Math.hypot(...bone.tail.map((v, i) => v - bone.head[i]!)) < 1e-8 ||
        bone.min.some((v, i) => v > bone.max[i]!)
      )
        fail(bone.id, 'Invalid rest geometry or limits');
    }
    try {
      prepareKinematics(rig)(new Map());
    } catch (e) {
      fail(rig.id, String(e));
    }
    if (!Number.isFinite(rig.transform.scale) || rig.transform.scale <= 0)
      fail(rig.id, 'Invalid character scale');
    if (rig.parentId) fail(rig.id, 'Flatten world parents before retargeting');
  }
  if (errors.length) return errors;
  const nearest = (
    rig: PreparedCharacter,
    id: string,
    mapped: Map<string, string>,
  ) => {
    let parent = rig.bones.find((b) => b.id === id)?.parent;
    while (parent && !mapped.has(parent))
      parent = rig.bones.find((b) => b.id === parent)?.parent;
    return parent ? mapped.get(parent) : undefined;
  };
  const sources = new Map(profile.joints.map((j) => [j.source, j.semantic]));
  const targets = new Map(profile.joints.map((j) => [j.target, j.semantic]));
  for (const mapping of profile.joints) {
    if (
      !source.bones.some((b) => b.id === mapping.source) ||
      !target.bones.some((b) => b.id === mapping.target)
    )
      fail(mapping.semantic, 'Mapped source or target bone does not exist');
    else if (
      nearest(source, mapping.source, sources) !==
      nearest(target, mapping.target, targets)
    )
      fail(mapping.semantic, 'Mapped ancestor hierarchies are incompatible');
  }
  return errors;
}

/** Pure random-access evaluation. Constraints use TARGET names/coordinates, inclusive frame intervals.
 * Explicit authored target rotations are locked against IK. Root trajectories are never changed by IK.
 * Failed constraints return unsolved motion with diagnostics, never an ordinary success.
 */
export function retargetFrame(
  source: PreparedCharacter,
  target: PreparedCharacter,
  sourceMotion: SampledSkeletalMotion,
  frame: number,
  input: RetargetProfile,
  options: {
    authored?: ReadonlyMap<string, Q>;
    constraints?: readonly SpatialConstraint[];
  } = {},
): RetargetFrameResult {
  const profile = RetargetProfileSchema.parse(input);
  const diagnostics = validateRetargetCompatibility(source, target, profile);
  if (target.poses.root.length)
    diagnostics.push({
      code: 'compatibility',
      subject: target.id,
      message:
        'Resolve authored target root tracks before retargeting; source trajectory transfer cannot override them',
    });
  if (diagnostics.length)
    return { success: false, motion: { joints: [] }, diagnostics };
  if (!Number.isInteger(frame) || frame < 0)
    throw new TypeError('Invalid retarget frame');
  const validQ = (q: Q | undefined): q is Q =>
    !!q && q.every(Number.isFinite) && Math.abs(Math.hypot(...q) - 1) < 1e-5;
  const sourceRotations = new Map<string, Q>();
  for (const track of sourceMotion.joints) {
    if (
      sourceRotations.has(track.joint) ||
      !source.bones.some((b) => b.id === track.joint) ||
      !validQ(track.rotations[frame])
    )
      throw new TypeError(
        `Invalid source track/sample: ${track.joint} at ${frame}`,
      );
    sourceRotations.set(track.joint, track.rotations[frame]!);
  }
  const sourceFK = prepareKinematics(source),
    targetFK = prepareKinematics(target);
  const sourceRest = sourceFK(new Map()),
    targetRest = targetFK(new Map());
  const posed = sourceFK(sourceRotations),
    rotations = new Map<string, Q>();
  const c = profile.coordinateRotation;
  const ordered = [...targetRest.keys()]; // FK emits parents before children.
  for (const id of ordered) {
    const mapping = profile.joints.find((j) => j.target === id);
    const track = target.poses.joints.find((t) => t.joint === id);
    const authored =
      options.authored?.get(id) ??
      (track?.keys.length
        ? sampleCurve(
            track.keys.map((key) => ({
              time: key.frame,
              value: quaternion(key.rotationDegrees),
              interpolation: key.interpolation,
            })),
            frame,
            slerp,
          )
        : undefined);
    if (authored) {
      if (!validQ(authored))
        throw new TypeError(`Invalid authored quaternion: ${id}`);
      rotations.set(id, authored);
    } else if (mapping) {
      const deformation = multiply(
        posed.get(mapping.source)!.rotation,
        conjugate(sourceRest.get(mapping.source)!.rotation),
      );
      const desired = multiply(
        multiply(multiply(c, deformation), conjugate(c)),
        targetRest.get(id)!.rotation,
      );
      const inherited = targetFK(rotations).get(id)!.rotation;
      rotations.set(id, multiply(conjugate(inherited), desired));
    }
    const bone = target.bones.find((b) => b.id === id)!;
    if (!withinLimits(rotations.get(id) ?? identity, bone.min, bone.max))
      diagnostics.push({
        code: 'joint-limit',
        subject: id,
        message: 'Transferred or authored rotation exceeds target limits',
      });
  }
  for (const id of options.authored?.keys() ?? [])
    if (!targetRest.has(id))
      throw new TypeError(`Unknown authored joint: ${id}`);
  const xyz = (v: { x: number; y: number; z: number }): V => [v.x, v.y, v.z];
  const position = sourceMotion.rootPosition
    ? sourceMotion.rootPosition[frame]
    : xyz(source.transform.position);
  const rotation = sourceMotion.rootRotation
    ? sourceMotion.rootRotation[frame]
    : quaternion(xyz(source.transform.rotationDegrees));
  const scale = sourceMotion.rootScale
    ? sourceMotion.rootScale[frame]
    : source.transform.scale;
  if (
    !position?.every(Number.isFinite) ||
    !validQ(rotation) ||
    !scale ||
    !Number.isFinite(scale) ||
    scale < 0
  )
    throw new TypeError(`Invalid source root sample at ${frame}`);
  const offset = rotateVector(
    c,
    position.map((v, i) => v - profile.sourceOrigin[i]!) as V,
  );
  let motion: SampledSkeletalMotion = {
    rootPosition: [
      offset.map(
        (v, i) => profile.targetOrigin[i]! + v * profile.translationScale,
      ) as V,
    ],
    rootRotation: [multiply(multiply(c, rotation), conjugate(c))],
    rootScale: [(scale / source.transform.scale) * target.transform.scale],
    joints: [...rotations].map(([joint, q]) => ({ joint, rotations: [q] })),
  };
  const active = (options.constraints ?? [])
    .map((constraint) => SpatialConstraintSchema.parse(constraint))
    .filter(
      (constraint) =>
        frame >= constraint.startFrame && frame <= constraint.endFrame,
    );
  // Evaluate fades at the original frame, then solve one frame with no history dependence.
  const initialFK = targetFK(rotations);
  const constraints = active.map((constraint) => {
    if (constraint.fadeFrames)
      throw new TypeError(
        'Retarget constraints require explicit frame-sampled targets; fadeFrames must be zero',
      );
    return { ...constraint, startFrame: 0, endFrame: 0 };
  });
  if (!diagnostics.length && constraints.length) {
    const locked = structuredClone(target);
    // Existing authored pose channels and explicit overrides remain immutable.
    locked.poses.joints = [...target.poses.joints];
    for (const id of options.authored?.keys() ?? []) {
      const template = target.poses.joints.find((track) => track.joint === id);
      if (!template) locked.poses.joints.push({ joint: id, keys: [] });
    }
    try {
      motion = constrainMotion(locked, motion, constraints, 1)!;
    } catch (error) {
      diagnostics.push({
        code: 'constraint',
        subject: target.id,
        message: String(error),
      });
    }
  }
  const finalFK = targetFK(
    new Map(motion.joints.map((track) => [track.joint, track.rotations[0]!])),
  );
  for (const constraint of constraints) {
    const pose =
      finalFK.get(constraint.effector) ?? initialFK.get(constraint.effector);
    if (!pose) continue;
    const world = constraint.space === 'world';
    const p = world
      ? rotateVector(
          motion.rootRotation![0]!,
          pose.tail.map((v) => v * motion.rootScale![0]!) as V,
        ).map((v, i) => v + motion.rootPosition![0]![i]!)
      : pose.tail;
    const positionError = Math.hypot(
      ...p.map((v, i) => v - constraint.target[i]!),
    );
    const angularError = constraint.orientation
      ? angularDistance(
          world
            ? multiply(motion.rootRotation![0]!, pose.rotation)
            : pose.rotation,
          constraint.orientation,
        )
      : 0;
    if (
      positionError > constraint.tolerance ||
      angularError > (constraint.angularTolerance ?? 0.02)
    )
      diagnostics.push({
        code: 'constraint',
        subject: constraint.id,
        message: 'Unsatisfied effector target',
        positionError,
        angularError,
      });
  }
  return { success: !diagnostics.length, motion, diagnostics };
}
