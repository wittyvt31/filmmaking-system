import type {
  CompiledWorld,
  MotionQuaternion as Q,
  MotionVector as V,
  PreparedCharacter,
  SampledSkeletalMotion,
  SpatialConstraint,
} from '@filmmaking/contracts';
import { compareStrings } from '@filmmaking/contracts';
import { angularDistance } from './rigid-transforms.js';
import type { RigidTransform } from '@filmmaking/contracts';
import {
  identity,
  multiply,
  quaternion,
  withinLimits,
  mixVector,
  slerp,
} from './motion-math.js';

const sub = (a: readonly number[], b: readonly number[]): V => [
  a[0]! - b[0]!,
  a[1]! - b[1]!,
  a[2]! - b[2]!,
];
const add = (a: readonly number[], b: readonly number[]): V => [
  a[0]! + b[0]!,
  a[1]! + b[1]!,
  a[2]! + b[2]!,
];
const inverse = (q: Q): Q => [q[0], -q[1], -q[2], -q[3]];
const xyz = ({ x, y, z }: { x: number; y: number; z: number }): V => [x, y, z];
function rotate(q: Q, v: readonly number[]): V {
  const [w, x, y, z] = q;
  const [a, b, c] = v as V;
  const tx = 2 * (y * c - z * b),
    ty = 2 * (z * a - x * c),
    tz = 2 * (x * b - y * a);
  return [
    a + w * tx + y * tz - z * ty,
    b + w * ty + z * tx - x * tz,
    c + w * tz + x * ty - y * tx,
  ];
}
function basis(head: readonly number[], tail: readonly number[]): Q {
  const d = sub(tail, head),
    length = Math.hypot(...d);
  if (!length) throw new TypeError('Zero-length IK bone');
  const y = d[1] / length;
  if (y < -0.99999999) return [0, 1, 0, 0];
  const q: Q = [1 + y, d[2] / length, 0, -d[0] / length];
  const n = Math.hypot(...q);
  return q.map((v) => v / n) as Q;
}

