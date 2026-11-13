import {
  AssetDescriptorSchema,
  type AssetDescriptor,
  type RigidTransform,
  type MotionQuaternion,
  type MotionVector,
} from '@filmmaking/contracts';
import { composeTransform, inverseTransform } from './rigid-transforms.js';

export interface ArticulatedKinematicResult {
  jointStates: Record<string, number>;
  transforms: Record<string, RigidTransform>;
  nodeTransforms: Record<number, RigidTransform>;
}

const identity = (): RigidTransform => ({
  position: [0, 0, 0],
  rotation: [1, 0, 0, 0],
});

const axisAngle = (axis: MotionVector, value: number): MotionQuaternion => {
  const length = Math.hypot(...axis);
  if (length < 1e-12 || Math.abs(value) < 1e-12) return [1, 0, 0, 0];
  const half = value / 2;
  const scale = Math.sin(half) / length;
  return [Math.cos(half), axis[0]! * scale, axis[1]! * scale, axis[2]! * scale];
};

function clamp(value: number, lower?: number, upper?: number): number {
  return Math.max(lower ?? -Infinity, Math.min(upper ?? Infinity, value));
}

function targetNode(descriptor: AssetDescriptor, handleId: string): number {
  const handle = descriptor.resolvedHandles?.find(
    (candidate) => candidate.id === handleId,
  );
  if (handle?.nodeIndex !== undefined) return handle.nodeIndex;
  const authored = descriptor.handles.find(
    (candidate) => candidate.id === handleId,
  );
  if (authored?.target && typeof authored.target !== 'string')
    return authored.target.nodeIndex;
  throw new TypeError(
    `Articulation handle "${handleId}" has no deterministic node target`,
  );
}

function motionTransform(
  joint: AssetDescriptor['articulation']['joints'][number],
  value: number,
): RigidTransform {
  const type = joint.type;
  if (type === 'fixed') return identity();
  const axis = joint.axis ?? [1, 0, 0];
  if (type === 'prismatic' || type === 'slider')
    return {
      position: axis.map((component) => component * value) as MotionVector,
      rotation: [1, 0, 0, 0],
    };
  return {
    position: [0, 0, 0],
    rotation: axisAngle(axis, value),
  };
}

/**
 * Precompile the immutable articulation graph and rest transforms once.
 * The returned evaluator performs only joint-state and pose work per frame.
 */
export function createArticulatedKinematicsEvaluator(
  input: unknown,
  baseTransforms: Readonly<Record<number, RigidTransform>> = {},
): (controls?: Readonly<Record<string, number>>) => ArticulatedKinematicResult {
  const descriptor = AssetDescriptorSchema.parse(input);
  type Joint = AssetDescriptor['articulation']['joints'][number];
  interface PreparedJoint {
    joint: Joint;
    parentNode: number;
    childNode: number;
    restParent: RigidTransform;
    inverseChild: RigidTransform;
    controlId: string | undefined;
    controlDefault: number | undefined;
  }

  const joints = [...descriptor.articulation.joints].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const knownControls = new Set([
    ...joints.map((joint) => joint.id),
    ...descriptor.articulation.controls.map((control) => control.id),
  ]);
  const controlsById = new Map(
    descriptor.articulation.controls.map((control) => [control.id, control]),
  );
  const authoredTransforms: Record<string, RigidTransform> = {
    ...(descriptor.restTransforms ?? {}),
    ...baseTransforms,
  };
  const initialTransforms = Object.entries(authoredTransforms).map(
    ([index, transform]) => [Number(index), transform] as const,
  );
  const prepared = joints.map((joint): PreparedJoint => {
    const parentNode = targetNode(descriptor, joint.parent);
    const childNode = targetNode(descriptor, joint.child);
    if (parentNode === childNode)
      throw new TypeError(`Articulation joint "${joint.id}" references itself`);
    const authoredParent = authoredTransforms[parentNode] ?? identity();
    const authoredChild = authoredTransforms[childNode] ?? identity();
    const control = joint.control
      ? controlsById.get(joint.control)
      : undefined;
    return {
      joint,
      parentNode,
      childNode,
      restParent: composeTransform(
        composeTransform(inverseTransform(authoredParent), authoredChild),
        joint.parentTransform,
      ),
      inverseChild: inverseTransform(joint.childTransform),
      controlId: control?.id,
      controlDefault: control?.defaultValue,
    };
  });

  const firstJointByChild = new Map<number, PreparedJoint>();
  for (const joint of prepared)
    if (!firstJointByChild.has(joint.childNode))
      firstJointByChild.set(joint.childNode, joint);

  const ordered: PreparedJoint[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (joint: PreparedJoint): void => {
    if (visited.has(joint.joint.id)) return;
    if (visiting.has(joint.joint.id))
      throw new TypeError(`Articulation cycle at joint "${joint.joint.id}"`);
    visiting.add(joint.joint.id);
    const parent = firstJointByChild.get(joint.parentNode);
    if (parent && parent !== joint) visit(parent);
    visiting.delete(joint.joint.id);
    visited.add(joint.joint.id);
    ordered.push(joint);
  };
  for (const joint of prepared) visit(joint);

  const resolvedHandles = [...(descriptor.resolvedHandles ?? [])]
    .filter((handle) => handle.nodeIndex !== undefined)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  return (controls: Readonly<Record<string, number>> = {}) => {
    for (const [id, value] of Object.entries(controls)) {
      if (!knownControls.has(id))
        throw new TypeError(`Unknown articulated runtime control "${id}"`);
      if (!Number.isFinite(value))
        throw new TypeError(`Invalid articulated runtime control "${id}"`);
    }

    const jointStates: Record<string, number> = {};
    for (const { joint, controlId, controlDefault } of prepared) {
      const requested =
        controls[joint.id] ??
        (controlId ? controls[controlId] : undefined) ??
        controlDefault ??
        joint.defaultValue;
      jointStates[joint.id] = clamp(
        requested,
        joint.limits?.lower,
        joint.limits?.upper,
      );
    }

    const nodeTransforms = new Map<number, RigidTransform>(initialTransforms);
    for (const { joint, parentNode, childNode, restParent, inverseChild } of ordered) {
      const parent = nodeTransforms.get(parentNode) ?? identity();
      const local = composeTransform(
        composeTransform(
          restParent,
          motionTransform(joint, jointStates[joint.id]!),
        ),
        inverseChild,
      );
      nodeTransforms.set(childNode, composeTransform(parent, local));
    }

    const transforms: Record<string, RigidTransform> = {};
    for (const handle of resolvedHandles) {
      const transform = nodeTransforms.get(handle.nodeIndex!);
      if (transform) transforms[handle.id] = transform;
    }
    return {
      jointStates,
      transforms,
      nodeTransforms: Object.fromEntries(
        [...nodeTransforms.entries()].sort(([a], [b]) => a - b),
      ),
    };
  };
}

/** Single-pose API retained for existing callers. */
export function evaluateArticulatedKinematics(
  input: unknown,
  controls: Readonly<Record<string, number>> = {},
  baseTransforms: Readonly<Record<number, RigidTransform>> = {},
): ArticulatedKinematicResult {
  return createArticulatedKinematicsEvaluator(input, baseTransforms)(controls);
}
