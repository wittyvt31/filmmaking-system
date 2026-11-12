import type {
  CollisionProxy,
  ColliderShape,
  CompiledWorld,
  MotionVector,
  RigidTransform,
  WorldEntity,
} from '@filmmaking/contracts';
import { quaternion } from './motion-math.js';
import {
  composeTransform,
  inverseTransform,
  rotateVector,
} from './rigid-transforms.js';

export const coordinates = ({
  x,
  y,
  z,
}: {
  x: number;
  y: number;
  z: number;
}): MotionVector => [x, y, z];
export const scaleVector = (v: MotionVector, scale: number): MotionVector => [
  v[0] * scale,
  v[1] * scale,
  v[2] * scale,
];
export function sceneTransformPose(
  transform: WorldEntity['transform'],
): RigidTransform {
  return {
    position: coordinates(transform.position),
    rotation: quaternion(coordinates(transform.rotationDegrees)),
  };
}
export const transformPoint = (
  pose: RigidTransform,
  point: MotionVector,
): MotionVector =>
  rotateVector(pose.rotation, point).map(
    (value, i) => value + pose.position[i]!,
  ) as MotionVector;

export function worldEntityTransforms(world?: CompiledWorld) {
  const transforms = new Map<string, { pose: RigidTransform; scale: number }>();
  for (const entity of world?.entities ?? []) {
    const parent = entity.parentId
      ? transforms.get(entity.parentId)
      : undefined;
    const { scale } = entity.transform;
    const local = sceneTransformPose(entity.transform);
    local.position = scaleVector(local.position, parent?.scale ?? 1);
    transforms.set(entity.id, {
      pose: parent ? composeTransform(parent.pose, local) : local,
      scale: scale * (parent?.scale ?? 1),
    });
  }
  return transforms;
}

export function scaleShape(shape: ColliderShape, scale: number): ColliderShape {
  switch (shape.kind) {
    case 'box':
      return { ...shape, dimensions: scaleVector(shape.dimensions, scale) };
    case 'sphere':
      return { ...shape, radius: shape.radius * scale };
    case 'cylinder':
      return {
        ...shape,
        radius: shape.radius * scale,
        height: shape.height * scale,
      };
    case 'capsule':
      return {
        ...shape,
        radius: shape.radius * scale,
        segmentLength: shape.segmentLength * scale,
      };
  }
}

export function worldCollisionProxies(world?: CompiledWorld): CollisionProxy[] {
  const transforms = worldEntityTransforms(world);
  const meshes = new Map(world?.meshes?.map((mesh) => [mesh.id, mesh.shape]));
  return (world?.entities ?? []).flatMap((entity) => {
    const { pose, scale } = transforms.get(entity.id)!;
    const mesh = 'meshId' in entity ? meshes.get(entity.meshId) : undefined;
    const primitive: ColliderShape | undefined =
      mesh?.kind === 'box'
        ? { kind: 'box', dimensions: mesh.dimensions }
        : mesh?.kind === 'sphere'
          ? { kind: 'sphere', radius: mesh.radius }
          : mesh?.kind === 'cylinder'
            ? { kind: 'cylinder', radius: mesh.radius, height: mesh.height }
            : undefined;
    const colliders =
      entity.colliders ??
      (primitive
        ? [
            {
              id: 'body',
              shape: primitive,
              pose: {
                position: [0, 0, 0] as MotionVector,
                rotation: quaternion([0, 0, 0]),
              },
            },
          ]
        : 'boxes' in entity
          ? entity.boxes.map((box) => ({
              id: box.id,
              shape: {
                kind: 'box' as const,
                dimensions: coordinates(box.dimensions),
              },
              pose: {
                position: coordinates(box.position),
                rotation: quaternion([0, 0, box.rotationDegrees ?? 0]),
              },
            }))
          : []);
    return colliders.map((collider) => ({
      id: collider.id,
      entityId: entity.id,
      pose: composeTransform(pose, {
        ...collider.pose,
        position: scaleVector(collider.pose.position, scale),
      }),
      shape: scaleShape(collider.shape, scale),
    }));
  });
}

/** Exact sphere overlap against a primitive, in its own rotated coordinates. */
export function overlapsSphere(
  proxy: CollisionProxy,
  center: MotionVector,
  radius: number,
): boolean {
  const point = transformPoint(inverseTransform(proxy.pose), center);
  const [x, y, z] = point;
  const shape = proxy.shape;
  switch (shape.kind) {
    case 'box':
      return (
        Math.hypot(
          ...point.map((v, i) =>
            Math.max(0, Math.abs(v) - shape.dimensions[i]! / 2),
          ),
        ) <= radius
      );
    case 'sphere':
      return Math.hypot(x, y, z) <= shape.radius + radius;
    case 'cylinder':
      return (
        Math.hypot(
          Math.max(0, Math.hypot(x, y) - shape.radius),
          Math.max(0, Math.abs(z) - shape.height / 2),
        ) <= radius
      );
    case 'capsule':
      return (
        Math.hypot(x, y, Math.max(0, Math.abs(z) - shape.segmentLength / 2)) <=
        shape.radius + radius
      );
  }
}