const dotVector = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scaled = (v: V, amount: number): V => [
  v[0] * amount,
  v[1] * amount,
  v[2] * amount,
];
const unit = (v: V) => scaled(v, 1 / Math.hypot(...v));
function align(from: V, to: V): Q {
  const a = unit(from),
    b = unit(to);
  const q: Q = [
    1 + dotVector(a, b),
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const length = Math.hypot(...q);
  return length < 1e-10 ? identity : (q.map((v) => v / length) as Q);
}

// Seed a humanoid leg from the two-link knee intersection. The normal IK
// search still checks all joint limits and resolves competing constraints.
function seedLeg(
  effector: string,
  root: string,
  target: V,
  orientation: Q,
  rotations: Map<string, Q>,
  evaluate: ReturnType<typeof prepareKinematics>,
  bones: ReadonlyMap<string, PreparedCharacter['bones'][number]>,
  movable: readonly string[],
) {
  const foot = bones.get(effector)!;
  const shin = bones.get(foot.parent!)!;
  const thigh = bones.get(root)!;
  if (
    !movable.includes(foot.id) ||
    !movable.includes(shin.id) ||
    !movable.includes(thigh.id)
  )
    return;
  const trial = new Map(rotations);
  for (const bone of [foot, shin, thigh]) trial.delete(bone.id);
  const fk = evaluate(trial);
  const hip = fk.get(root)!.head;
  const ankle = sub(
    target,
    rotate(orientation, [0, Math.hypot(...sub(foot.tail, foot.head)), 0]),
  );
  const ray = sub(ankle, hip);
  const distance = Math.hypot(...ray);
  const upper = Math.hypot(...sub(shin.head, thigh.head));
  const lower = Math.hypot(...sub(foot.head, shin.head));
  if (
    distance < 1e-8 ||
    distance > upper + lower ||
    distance < Math.abs(upper - lower)
  )
    return;
  const axis = unit(ray);
  const forward: V = [0, -1, 0];
  const pole = sub(forward, scaled(axis, dotVector(forward, axis)));
  if (Math.hypot(...pole) < 1e-8) return;
  const projection = (upper ** 2 - lower ** 2 + distance ** 2) / (2 * distance);
  const knee = add(
    hip,
    add(
      scaled(axis, projection),
      scaled(unit(pole), Math.sqrt(Math.max(0, upper ** 2 - projection ** 2))),
    ),
  );
  for (const [bone, point] of [
    [thigh, knee],
    [shin, ankle],
  ] as const) {
    const current = evaluate(trial).get(bone.id)!;
    const desired = multiply(
      align(sub(current.tail, current.head), sub(point, current.head)),
      current.rotation,
    );
    trial.set(bone.id, multiply(inverse(current.rotation), desired));
  }
  const currentFoot = evaluate(trial).get(foot.id)!;
  trial.set(foot.id, multiply(inverse(currentFoot.rotation), orientation));
  for (const bone of [thigh, shin, foot]) {
    if (!withinLimits(trial.get(bone.id)!, bone.min, bone.max)) return;
  }
  for (const bone of [thigh, shin, foot])
    rotations.set(bone.id, trial.get(bone.id)!);
}

/** Bone-local rotations use the same zero-roll +Y rest convention as the rig. */
export function forwardKinematics(
  character: PreparedCharacter,
  rotations: ReadonlyMap<string, Q>,
) {
  return prepareKinematics(character)(rotations);
}

export function prepareKinematics(character: PreparedCharacter) {
  const restBones = new Map(
    character.bones.map((bone) => [
      bone.id,
      {
        ...bone,
        basis: basis(bone.head, bone.tail),
        length: Math.hypot(...sub(bone.tail, bone.head)),
      },
    ]),
  );
  return (rotations: ReadonlyMap<string, Q>) => {
    const result = new Map<string, { head: V; tail: V; rotation: Q }>();
    const visiting = new Set<string>();
    const visit = (id: string): { head: V; tail: V; rotation: Q } => {
      const cached = result.get(id);
      if (cached) return cached;
      const bone = restBones.get(id);
      if (!bone || visiting.has(id))
        throw new TypeError('Invalid IK hierarchy: ' + id);
      visiting.add(id);
      const rest = bone.basis;
      let head: V = [...bone.head],
        orientation = rest;
      if (bone.parent) {
        const parent = visit(bone.parent),
          parentBone = restBones.get(bone.parent)!;
        const deformation = multiply(
          parent.rotation,
          inverse(parentBone.basis),
        );
        head = add(
          parent.head,
          rotate(deformation, sub(bone.head, parentBone.head)),
        );
        orientation = multiply(deformation, rest);
      }
      const rotation = multiply(orientation, rotations.get(id) ?? identity);
      const tail = add(head, rotate(rotation, [0, bone.length, 0]));
      const value = { head, tail, rotation };
      result.set(id, value);
      visiting.delete(id);
      return value;
    };
    for (const bone of character.bones) visit(bone.id);
    return result;
  };
}

/** Deterministic bounded coordinate descent, seeded with the sampled authored pose. */
export function constrainMotion(
  character: PreparedCharacter,
  input: SampledSkeletalMotion | undefined,
  constraints: readonly SpatialConstraint[],
  frames: number,
  world?: CompiledWorld,
  driver?: {
    constraint: SpatialConstraint;
    target(
      frame: number,
      hand: RigidTransform,
    ): { pose: RigidTransform; priority: number } | undefined;
    resolved(frame: number, hand: RigidTransform): void;
  },
  locomotionContacts: ReadonlySet<string> = new Set(),
): SampledSkeletalMotion | undefined {
  if (!constraints.length && !driver) return input;
  const parents: PreparedCharacter['transform'][] = [];
  const visited = new Set<string>();
  const worldParent =
    driver || constraints.some(({ space }) => space === 'world')
      ? character.parentId
      : undefined;
  for (let id = worldParent; id;) {
    const entity = world?.entities.find((item) => item.id === id);
    if (!entity || visited.has(id))
      throw new TypeError(`Invalid IK world parent ${id} for ${character.id}`);
    visited.add(id);
    parents.unshift(entity.transform);
    id = entity.parentId;
  }
  const parentScale = parents.reduce(
    (scale, transform) => scale * transform.scale,
    1,
  );
  const inParentSpace = (target: V): V =>
    parents.reduce(
      (point, transform) =>
        rotate(
          inverse(quaternion(xyz(transform.rotationDegrees))),
          sub(point, xyz(transform.position)),
        ).map((value) => value / transform.scale) as V,
      target,
    );
  const evaluate = prepareKinematics(character);
  const output: SampledSkeletalMotion = structuredClone(
    input ?? { joints: [] },
  );
  const locked = new Set(character.poses.joints.map((t) => t.joint));
  const bones = new Map(character.bones.map((b) => [b.id, b]));
  const ids = new Set<string>();
  const ordered = [...constraints].sort(
    (a, b) => b.priority - a.priority || compareStrings(a.id, b.id),
  );
  const chains = new Map<string, string[]>();
  for (const c of driver ? [...ordered, driver.constraint] : ordered) {
    if (ids.has(c.id) || c.endFrame >= frames)
      throw new TypeError('Duplicate or out-of-range constraint: ' + c.id);
    ids.add(c.id);
    const chain: string[] = [];
    let id: string | undefined = c.effector;
    while (id) {
      const b = bones.get(id);
      if (!b) throw new TypeError('Unknown constraint bone: ' + id);
      chain.push(id);
      if (id === c.chainRoot) break;
      id = b.parent;
    }
    if (chain.at(-1) !== c.chainRoot)
      throw new TypeError('Constraint root is not an ancestor: ' + c.id);
    chains.set(
      c.id,
      (c === driver?.constraint ? chain.reverse() : chain).filter(
        (id) => !locked.has(id),
      ),
    );
  }
  const outputJoints = new Set([
    ...output.joints.map((t) => t.joint),
    ...[...chains.values()].flat(),
  ]);
  if (frames * outputJoints.size > 250_000)
    throw new TypeError(
      `Character "${character.id}" exceeds 250,000 motion samples with constraints`,
    );
  let previousInteractionPose: Map<string, Q> | undefined;
  let previousContactPose = new Map<string, Q>();
  const starts = new Map<number, SpatialConstraint[]>();
  for (const constraint of ordered) {
    const start = starts.get(constraint.startFrame) ?? [];
    start.push(constraint);
    starts.set(constraint.startFrame, start);
  }
  let ongoing: SpatialConstraint[] = [];
  for (let frame = 0; frame < frames; frame++) {
    ongoing = ongoing.filter((c) => c.endFrame >= frame);
    ongoing.push(...(starts.get(frame) ?? []));
    const active = [...ongoing].sort(
      (a, b) => b.priority - a.priority || compareStrings(a.id, b.id),
    );
    if (!active.length && !driver) continue;
    const rotations = new Map(
      output.joints.map((t) => [t.joint, t.rotations[frame]!]),
    );
    const initial = evaluate(rotations);
    const contactJoints = new Set(
      active
        .filter((c) => locomotionContacts.has(c.id))
        .flatMap((c) => chains.get(c.id)!),
    );
    for (const joint of contactJoints) {
      const previous = previousContactPose.get(joint);
      if (previous) rotations.set(joint, previous);
    }
    const p = output.rootPosition?.[frame] ?? xyz(character.transform.position);
    const r =
      output.rootRotation?.[frame] ??
      quaternion(xyz(character.transform.rotationDegrees));
    const scale = output.rootScale?.[frame] ?? character.transform.scale;
    const worldHand = (pose: ReturnType<typeof evaluate>): RigidTransform => {
      const bone = pose.get(driver!.constraint.effector)!;
      let position = add(
        p,
        rotate(r, bone.tail.map((value) => value * scale) as V),
      );
      let rotation = multiply(r, bone.rotation);
      for (const parent of [...parents].reverse()) {
        const q = quaternion(xyz(parent.rotationDegrees));
        position = add(
          xyz(parent.position),
          rotate(q, position.map((value) => value * parent.scale) as V),
        );
        rotation = multiply(q, rotation);
      }
      return { position, rotation };
    };
    if (driver) {
      const desired = driver.target(frame, worldHand(initial));
      if (desired) {
        for (const [joint, rotation] of previousInteractionPose ?? [])
          rotations.set(joint, rotation);
        active.push({
          ...driver.constraint,
          target: desired.pose.position,
          orientation: desired.pose.rotation,
          priority: desired.priority,
        });
        active.sort(
          (a, b) => b.priority - a.priority || compareStrings(a.id, b.id),
        );
      } else {
        previousInteractionPose = undefined;
      }
    }
    if (!active.length) {
      driver?.resolved(frame, worldHand(initial));
      continue;
    }
    const targets = active.map((c) => {
      const target =
        c.space === 'world'
          ? (rotate(inverse(r), sub(inParentSpace(c.target), p)).map(
              (v) => v / scale,
            ) as V)
          : c.target;
      const t = c.fadeFrames
        ? Math.min(
            1,
            (frame - c.startFrame) / c.fadeFrames,
            (c.endFrame - frame) / c.fadeFrames,
          )
        : 1;
      return {
        c,
        orientation: c.orientation
          ? slerp(
              initial.get(c.effector)!.rotation,
              c.space === 'world'
                ? multiply(
                    inverse(r),
                    parents.reduce(
                      (q, transform) =>
                        multiply(
                          inverse(quaternion(xyz(transform.rotationDegrees))),
                          q,
                        ),
                      c.orientation,
                    ),
                  )
                : c.orientation,
              t * t * (3 - 2 * t),
            )
          : undefined,
        unitScale: c.space === 'world' ? scale * parentScale : 1,
        target: mixVector(
          initial.get(c.effector)!.tail,
          target,
          t * t * (3 - 2 * t),
        ),
      };
    });
    for (const { c, target, orientation } of targets) {
      if (orientation && locomotionContacts.has(c.id))
        seedLeg(
          c.effector,
          c.chainRoot,
          target,
          orientation,
          rotations,
          evaluate,
          bones,
          chains.get(c.id)!,
        );
    }
    const errors = () => {
      const fk = evaluate(rotations);
      return targets.map(({ c, target, orientation, unitScale }) => ({
        position:
          Math.hypot(...sub(fk.get(c.effector)!.tail, target)) * unitScale,
        angle: orientation
          ? angularDistance(fk.get(c.effector)!.rotation, orientation)
          : 0,
        angularTolerance: c.angularTolerance ?? 0.01,
      }));
    };
    let best = errors();
    const priorities = [...new Set(targets.map(({ c }) => c.priority))];
    const cost = (values: ReturnType<typeof errors>, priority: number) =>
      values.reduce(
        (sum, error, i) =>
          targets[i]!.c.priority !== priority
            ? sum
            : sum +
              Math.max(
                0,
                error.position / targets[i]!.c.tolerance -
                  (targets[i]!.orientation ? 0.85 : 1),
              ) **
                2 +
              Math.max(0, error.angle / error.angularTolerance - 0.85) ** 2,
        0,
      );
    const better = (next: ReturnType<typeof errors>) => {
      for (const priority of priorities) {
        const difference = cost(next, priority) - cost(best, priority);
        if (Math.abs(difference) > 1e-10) return difference < 0;
      }
      return false;
    };
    const solved = () =>
      best.every(
        (e, i) =>
          e.position <= targets[i]!.c.tolerance &&
          e.angle <= e.angularTolerance,
      );
    const movable = new Set(targets.flatMap(({ c }) => chains.get(c.id)!));
    for (const step of [
      8, 4, 2, 1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125,
    ]) {
      if (solved()) break;
      for (let iteration = 0; iteration < 80; iteration++) {
        let changed = false;
        for (const id of movable)
          for (let axis = 0; axis < 3; axis++) {
            const old = rotations.get(id) ?? identity,
              bone = bones.get(id)!;
            for (const sign of [-1, 1]) {
              const delta: V = [0, 0, 0];
              delta[axis] = sign * step;
              const candidate = multiply(old, quaternion(delta));
              if (!withinLimits(candidate, bone.min, bone.max)) continue;
              rotations.set(id, candidate);
              const next = errors();
              if (better(next)) {
                best = next;
                changed = true;
                break;
              }
              rotations.set(id, old);
            }
          }
        if (!changed || solved()) break;
      }
    }
    for (let i = 0; i < best.length; i++)
      if (
        best[i]!.position > targets[i]!.c.tolerance ||
        best[i]!.angle > best[i]!.angularTolerance
      )
        throw new TypeError(
          `Constraint ${targets[i]!.c.id} on ${character.id} unreachable or conflicts with authored motion/contacts at frame ${frame}: residual ${best[i]!.position} metres, ${best[i]!.angle} radians in ${targets[i]!.c.space} space`,
        );
    driver?.resolved(frame, worldHand(evaluate(rotations)));
    previousContactPose = new Map(
      [...contactJoints].map((joint) => [
        joint,
        rotations.get(joint) ?? identity,
      ]),
    );
    if (driver && active.some((c) => c.id === driver.constraint.id)) {
      previousInteractionPose = new Map(
        chains
          .get(driver.constraint.id)!
          .map((joint) => [joint, rotations.get(joint) ?? identity]),
      );
    }
    for (const [joint, value] of rotations) {
      let track = output.joints.find((t) => t.joint === joint);
      if (!track) {
        track = {
          joint,
          rotations: Array.from({ length: frames }, () => [...identity] as Q),
        };
        output.joints.push(track);
      }
      track.rotations[frame] = value;
    }
  }
  return output;
}
