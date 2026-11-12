import type { CollisionProxy, MotionVector as V } from '@filmmaking/contracts';
import { inverseTransform } from './rigid-transforms.js';
import { transformPoint } from './collision.js';
import { sub } from './camera-math.js';

/** Analytic segment tests against the open segment between the camera and subject. */
export function proxyBlocksSegment(
  proxy: CollisionProxy,
  origin: V,
  target: V,
): boolean {
  const inverse = inverseTransform(proxy.pose);
  const start = transformPoint(inverse, origin);
  const delta = sub(transformPoint(inverse, target), start);
  type Span = [number, number];
  const full: Span = [-Infinity, Infinity];
  const slab = (
    center: number,
    direction: number,
    half: number,
  ): Span | undefined => {
    if (Math.abs(direction) < 1e-12)
      return Math.abs(center) <= half ? full : undefined;
    const a = (-half - center) / direction,
      b = (half - center) / direction;
    return [Math.min(a, b), Math.max(a, b)];
  };
  const radial = (
    center: number[],
    direction: number[],
    radius: number,
  ): Span | undefined => {
    const a = direction.reduce((sum, v) => sum + v * v, 0);
    const b = center.reduce((sum, v, i) => sum + v * direction[i]!, 0);
    const c = center.reduce((sum, v) => sum + v * v, 0) - radius * radius;
    if (a < 1e-24) return c <= 0 ? full : undefined;
    const d = b * b - a * c;
    if (d < 0) return undefined;
    return [(-b - Math.sqrt(d)) / a, (-b + Math.sqrt(d)) / a];
  };
  const hit = (...intervals: (Span | undefined)[]) =>
    intervals.every((s) => s !== undefined) &&
    Math.max(1e-6, ...intervals.map((s) => s![0])) <=
      Math.min(1 - 1e-6, ...intervals.map((s) => s![1]));
  const shape = proxy.shape;
  if (shape.kind === 'box')
    return hit(
      ...shape.dimensions.map((v, i) => slab(start[i]!, delta[i]!, v / 2)),
    );
  if (shape.kind === 'sphere') return hit(radial(start, delta, shape.radius));
  const half =
    (shape.kind === 'cylinder' ? shape.height : shape.segmentLength) / 2;
  if (
    hit(
      radial(start.slice(0, 2), delta.slice(0, 2), shape.radius),
      slab(start[2], delta[2], half),
    )
  )
    return true;
  return (
    shape.kind === 'capsule' &&
    [-half, half].some((z) =>
      hit(radial([start[0], start[1], start[2] - z], delta, shape.radius)),
    )
  );
}
