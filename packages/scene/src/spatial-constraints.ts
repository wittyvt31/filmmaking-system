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

/** Bone-local rotations use the same zero-roll +Y rest convention as the rig. */
export function forwardKinematics(
  character: PreparedCharacter,
  rotations: ReadonlyMap<string, Q>,
) {
  return prepareKinematics(character)(rotations);
}

function prepareKinematics(character: PreparedCharacter) {
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
): SampledSkeletalMotion | undefined {
  if (!constraints.length) return input;
  const parents: PreparedCharacter['transform'][] = [];
  const visited = new Set<string>();
  const worldParent = constraints.some(({ space }) => space === 'world')
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
  for (const c of ordered) {
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
      chain.filter((id) => !locked.has(id)),
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
  for (let frame = 0; frame < frames; frame++) {
    const active = ordered.filter(
      (c) => frame >= c.startFrame && frame <= c.endFrame,
    );
    if (!active.length) continue;
    const rotations = new Map(
      output.joints.map((t) => [t.joint, t.rotations[frame]!]),
    );
    const initial = evaluate(rotations);
    const p = output.rootPosition?.[frame] ?? xyz(character.transform.position);
    const r =
      output.rootRotation?.[frame] ??
      quaternion(xyz(character.transform.rotationDegrees));
    const scale = output.rootScale?.[frame] ?? character.transform.scale;
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
              Math.max(0, error.position / targets[i]!.c.tolerance - 1) ** 2 +
              Math.max(0, error.angle / error.angularTolerance - 1) ** 2,
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
    for (const step of [8, 4, 2, 1, 0.5, 0.25, 0.125, 0.0625]) {
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
