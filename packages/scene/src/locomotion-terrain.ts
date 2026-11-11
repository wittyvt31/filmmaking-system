import type { CompiledWorld, MotionVector } from '@filmmaking/contracts';
import { transformPoint, worldCollisionProxies } from './collision.js';
import { inverseTransform, rotateVector } from './rigid-transforms.js';

export function locomotionTerrain(
  world: CompiledWorld | undefined,
  floor: number,
  step: number,
) {
  const volumes = worldCollisionProxies(world).map((proxy) => {
    const { shape, pose } = proxy;
    const upright = rotateVector(pose.rotation, [0, 0, 1])[2] >= 1 - 1e-8;
    const halfHeight =
      shape.kind === 'box'
        ? shape.dimensions[2] / 2
        : shape.kind === 'cylinder'
          ? shape.height / 2
          : shape.kind === 'capsule'
            ? shape.segmentLength / 2 + shape.radius
            : shape.radius;
    const radius =
      shape.kind === 'box'
        ? Math.hypot(shape.dimensions[0] / 2, shape.dimensions[1] / 2)
        : shape.radius;
    const bound = Math.hypot(radius, halfHeight);
    const vertical = upright || shape.kind === 'sphere' ? halfHeight : bound;
    const inverse = inverseTransform(pose);
    return {
      id: proxy.entityId + '/' + proxy.id,
      top: pose.position[2] + vertical,
      bottom: pose.position[2] - vertical,
      support: upright && (shape.kind === 'box' || shape.kind === 'cylinder'),
      contains(point: MotionVector, margin = 0) {
        if (!upright)
          return (
            Math.hypot(
              point[0] - pose.position[0],
              point[1] - pose.position[1],
            ) <=
            bound + margin
          );
        const [x, y] = transformPoint(inverse, point);
        if (shape.kind !== 'box') return Math.hypot(x, y) <= radius + margin;
        return (
          Math.hypot(
            Math.max(0, Math.abs(x) - shape.dimensions[0] / 2),
            Math.max(0, Math.abs(y) - shape.dimensions[1] / 2),
          ) <= margin
        );
      },
    };
  });
  return {
    ground(point: MotionVector) {
      const supports = volumes.filter(
        (volume) =>
          volume.support &&
          Math.abs(volume.top - point[2]) <= step + 1e-8 &&
          volume.contains(point),
      );
      return supports.length
        ? Math.max(...supports.map((volume) => volume.top))
        : floor;
    },
    obstacle(point: MotionVector, height: number, radius: number) {
      return volumes.find(
        (volume) =>
          volume.top > point[2] + 1e-5 &&
          volume.bottom < point[2] + height &&
          volume.contains(point, radius),
      )?.id;
    },
  };
}
