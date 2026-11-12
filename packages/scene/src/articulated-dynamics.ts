import {
  ArticulatedAssemblySchema,
  type ArticulatedAssembly,
  type PhysicalJoint,
  type RigidTransform,
  type MotionVector as V,
  type MotionQuaternion as Q,
} from '@filmmaking/contracts';
import {
  composeTransform,
  inverseTransform,
  blendTransform,
  angularDistance,
  conjugate,
} from './rigid-transforms.js';
import { multiply } from './motion-math.js';

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
const vector = (f: (i: number) => number): V => [f(0), f(1), f(2)];
const axisAngle = (v: V): Q => {
  const angle = Math.hypot(...v);
  return angle < 1e-12
    ? [1, 0, 0, 0]
    : ([
        Math.cos(angle / 2),
        ...v.map((x) => (x * Math.sin(angle / 2)) / angle),
      ] as Q);
};
const rotationVector = (q: Q): V => {
  const sign = q[0] < 0 ? -1 : 1;
  const length = Math.hypot(q[1], q[2], q[3]);
  return length < 1e-12
    ? [0, 0, 0]
    : vector(
        (i) =>
          (q[i + 1]! * sign * 2 * Math.atan2(length, Math.abs(q[0]))) / length,
      );
};
export interface ArticulatedState {
  pose: RigidTransform;
  velocity: V;
  angularVelocity: V;
  mode: 'static' | 'kinematic' | 'dynamic';
}
export interface JointResidual {
  jointId: string;
  position: number;
  angle: number;
  satisfied: boolean;
}
export function articulatedCollisionAllowed(
  assembly: ArticulatedAssembly,
  a: string,
  b: string,
): boolean {
  const left = assembly.bodies.find((x) => x.id === a),
    right = assembly.bodies.find((x) => x.id === b);
  if (!left || !right) throw new TypeError('Unknown collision body');
  return (
    a !== b &&
    !!(left.collisionGroup & right.collisionMask) &&
    !!(right.collisionGroup & left.collisionMask) &&
    !assembly.joints.some(
      (j) =>
        !j.collideConnected &&
        ((j.bodyA === a && j.bodyB === b) || (j.bodyA === b && j.bodyB === a)),
    )
  );
}
function coordinate(j: PhysicalJoint, relative: RigidTransform): number {
  if (j.kind === 'slider') return relative.position[0];
  return (
    2 *
    Math.atan2(
      relative.rotation[1] * (relative.rotation[0] < 0 ? -1 : 1),
      Math.abs(relative.rotation[0]),
    )
  );
}
function permitted(
  j: PhysicalJoint,
  relative: RigidTransform,
  driven?: number,
): RigidTransform {
  const pose: RigidTransform = { position: [0, 0, 0], rotation: [1, 0, 0, 0] };
  const value = clamp(driven ?? coordinate(j, relative), j.minimum, j.maximum);
  if (j.kind === 'slider') pose.position = [value, 0, 0];
  if (j.kind === 'hinge') pose.rotation = axisAngle([value, 0, 0]);
  if (j.kind === 'ball') {
    const v = rotationVector(relative.rotation),
      angle = Math.hypot(...v);
    pose.rotation = axisAngle(
      v.map((x) => x * Math.min(1, j.maximum / (angle || 1))) as V,
    );
  }
  return pose;
}
/** Bounded position-based dynamics with isotropic inertia and explicit residuals.
 * Motors are rate-limited kinematic drives. Collision pair filtering is exposed for a contact backend.
 * Replays fixed steps from frame zero for deterministic random access.
 */
