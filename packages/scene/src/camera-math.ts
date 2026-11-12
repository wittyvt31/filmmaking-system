import type {
  CameraRig,
  CameraSample,
  MotionQuaternion as Q,
  MotionVector as V,
} from '@filmmaking/contracts';
import { identity, multiply } from './motion-math.js';
import { conjugate, rotateVector } from './rigid-transforms.js';

export const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (v: V, k: number): V => [v[0] * k, v[1] * k, v[2] * k];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v: V) => scale(v, 1 / Math.hypot(...v));
const forward: V = [0, 0, -1];
const up: V = [0, 1, 0];
export function axisAngle(axis: V, radians: number): Q {
  const v = scale(axis, Math.sin(radians / 2));
  return [Math.cos(radians / 2), ...v];
}
export function rotateTo(a: V, b: V): Q {
  const d = dot(a, b);
  const axis = cross(a, b);
  const length = Math.hypot(...axis);
  if (length > 1e-12)
    return axisAngle(scale(axis, 1 / length), Math.atan2(length, d));
  return d >= 0
    ? identity
    : axisAngle(
        unit(cross(a, Math.abs(a[0]) < 0.8 ? [1, 0, 0] : [0, 1, 0])),
        Math.PI,
      );
}

export function cameraLook(position: V, target: V, ray: V = forward): Q {
  const displacement = sub(target, position);
  if (Math.hypot(...displacement) < 1e-8)
    throw new TypeError('Camera and aim target coincide');
  const aim = unit(displacement);
  const turn = rotateTo(forward, aim);
  const right = cross(aim, [0, 0, 1]);
  const worldUp = cross(
    unit(Math.hypot(...right) > 1e-8 ? right : cross(aim, [0, 1, 0])),
    aim,
  );
  const currentUp = rotateVector(turn, up);
  const roll = Math.atan2(
    dot(aim, cross(currentUp, worldUp)),
    dot(currentUp, worldUp),
  );
  return multiply(
    multiply(axisAngle(aim, roll), turn),
    rotateTo(unit(ray), forward),
  );
}

export function filmPlane(
  sensor: CameraRig['optics']['sensor'],
  aspect: number,
): [number, number] {
  return sensor.fit === 'horizontal'
    ? [sensor.width, sensor.width / aspect]
    : [sensor.height * aspect, sensor.height];
}

export function projectCameraPoint(
  sample: CameraSample,
  target: V,
  plane: [number, number],
) {
  const [x, y, z] = rotateVector(
    conjugate(sample.orientation),
    sub(target, sample.position),
  );
  const depth = -z;
  return {
    x: 0.5 + (x * sample.focalLength) / (depth * plane[0]),
    y: 0.5 + (y * sample.focalLength) / (depth * plane[1]),
    depth,
  };
}
