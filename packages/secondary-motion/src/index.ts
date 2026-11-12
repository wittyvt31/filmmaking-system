import type {
  CollisionProxy,
  MotionQuaternion,
  MotionVector,
  RigidTransform,
  SecondaryMotionAuthoredPose,
  SecondaryMotionBake,
  SecondaryMotionFrame,
  SecondaryMotionNode,
  SecondaryMotionConfiguration,
  SecondaryMotionSettings,
} from '@filmmaking/contracts';
import {
  SecondaryMotionBakeSchema,
  type SampledSkeletalMotion,
} from '@filmmaking/contracts';

export type { SecondaryMotionFrame };
export type SecondaryMotionInput = {
  config: SecondaryMotionBake;
  authored?: readonly SecondaryMotionAuthoredPose[];
};

type State = {
  position: MotionVector;
  velocity: MotionVector;
  rotation: MotionQuaternion;
  angularVelocity: MotionVector;
};

const zero: MotionVector = [0, 0, 0];
const identity: MotionQuaternion = [1, 0, 0, 0];
const multiply = (
  a: MotionQuaternion,
  b: MotionQuaternion,
): MotionQuaternion => {
  const [w, x, y, z] = a;
  const [v, i, j, k] = b;
  const result: MotionQuaternion = [
    w * v - x * i - y * j - z * k,
    w * i + x * v + y * k - z * j,
    w * j - x * k + y * v + z * i,
    w * k + x * j - y * i + z * v,
  ];
  return normalize(result);
};
const rotateVector = (q: MotionQuaternion, v: MotionVector): MotionVector => {
  const [w, x, y, z] = q;
  const [a, b, c] = v;
  const tx = 2 * (y * c - z * b);
  const ty = 2 * (z * a - x * c);
  const tz = 2 * (x * b - y * a);
  return [
    a + w * tx + y * tz - z * ty,
    b + w * ty + z * tx - x * tz,
    c + w * tz + x * ty - y * tx,
  ];
};
const composeTransform = (
  a: RigidTransform,
  b: RigidTransform,
): RigidTransform => ({
  position: add(a.position, rotateVector(a.rotation, b.position)),
  rotation: multiply(a.rotation, b.rotation),
});
function overlapsSphere(
  proxy: CollisionProxy,
  center: MotionVector,
  radius: number,
): boolean {
  const point = rotateVector(
    conjugate(proxy.pose.rotation),
    subtract(center, proxy.pose.position),
  );
  const [x, y, z] = point;
  switch (proxy.shape.kind) {
    case 'box': {
      const shape = proxy.shape;
      return (
        Math.hypot(
          ...point.map((value, index) =>
            Math.max(0, Math.abs(value) - shape.dimensions[index]! / 2),
          ),
        ) <= radius
      );
    }
    case 'sphere':
      return Math.hypot(x, y, z) <= proxy.shape.radius + radius;
    case 'cylinder':
      return (
        Math.hypot(
          Math.max(0, Math.hypot(x, y) - proxy.shape.radius),
          Math.max(0, Math.abs(z) - proxy.shape.height / 2),
        ) <= radius
      );
    case 'capsule':
      return (
        Math.hypot(
          x,
          y,
          Math.max(0, Math.abs(z) - proxy.shape.segmentLength / 2),
        ) <=
        proxy.shape.radius + radius
      );
  }
}
const add = (a: readonly number[], b: readonly number[]): MotionVector => [
  a[0]! + b[0]!,
  a[1]! + b[1]!,
  a[2]! + b[2]!,
];
const subtract = (a: readonly number[], b: readonly number[]): MotionVector => [
  a[0]! - b[0]!,
  a[1]! - b[1]!,
  a[2]! - b[2]!,
];
const scale = (a: readonly number[], amount: number): MotionVector => [
  a[0]! * amount,
  a[1]! * amount,
  a[2]! * amount,
];
const length = (a: readonly number[]) => Math.hypot(a[0]!, a[1]!, a[2]!);
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const normalize = (q: MotionQuaternion): MotionQuaternion => {
  const size = Math.hypot(...q);
  return size ? (q.map((value) => value / size) as MotionQuaternion) : identity;
};
const conjugate = ([w, x, y, z]: MotionQuaternion): MotionQuaternion => [
  w,
  -x,
  -y,
  -z,
];
const quaternionError = (
  current: MotionQuaternion,
  target: MotionQuaternion,
): MotionVector => {
  let delta = multiply(target, conjugate(current));
  if (delta[0] < 0) delta = delta.map((value) => -value) as MotionQuaternion;
  const angle =
    2 * Math.atan2(Math.hypot(delta[1], delta[2], delta[3]), delta[0]);
  const axisLength = Math.hypot(delta[1], delta[2], delta[3]);
  return axisLength < 1e-10
    ? zero
    : scale([delta[1], delta[2], delta[3]], angle / axisLength);
};
const rotationStep = (angularVelocity: MotionVector): MotionQuaternion => {
  const angle = length(angularVelocity);
  if (angle < 1e-12) return identity;
  const half = angle / 2;
  const factor = Math.sin(half) / angle;
  return [
    Math.cos(half),
    angularVelocity[0] * factor,
    angularVelocity[1] * factor,
    angularVelocity[2] * factor,
  ];
};
const sortedNodes = (nodes: readonly SecondaryMotionNode[]) => {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: SecondaryMotionNode[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id))
      throw new TypeError(`Secondary motion cycle at "${id}"`);
    const node = byId.get(id);
    if (!node) throw new TypeError(`Unknown secondary motion node "${id}"`);
    visiting.add(id);
    if (node.parentId) visit(node.parentId);
    visiting.delete(id);
    visited.add(id);
    result.push(node);
  };
  [...byId.keys()].sort().forEach(visit);
  return result;
};

