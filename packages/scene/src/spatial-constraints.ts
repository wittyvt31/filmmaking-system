import type {
  MotionQuaternion as Q,
  MotionVector as V,
  PreparedCharacter,
  SampledSkeletalMotion,
  SpatialConstraint,
} from '@filmmaking/contracts';
import {
  identity,
  multiply,
  quaternion,
  withinLimits,
  mixVector,
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
  const result = new Map<string, { head: V; tail: V; rotation: Q }>();
  const bones = new Map(character.bones.map((b) => [b.id, b]));
  const visiting = new Set<string>();
  const visit = (id: string): { head: V; tail: V; rotation: Q } => {
    const cached = result.get(id);
    if (cached) return cached;
    const bone = bones.get(id);
    if (!bone || visiting.has(id))
      throw new TypeError('Invalid IK hierarchy: ' + id);
    visiting.add(id);
    const rest = basis(bone.head, bone.tail);
    let head: V = [...bone.head],
      orientation = rest;
    if (bone.parent) {
      const parent = visit(bone.parent),
        parentBone = bones.get(bone.parent)!;
      const deformation = multiply(
        parent.rotation,
        inverse(basis(parentBone.head, parentBone.tail)),
      );
      head = add(
        parent.head,
        rotate(deformation, sub(bone.head, parentBone.head)),
      );
      orientation = multiply(deformation, rest);
    }
    const rotation = multiply(orientation, rotations.get(id) ?? identity);
    const tail = add(
      head,
      rotate(rotation, [0, Math.hypot(...sub(bone.tail, bone.head)), 0]),
    );
    const value = { head, tail, rotation };
    result.set(id, value);
    visiting.delete(id);
    return value;
  };
  for (const bone of character.bones) visit(bone.id);
  return result;
}

/** Deterministic bounded coordinate descent, seeded with the sampled authored pose. */
export function constrainMotion(
  character: PreparedCharacter,
  input: SampledSkeletalMotion | undefined,
  constraints: readonly SpatialConstraint[],
  frames: number,
): SampledSkeletalMotion | undefined {
  if (!constraints.length) return input;
  if (character.parentId)
    throw new TypeError(
      'IK on parented characters requires a resolved parent transform',
    );
  const output: SampledSkeletalMotion = structuredClone(
    input ?? { joints: [] },
  );
  const locked = new Set(character.poses.joints.map((t) => t.joint));
  const bones = new Map(character.bones.map((b) => [b.id, b]));
  const ids = new Set<string>();
  const ordered = [...constraints].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
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
  for (let frame = 0; frame < frames; frame++) {
    const active = ordered.filter(
      (c) => frame >= c.startFrame && frame <= c.endFrame,
    );
    if (!active.length) continue;
    const rotations = new Map(
      output.joints.map((t) => [t.joint, t.rotations[frame]!]),
    );
    const initial = forwardKinematics(character, rotations);
    const p =
      output.rootPosition?.[frame] ??
      (Object.values(character.transform.position) as V);
    const r =
      output.rootRotation?.[frame] ??
      quaternion(Object.values(character.transform.rotationDegrees) as V);
    const scale = output.rootScale?.[frame] ?? character.transform.scale;
    const targets = active.map((c) => {
      const target =
        c.space === 'world'
          ? (rotate(inverse(r), sub(c.target, p)).map((v) => v / scale) as V)
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
        target: mixVector(
          initial.get(c.effector)!.tail,
          target,
          t * t * (3 - 2 * t),
        ),
      };
    });
    const errors = () => {
      const fk = forwardKinematics(character, rotations);
      return targets.map(({ c, target }) =>
        Math.hypot(...sub(fk.get(c.effector)!.tail, target)),
      );
    };
    let best = errors();
    const better = (next: number[]) => {
      for (let i = 0; i < next.length; i++) {
        const tolerance = targets[i]!.c.tolerance / scale;
        const a = Math.max(0, next[i]! - tolerance),
          b = Math.max(0, best[i]! - tolerance);
        if (Math.abs(a - b) > 1e-10) return a < b;
      }
      return false;
    };
    for (const step of [8, 4, 2, 1, 0.5, 0.25, 0.125, 0.0625]) {
      for (let iteration = 0; iteration < 80; iteration++) {
        let changed = false;
        for (const { c } of targets)
          for (const id of chains.get(c.id)!)
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
        if (
          !changed ||
          best.every((e, i) => e <= targets[i]!.c.tolerance / scale)
        )
          break;
      }
    }
    for (let i = 0; i < best.length; i++)
      if (best[i]! > targets[i]!.c.tolerance / scale)
        throw new TypeError(
          `Constraint ${targets[i]!.c.id} unreachable or conflicts with authored motion/contacts at frame ${frame}: residual ${best[i]! * scale} metres`,
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
