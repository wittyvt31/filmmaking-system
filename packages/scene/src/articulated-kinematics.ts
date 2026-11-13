import {
  AssetDescriptorSchema,
  type AssetDescriptor,
  type RigidTransform,
  type MotionQuaternion,
  type MotionVector,
} from '@filmmaking/contracts';
import { composeTransform, inverseTransform } from './rigid-transforms.js';
import { multiply } from './motion-math.js';

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

export function evaluateArticulatedKinematics(
  input: unknown,
  controls: Readonly<Record<string, number>> = {},
  baseTransforms: Readonly<Record<number, RigidTransform>> = {},
): ArticulatedKinematicResult {
  const descriptor = AssetDescriptorSchema.parse(input);
  const joints = [...descriptor.articulation.joints].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const jointStates: Record<string, number> = {};
  for (const joint of joints) {
    const control = joint.control
      ? descriptor.articulation.controls.find(
          (candidate) => candidate.id === joint.control,
        )
      : undefined;
    const requested =
      controls[joint.id] ??
      (control ? controls[control.id] : undefined) ??
      control?.defaultValue ??
      joint.defaultValue;
    jointStates[joint.id] = clamp(
      requested,
      joint.limits?.lower,
      joint.limits?.upper,
    );
  }
  const nodeTransforms = new Map<number, RigidTransform>(
    Object.entries(baseTransforms).map(([index, transform]) => [
      Number(index),
      transform,
    ]),
  );
  const transforms: Record<string, RigidTransform> = {};
  const visiting = new Set<string>();
  const evaluated = new Set<string>();
  const evaluateJoint = (
    joint: AssetDescriptor['articulation']['joints'][number],
  ) => {
    if (evaluated.has(joint.id)) return;
    if (visiting.has(joint.id))
      throw new TypeError(`Articulation cycle at joint "${joint.id}"`);
    visiting.add(joint.id);
    const parentNode = targetNode(descriptor, joint.parent);
    const childNode = targetNode(descriptor, joint.child);
    const parentJoint = joints.find(
      (candidate) =>
        targetNode(descriptor, candidate.child) === parentNode &&
        candidate.id !== joint.id,
    );
    if (parentJoint) evaluateJoint(parentJoint);
    const parent = nodeTransforms.get(parentNode) ?? identity();
    const local = composeTransform(
      composeTransform(
        joint.parentTransform,
        motionTransform(joint, jointStates[joint.id]!),
      ),
      inverseTransform(joint.childTransform),
    );
    const child = composeTransform(parent, local);
    nodeTransforms.set(childNode, child);
    visiting.delete(joint.id);
    evaluated.add(joint.id);
  };
  for (const joint of joints) evaluateJoint(joint);
  for (const handle of descriptor.resolvedHandles ?? []) {
    if (handle.nodeIndex !== undefined) {
      const transform = nodeTransforms.get(handle.nodeIndex);
      if (transform) transforms[handle.id] = transform;
    }
  }
  return {
    jointStates,
    transforms: Object.fromEntries(
      Object.entries(transforms).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    nodeTransforms: Object.fromEntries(
      [...nodeTransforms.entries()].sort(([a], [b]) => a - b),
    ),
  };
}