export function evaluateArticulatedFrame(
  input: ArticulatedAssembly,
  frame: number,
  fps: number,
) {
  const assembly = ArticulatedAssemblySchema.parse(input);
  if (
    !Number.isInteger(frame) ||
    frame < 0 ||
    !Number.isFinite(fps) ||
    fps <= 0
  )
    throw new TypeError('Invalid frame or frame rate');
  if (
    (frame + 1) *
      assembly.settings.substeps *
      assembly.settings.solverIterations *
      Math.max(1, assembly.joints.length) >
    20_000_000
  )
    throw new TypeError('Articulated solve exceeds operation budget');
  const bodies = [...assembly.bodies].sort((a, b) => (a.id < b.id ? -1 : 1));
  const joints = [...assembly.joints].sort((a, b) => (a.id < b.id ? -1 : 1));
  const states = new Map<string, ArticulatedState>(
    bodies.map((b) => [
      b.id,
      {
        pose: structuredClone(b.pose),
        velocity: [0, 0, 0],
        angularVelocity: [0, 0, 0],
        mode: b.mode,
      },
    ]),
  );
  const properties = new Map(bodies.map((b) => [b.id, b]));
  const h = 1 / fps / assembly.settings.substeps;
  const relative = (j: PhysicalJoint) =>
    composeTransform(
      inverseTransform(composeTransform(states.get(j.bodyA)!.pose, j.anchorA)),
      composeTransform(states.get(j.bodyB)!.pose, j.anchorB),
    );
  const residuals = (): JointResidual[] =>
    joints.map((j) => {
      const actual = relative(j),
        goal = permitted(j, actual);
      const position = Math.hypot(
          ...actual.position.map((v, i) => v - goal.position[i]!),
        ),
        angle = angularDistance(actual.rotation, goal.rotation);
      return {
        jointId: j.id,
        position,
        angle,
        satisfied:
          position <= assembly.positionTolerance &&
          angle <= assembly.angularTolerance,
      };
    });
  const authored = (b: ArticulatedAssembly['bodies'][number], time: number) => {
    const left = [...b.authored].reverse().find((k) => k.frame <= time);
    if (!left) throw new TypeError('Missing authored pose: ' + b.id);
    const right = b.authored.find((k) => k.frame > time);
    return right
      ? blendTransform(
          left.pose,
          right.pose,
          (time - left.frame) / (right.frame - left.frame),
        )
      : structuredClone(left.pose);
  };
  for (const b of bodies)
    if (b.mode === 'kinematic') states.get(b.id)!.pose = authored(b, 0);
  const failures: { frame: number; residuals: JointResidual[] }[] = [];
  for (let f = 0; f <= frame; f++) {
    for (const b of bodies) {
      const state = states.get(b.id)!;
      const transition = b.transitions.find((t) => t.frame === f);
      if (transition) {
        state.mode = transition.mode;
        if (state.mode === 'kinematic') state.pose = authored(b, f);
        if (state.mode === 'static') {
          state.velocity = [0, 0, 0];
          state.angularVelocity = [0, 0, 0];
        }
      }
    }
    if (f === frame) break;
    for (let step = 1; step <= assembly.settings.substeps; step++) {
      const previous = new Map(
        [...states].map(([id, s]) => [id, structuredClone(s.pose)]),
      );
      for (const b of bodies) {
        const s = states.get(b.id)!;
        if (s.mode === 'kinematic') {
          s.pose = authored(b, f + step / assembly.settings.substeps);
          continue;
        }
        if (s.mode !== 'dynamic') continue;
        const loads = b.loads.filter(
          (l) => f >= l.startFrame && f <= l.endFrame,
        );
        s.velocity = vector(
          (i) =>
            (s.velocity[i]! +
              h *
                (assembly.settings.gravity[i]! +
                  loads.reduce((n, l) => n + l.force[i]!, 0) / b.massKg)) *
            Math.exp(-b.linearDamping * h),
        );
        s.angularVelocity = vector(
          (i) =>
            (s.angularVelocity[i]! +
              (h * loads.reduce((n, l) => n + l.torque[i]!, 0)) /
                b.inertiaKgM2) *
            Math.exp(-b.angularDamping * h),
        );
        s.pose.position = vector(
          (i) => s.pose.position[i]! + s.velocity[i]! * h,
        );
        s.pose.rotation = multiply(
          axisAngle(s.angularVelocity.map((v) => v * h) as V),
          s.pose.rotation,
        );
      }
      const goals = new Map(
        joints.map((j) => {
          const current = coordinate(j, relative(j));
          const before = composeTransform(
            inverseTransform(
              composeTransform(previous.get(j.bodyA)!, j.anchorA),
            ),
            composeTransform(previous.get(j.bodyB)!, j.anchorB),
          );
          let next =
            coordinate(j, before) +
            (current - coordinate(j, before)) * Math.exp(-j.damping * h);
          if (j.motor)
            next =
              coordinate(j, before) +
              clamp(j.motor.velocity, -j.motor.maxRate, j.motor.maxRate) * h;
          if (j.drive)
            next =
              coordinate(j, before) +
              clamp(
                (j.drive.target - next) * j.drive.stiffness,
                -j.drive.maxRate,
                j.drive.maxRate,
              ) *
                h;
          const relativePose = relative(j);
          const damped =
            j.kind === 'ball'
              ? {
                  ...relativePose,
                  rotation: blendTransform(
                    before,
                    relativePose,
                    Math.exp(-j.damping * h),
                  ).rotation,
                }
              : relativePose;
          return [j.id, permitted(j, damped, next)] as const;
        }),
      );
      for (
        let iteration = 0;
        iteration < assembly.settings.solverIterations;
        iteration++
      )
        for (const j of joints) {
          const a = states.get(j.bodyA)!,
            b = states.get(j.bodyB)!;
          const wa =
              a.mode === 'dynamic' ? 1 / properties.get(j.bodyA)!.massKg : 0,
            wb = b.mode === 'dynamic' ? 1 / properties.get(j.bodyB)!.massKg : 0;
          if (!wa && !wb) continue;
          const goal = goals.get(j.id)!;
          const desiredB = composeTransform(
            composeTransform(composeTransform(a.pose, j.anchorA), goal),
            inverseTransform(j.anchorB),
          );
          const desiredA = composeTransform(
            composeTransform(
              composeTransform(b.pose, j.anchorB),
              inverseTransform(goal),
            ),
            inverseTransform(j.anchorA),
          );
          a.pose = blendTransform(a.pose, desiredA, wa / (wa + wb));
          b.pose = blendTransform(b.pose, desiredB, wb / (wa + wb));
        }
      for (const [id, s] of states) {
        if (s.mode === 'static') continue;
        const old = previous.get(id)!;
        s.velocity = vector(
          (i) => (s.pose.position[i]! - old.position[i]!) / h,
        );
        s.angularVelocity = rotationVector(
          multiply(s.pose.rotation, conjugate(old.rotation)),
        ).map((v) => v / h) as V;
      }
    }
    const errors = residuals().filter((r) => !r.satisfied);
    if (errors.length) failures.push({ frame: f + 1, residuals: errors });
  }
  const finalResiduals = residuals();
  return {
    success: !failures.length && finalResiduals.every((r) => r.satisfied),
    frame,
    states: Object.fromEntries(states),
    residuals: finalResiduals,
    failures,
  };
}
