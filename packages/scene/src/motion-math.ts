import type { MotionQuaternion, MotionVector } from '@filmmaking/contracts';

const radians = Math.PI / 180;
export const identity: MotionQuaternion = [1, 0, 0, 0];
export const mix = (a: number, b: number, t: number) => a * (1 - t) + b * t;
export const mixVector = (
  a: MotionVector,
  b: MotionVector,
  t: number,
): MotionVector => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
const dot = (a: MotionQuaternion, b: MotionQuaternion) =>
  a.reduce((sum, v, i) => sum + v * b[i]!, 0);
const normalize = (q: MotionQuaternion): MotionQuaternion => {
  const n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
};
export const sameHemisphere = (
  a: MotionQuaternion,
  b: MotionQuaternion,
): MotionQuaternion => (dot(a, b) < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b);

export function multiply(
  a: MotionQuaternion,
  b: MotionQuaternion,
): MotionQuaternion {
  const [w, x, y, z] = a;
  const [v, i, j, k] = b;
  return normalize([
    w * v - x * i - y * j - z * k,
    w * i + x * v + y * k - z * j,
    w * j - x * k + y * v + z * i,
    w * k + x * j - y * i + z * v,
  ]);
}

export function quaternion(degrees: MotionVector): MotionQuaternion {
  const [x, y, z] = degrees.map(
    (value) => (value * radians) / 2,
  ) as MotionVector;
  return multiply(
    multiply(
      [Math.cos(z), 0, 0, Math.sin(z)],
      [Math.cos(y), 0, Math.sin(y), 0],
    ),
    [Math.cos(x), Math.sin(x), 0, 0],
  );
}

export function slerp(
  a: MotionQuaternion,
  end: MotionQuaternion,
  t: number,
): MotionQuaternion {
  const b = sameHemisphere(a, end);
  const cosine = Math.min(1, dot(a, b));
  const angle = Math.acos(cosine);
  const sin = Math.sin(angle);
  const left = cosine > 0.9995 ? 1 - t : Math.sin((1 - t) * angle) / sin;
  const right = cosine > 0.9995 ? t : Math.sin(t * angle) / sin;
  return normalize([
    a[0] * left + b[0] * right,
    a[1] * left + b[1] * right,
    a[2] * left + b[2] * right,
    a[3] * left + b[3] * right,
  ]);
}

export function withinLimits(
  q: MotionQuaternion,
  min: readonly number[],
  max: readonly number[],
): boolean {
  const [w, x, y, z] = q;
  const pitch = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  const inside = (angles: number[]) =>
    angles.every(
      (angle, i) => angle >= min[i]! - 1e-5 && angle <= max[i]! + 1e-5,
    );
  const wrap = (angle: number) => ((((angle + 180) % 360) + 360) % 360) - 180;
  if (Math.abs(pitch) >= 1 - 1e-12) {
    const sign = Math.sign(pitch);
    const roll =
      Math.atan2(2 * (w * x - y * z), 1 - 2 * (x * x + z * z)) / radians;
    // At the singularity only roll minus signed yaw is observable.
    const low = min[0]! - (sign > 0 ? max[2]! : -min[2]!);
    const high = max[0]! - (sign > 0 ? min[2]! : -max[2]!);
    return (
      sign * 90 >= min[1]! &&
      sign * 90 <= max[1]! &&
      [roll - 360, roll, roll + 360].some(
        (value) => value >= low - 1e-5 && value <= high + 1e-5,
      )
    );
  }
  const a = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) / radians;
  const b = Math.asin(pitch) / radians;
  const c = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) / radians;
  return (
    inside([a, b, c]) || inside([wrap(a + 180), wrap(180 - b), wrap(c + 180)])
  );
}

export function ease(
  t: number,
  mode: string,
  bezier?: readonly number[],
): number {
  if (bezier) {
    const [x1, y1, x2, y2] = bezier as [number, number, number, number];
    const cubic = (u: number, a: number, b: number) =>
      3 * (1 - u) ** 2 * u * a + 3 * (1 - u) * u * u * b + u ** 3;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const middle = (lo + hi) / 2;
      if (cubic(middle, x1, x2) < t) lo = middle;
      else hi = middle;
    }
    return cubic((lo + hi) / 2, y1, y2);
  }
  switch (mode) {
    case 'hold':
      return 0;
    case 'ease-in':
      return t * t;
    case 'ease-out':
      return 1 - (1 - t) ** 2;
    case 'ease':
    case 'ease-in-out':
      return t * t * (3 - 2 * t);
    default:
      return t;
  }
}

export interface CurveKey<T> {
  time: number;
  value: T;
  interpolation: string;
  bezier?: readonly number[] | undefined;
}

export function sampleCurve<T>(
  keys: readonly CurveKey<T>[],
  time: number,
  interpolate: (a: T, b: T, t: number) => T,
): T {
  let left = 0;
  let right = keys.length;
  while (left + 1 < right) {
    const middle = (left + right) >>> 1;
    if (keys[middle]!.time <= time) left = middle;
    else right = middle;
  }
  const a = keys[left]!;
  const b = keys[left + 1];
  if (!b || time <= a.time) return a.value;
  return interpolate(
    a.value,
    b.value,
    ease((time - a.time) / (b.time - a.time), a.interpolation, a.bezier),
  );
}
