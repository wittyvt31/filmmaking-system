import type {
  RigidTransform,
  MotionQuaternion,
  MotionVector,
} from '@filmmaking/contracts';
import { multiply, mixVector, slerp } from './motion-math.js';

export const conjugate = ([w, x, y, z]: MotionQuaternion): MotionQuaternion => [
  w,
  -x,
  -y,
  -z,
];
export function rotateVector(
  q: MotionQuaternion,
  v: MotionVector,
): MotionVector {
  const [w, x, y, z] = q,
    [a, b, c] = v;
  const tx = 2 * (y * c - z * b),
    ty = 2 * (z * a - x * c),
    tz = 2 * (x * b - y * a);
  return [
    a + w * tx + y * tz - z * ty,
    b + w * ty + z * tx - x * tz,
    c + w * tz + x * ty - y * tx,
  ];
}
export function composeTransform(
  a: RigidTransform,
  b: RigidTransform,
): RigidTransform {
  const offset = rotateVector(a.rotation, b.position);
  return {
    position: offset.map((v, i) => v + a.position[i]!) as MotionVector,
    rotation: multiply(a.rotation, b.rotation),
  };
}
export function inverseTransform(a: RigidTransform): RigidTransform {
  const rotation = conjugate(a.rotation);
  return {
    rotation,
    position: rotateVector(rotation, a.position.map((v) => -v) as MotionVector),
  };
}
export function blendTransform(
  a: RigidTransform,
  b: RigidTransform,
  t: number,
): RigidTransform {
  return {
    position: mixVector(a.position, b.position, t),
    rotation: slerp(a.rotation, b.rotation, t),
  };
}
export function angularDistance(
  a: MotionQuaternion,
  b: MotionQuaternion,
): number {
  const dot = Math.abs(a.reduce((sum, v, i) => sum + v * b[i]!, 0));
  return 2 * Math.acos(Math.min(1, dot));
}
