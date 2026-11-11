import type {
  CompiledWorld,
  MotionVector,
  RigidTransform,
} from '@filmmaking/contracts';
import { quaternion } from './motion-math.js';
import {
  composeTransform,
  inverseTransform,
  rotateVector,
} from './rigid-transforms.js';

const xyz = ({
  x,
  y,
  z,
}: {
  x: number;
  y: number;
  z: number;
}): MotionVector => [x, y, z];
const scaled = (v: MotionVector, scale: number): MotionVector => [
  v[0] * scale,
  v[1] * scale,
  v[2] * scale,
];

export function locomotionTerrain(
  world: CompiledWorld | undefined,
  floor: number,
  step: number,
) {
  const transforms = new Map<string, { pose: RigidTransform; scale: number }>();
  const boxes = (world?.entities ?? []).flatMap((entity) => {
    const { position, rotationDegrees, scale } = entity.transform;
    const parent = entity.parentId
      ? transforms.get(entity.parentId)
      : undefined;
    const local = {
      position: scaled(xyz(position), parent?.scale ?? 1),
      rotation: quaternion(xyz(rotationDegrees)),
    };
    const pose = parent ? composeTransform(parent.pose, local) : local;
    const worldScale = scale * (parent?.scale ?? 1);
    transforms.set(entity.id, { pose, scale: worldScale });
    if (!('boxes' in entity)) return [];
    return entity.boxes.map((box) => {
      const transform = composeTransform(pose, {
        position: scaled(xyz(box.position), worldScale),
        rotation: quaternion([0, 0, box.rotationDegrees ?? 0]),
      });
      if (rotateVector(transform.rotation, [0, 0, 1])[2] < 1 - 1e-8)
        throw new TypeError(
          `Locomotion requires horizontal collision boxes: ${entity.id}/${box.id}`,
        );
      const half = scaled(xyz(box.dimensions), worldScale / 2);
      return {
        id: entity.id + '/' + box.id,
        inverse: inverseTransform(transform),
        half,
        top: transform.position[2] + half[2],
        bottom: transform.position[2] - half[2],
      };
    });
  });
  const contains = (
    box: (typeof boxes)[number],
    point: MotionVector,
    radius = 0,
  ) => {
    const local = composeTransform(box.inverse, {
      position: point,
      rotation: [1, 0, 0, 0],
    }).position;
    const dx = Math.max(0, Math.abs(local[0]) - box.half[0]);
    const dy = Math.max(0, Math.abs(local[1]) - box.half[1]);
    return Math.hypot(dx, dy) <= radius;
  };
  return {
    ground(point: MotionVector) {
      const supports = boxes.filter(
        (box) =>
          Math.abs(box.top - point[2]) <= step + 1e-8 && contains(box, point),
      );
      return supports.length
        ? Math.max(...supports.map((box) => box.top))
        : floor;
    },
    obstacle(point: MotionVector, height: number, radius: number) {
      return boxes.find(
        (box) =>
          box.top > point[2] + 1e-5 &&
          box.bottom < point[2] + height &&
          contains(box, point, radius),
      )?.id;
    },
  };
}