function resolveCollision(
  position: MotionVector,
  radius: number,
  colliders: readonly CollisionProxy[],
): MotionVector {
  if (
    !radius ||
    !colliders.some((proxy) => overlapsSphere(proxy, position, radius))
  )
    return position;
  const directions: readonly MotionVector[] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];
  let best: MotionVector | undefined;
  for (const direction of directions) {
    let low = 0;
    let high = radius * 4 + 0.001;
    for (let iteration = 0; iteration < 16; iteration += 1) {
      const middle = (low + high) / 2;
      if (
        colliders.some((proxy) =>
          overlapsSphere(
            proxy,
            add(position, scale(direction, middle)),
            radius,
          ),
        )
      )
        low = middle;
      else high = middle;
    }
    const candidate = add(position, scale(direction, high));
    if (!best || high < length(subtract(candidate, position))) best = candidate;
  }
  return best ?? position;
}

function authoredPose(
  node: SecondaryMotionNode,
  frame: number,
  authored: ReadonlyMap<string, ReadonlyMap<number, RigidTransform>>,
): RigidTransform {
  return (
    node.overrides.find((override) => override.frame === frame)?.pose ??
    authored.get(node.id)?.get(frame) ??
    node.restPose
  );
}

export function bakeSecondaryMotion(
  input: SecondaryMotionInput,
): SecondaryMotionFrame[] {
  const config = SecondaryMotionBakeSchema.parse(input.config);
  const nodes = sortedNodes(config.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const authored = new Map<string, Map<number, RigidTransform>>();
  for (const pose of input.authored ?? []) {
    if (!nodeIds.has(pose.nodeId))
      throw new TypeError(
        `Authored pose targets unknown secondary motion node "${pose.nodeId}"`,
      );
    const frames =
      authored.get(pose.nodeId) ?? new Map<number, RigidTransform>();
    if (frames.has(pose.frame))
      throw new TypeError(
        `Duplicate authored pose for "${pose.nodeId}" at frame ${pose.frame}`,
      );
    frames.set(pose.frame, pose.pose);
    authored.set(pose.nodeId, frames);
  }
  const states = new Map<string, State>();
  for (const node of nodes) {
    states.set(node.id, {
      position: [...node.restPose.position],
      velocity: [...zero],
      rotation: [...node.restPose.rotation],
      angularVelocity: [...zero],
    });
  }
  const frames: SecondaryMotionFrame[] = [];
  const colliders: CollisionProxy[] = config.colliders.map((collider) => ({
    ...collider,
    entityId: `secondary-motion:${collider.id}`,
  }));
  const secondsPerFrame =
    config.settings.frameRate.denominator / config.settings.frameRate.numerator;
  for (let frame = 0; frame < config.frameCount; frame += 1) {
    const world = new Map<string, RigidTransform>();
    const locals = new Map<string, RigidTransform>();
    for (const node of nodes) {
      const state = states.get(node.id)!;
      const target = authoredPose(node, frame, authored);
      const parent = node.parentId ? world.get(node.parentId) : undefined;
      const targetWorld = parent ? composeTransform(parent, target) : target;
      const dt = secondsPerFrame / config.settings.substeps;
      if (frame === 0) {
        state.position = [...targetWorld.position];
        state.velocity = [...zero];
        state.rotation = [...targetWorld.rotation];
        state.angularVelocity = [...zero];
      }
      for (let step = 0; step < config.settings.substeps; step += 1) {
        const acceleration = add(
          scale(
            subtract(targetWorld.position, state.position),
            node.stiffness / node.massKg,
          ),
          subtract(
            node.gravity,
            scale(state.velocity, node.damping / node.massKg),
          ),
        );
        state.velocity = scale(
          add(state.velocity, scale(acceleration, dt)),
          Math.max(0, 1 - node.drag * dt),
        );
        if (node.maxSpeed) {
          const speed = length(state.velocity);
          if (speed > node.maxSpeed)
            state.velocity = scale(state.velocity, node.maxSpeed / speed);
        }
        state.position = add(state.position, scale(state.velocity, dt));
        const rotationAcceleration = subtract(
          quaternionError(state.rotation, targetWorld.rotation),
          scale(state.angularVelocity, node.damping / node.massKg),
        );
        state.angularVelocity = add(
          state.angularVelocity,
          scale(rotationAcceleration, dt),
        );
        state.rotation = multiply(
          rotationStep(scale(state.angularVelocity, dt)),
          state.rotation,
        );
      }
      if (
        node.anchored ||
        authored.get(node.id)?.has(frame) ||
        node.overrides.some((override) => override.frame === frame)
      ) {
        state.position = [...targetWorld.position];
        state.velocity = [...zero];
        state.rotation = [...targetWorld.rotation];
        state.angularVelocity = [...zero];
      }
      for (
        let iteration = 0;
        iteration < config.settings.solverIterations;
        iteration += 1
      ) {
        if (node.motionLimit) {
          const localPosition = parent
            ? rotateVector(
                conjugate(parent.rotation),
                subtract(state.position, parent.position),
              )
            : state.position;
          const limited = localPosition.map((value, index) =>
            clamp(
              value,
              node.motionLimit!.min[index]!,
              node.motionLimit!.max[index]!,
            ),
          ) as MotionVector;
          state.position = parent
            ? add(parent.position, rotateVector(parent.rotation, limited))
            : limited;
        }
        const resolved = resolveCollision(
          state.position,
          node.radius,
          colliders,
        );
        const unchanged = resolved.every(
          (value, index) => value === state.position[index],
        );
        state.position = resolved;
        if (unchanged) break;
      }
      const local = parent
        ? {
            position: rotateVector(
              conjugate(parent.rotation),
              subtract(state.position, parent.position),
            ),
            rotation: multiply(conjugate(parent.rotation), state.rotation),
          }
        : {
            position: [...state.position] as MotionVector,
            rotation: state.rotation,
          };
      locals.set(node.id, local);
      world.set(node.id, {
        position: [...state.position],
        rotation: normalize(state.rotation),
      });
    }
    frames.push({
      frame,
      poses: nodes.map((node) => ({
        nodeId: node.id,
        local: locals.get(node.id)!,
        world: world.get(node.id)!,
      })),
    });
  }
  return frames;
}

export function bakeSecondaryMotionByFrame(
  config: SecondaryMotionBake,
  authored: readonly SecondaryMotionAuthoredPose[] = [],
): ReadonlyMap<number, SecondaryMotionFrame> {
  return new Map(
    bakeSecondaryMotion({ config, authored }).map((frame) => [
      frame.frame,
      frame,
    ]),
  );
}

export function bakeSecondarySkeletalMotion(
  motion: SampledSkeletalMotion,
  configuration: SecondaryMotionConfiguration,
  frameRate: SecondaryMotionSettings['frameRate'],
): SampledSkeletalMotion {
  const durationFrames = motion.joints.reduce(
    (length, track) => Math.max(length, track.rotations.length),
    Math.max(
      motion.rootPosition?.length ?? 0,
      motion.rootRotation?.length ?? 0,
      motion.rootScale?.length ?? 0,
    ),
  );
  if (!durationFrames) return motion;
  const rotations = new Map(
    motion.joints.map((track) => [track.joint, track.rotations]),
  );
  const nodes = configuration.nodes.filter((node) => rotations.has(node.id));
  if (!nodes.length) return motion;
  const authored: SecondaryMotionAuthoredPose[] = [];
  for (const node of nodes) {
    const values = rotations.get(node.id)!;
    for (let frame = 0; frame < durationFrames; frame += 1) {
      authored.push({
        nodeId: node.id,
        frame,
        pose: {
          position: node.restPose.position,
          rotation: values[frame] ?? node.restPose.rotation,
        },
      });
    }
  }
  const baked = bakeSecondaryMotion({
    config: {
      frameCount: durationFrames,
      settings: {
        frameRate,
        substeps: configuration.substeps,
        solverIterations: configuration.solverIterations,
        deterministicSeed: configuration.deterministicSeed,
      },
      nodes,
      colliders: configuration.colliders,
    },
    authored,
  });
  const bakedRotations = new Map(
    nodes.map((node) => [
      node.id,
      baked.map(
        (frame) =>
          frame.poses.find((pose) => pose.nodeId === node.id)!.local.rotation,
      ),
    ]),
  );
  return {
    ...motion,
    joints: motion.joints.map((track) => ({
      ...track,
      ...(bakedRotations.has(track.joint)
        ? { rotations: bakedRotations.get(track.joint)! }
        : {}),
    })),
  };
}

export const solveSecondaryMotion = bakeSecondaryMotion;

export type { SecondaryMotionNode, SecondaryMotionSettings };
