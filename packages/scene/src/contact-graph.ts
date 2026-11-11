import {
  ContactGraphSchema,
  RigidTransformSchema,
  UnitQuaternionSchema,
  compareStrings,
  type ContactEndpoint,
  type MotionQuaternion,
  type MotionVector,
  type PreparedCharacter,
  type RigidTransform,
} from '@filmmaking/contracts';
import { forwardKinematics } from './spatial-constraints.js';
import { identity, multiply, quaternion, withinLimits } from './motion-math.js';
import {
  angularDistance,
  blendTransform,
  composeTransform,
  inverseTransform,
} from './rigid-transforms.js';

export interface ContactParticipant {
  character: PreparedCharacter;
  /** Fully resolved world root; caller folds hierarchy, root motion and uniform scale here. */
  root: RigidTransform;
  scale: number;
  rotations: ReadonlyMap<string, MotionQuaternion>;
  /** Exact authored channels must be locked; other sampled motion is the solver seed. */
  lockedJoints: ReadonlySet<string>;
}
export interface ContactResidual {
  id: string;
  positionError: number;
  angularError: number;
  satisfied: boolean;
}
export interface ContactFrameResult {
  frame: number;
  success: boolean;
  iterations: number;
  rotations: Map<string, Map<string, MotionQuaternion>>;
  contacts: ContactResidual[];
}

/** Bounded joint coordinate descent over the whole graph, never independent per-edge IK.
 * Roots remain authored. No hidden prior-frame state: identical sampled input gives
 * identical output, including random-access frame evaluation. Unsatisfied hard contacts
 * remain explicit failures, even if a higher-priority contact was satisfied.
 */
export function solveContactFrame(
  inputGraph: unknown,
  input: readonly ContactParticipant[],
  frame: number,
  maxIterations = 48,
): ContactFrameResult {
  const graph = ContactGraphSchema.parse(inputGraph);
  if (
    !Number.isSafeInteger(frame) ||
    frame < 0 ||
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > 256
  )
    throw new TypeError('Invalid contact frame or iteration budget');
  const participants = [...input].sort((a, b) =>
    compareStrings(a.character.id, b.character.id),
  );
  const byId = new Map(participants.map((p) => [p.character.id, p]));
  if (byId.size !== participants.length)
    throw new TypeError('Duplicate contact participant');
  const poses = new Map<string, Map<string, MotionQuaternion>>();
  for (const p of participants) {
    RigidTransformSchema.parse(p.root);
    if (!Number.isFinite(p.scale) || p.scale <= 0)
      throw new TypeError('Invalid participant scale');
    const bones = new Map(p.character.bones.map((b) => [b.id, b]));
    if (bones.size !== p.character.bones.length)
      throw new TypeError('Duplicate bone ID');
    for (const id of p.lockedJoints)
      if (!bones.has(id)) throw new TypeError(`Unknown locked joint ${id}`);
    for (const [id, q] of p.rotations) {
      UnitQuaternionSchema.parse(q);
      const bone = bones.get(id);
      if (!bone || !withinLimits(q, bone.min, bone.max))
        throw new TypeError(`Invalid authored joint ${id}`);
    }
    poses.set(
      p.character.id,
      new Map([...p.rotations].map(([id, q]) => [id, [...q]])),
    );
    forwardKinematics(p.character, p.rotations);
  }
  const chain = (e: ContactEndpoint) => {
    const p = byId.get(e.entityId);
    if (!p) throw new TypeError(`Unknown contact entity ${e.entityId}`);
    const bones = new Map(p.character.bones.map((b) => [b.id, b]));
    const ids: string[] = [];
    for (
      let id: string | undefined = e.boneId;
      id;
      id = bones.get(id)?.parent
    ) {
      if (ids.includes(id) || !bones.has(id)) break;
      ids.push(id);
      if (id === e.chainRoot) return ids;
    }
    throw new TypeError(
      `Invalid contact chain ${e.entityId}:${e.boneId} -> ${e.chainRoot}`,
    );
  };
  // Validate even inactive edges so invalid references cannot hide behind timing.
  for (const c of graph.contacts) {
    chain(c.a);
    chain(c.b);
  }
  const active = graph.contacts
    .filter((c) => frame >= c.startFrame && frame <= c.endFrame)
    .sort((a, b) => b.priority - a.priority || compareStrings(a.id, b.id));
  const endpoint = (e: ContactEndpoint): RigidTransform => {
    const p = byId.get(e.entityId)!;
    const bone = forwardKinematics(p.character, poses.get(e.entityId)!).get(
      e.boneId,
    )!;
    const local = composeTransform(
      { position: bone.tail, rotation: bone.rotation },
      e.anchor,
    );
    return composeTransform(p.root, {
      ...local,
      position: local.position.map((v) => v * p.scale) as MotionVector,
    });
  };
  const relative = (a: ContactEndpoint, b: ContactEndpoint) =>
    composeTransform(inverseTransform(endpoint(a)), endpoint(b));
  const targets = active.map((c) => {
    const t = Math.min(
      1,
      c.blendInFrames ? (frame - c.startFrame) / c.blendInFrames : 1,
      c.blendOutFrames ? (c.endFrame - frame) / c.blendOutFrames : 1,
    );
    return blendTransform(
      relative(c.a, c.b),
      c.relativePose,
      t * t * (3 - 2 * t),
    );
  });
  const residuals = (): ContactResidual[] =>
    active.map((c, i) => {
      const actual = relative(c.a, c.b),
        target = targets[i]!;
      const positionError =
        c.channels === 'orientation'
          ? 0
          : Math.hypot(
              ...actual.position.map((v, axis) => v - target.position[axis]!),
            );
      const angularError =
        c.channels === 'position'
          ? 0
          : angularDistance(actual.rotation, target.rotation);
      return {
        id: c.id,
        positionError,
        angularError,
        satisfied:
          positionError <= c.positionTolerance &&
          angularError <= c.angularTolerance,
      };
    });
  const priorities = [...new Set(active.map((c) => c.priority))];
  const score = (r: ContactResidual[]) =>
    priorities.map((priority) =>
      active.reduce(
        (sum, c, i) =>
          sum +
          (c.priority === priority
            ? Math.max(0, r[i]!.positionError / c.positionTolerance - 0.5) **
                2 +
              Math.max(0, r[i]!.angularError / c.angularTolerance - 0.5) ** 2
            : 0),
        0,
      ),
    );
  const better = (a: number[], b: number[]) => {
    for (let i = 0; i < a.length; i++)
      if (Math.abs(a[i]! - b[i]!) > 1e-10) return a[i]! < b[i]!;
    return false;
  };
  const movable = new Map<string, Set<string>>();
  for (const c of active)
    for (const e of [c.a, c.b]) {
      const set = movable.get(e.entityId) ?? new Set<string>();
      for (const id of chain(e))
        if (!byId.get(e.entityId)!.lockedJoints.has(id)) set.add(id);
      movable.set(e.entityId, set);
    }
  let errors = residuals(),
    best = score(errors),
    iterations = 0,
    step = 12;
  while (iterations < maxIterations && !errors.every((r) => r.satisfied)) {
    iterations++;
    let changed = false;
    for (const p of participants)
      for (const id of [...(movable.get(p.character.id) ?? [])].sort(
        compareStrings,
      )) {
        const bone = p.character.bones.find((b) => b.id === id)!;
        const rotations = poses.get(p.character.id)!;
        for (let axis = 0; axis < 3; axis++) {
          const original = rotations.get(id) ?? identity;
          let selected = original;
          for (const sign of [-1, 1]) {
            const angles: MotionVector = [0, 0, 0];
            angles[axis] = step * sign;
            const trial = multiply(original, quaternion(angles));
            if (!withinLimits(trial, bone.min, bone.max)) continue;
            rotations.set(id, trial);
            const value = score(residuals());
            if (better(value, best)) {
              best = value;
              selected = trial;
              changed = true;
            }
          }
          rotations.set(id, selected);
        }
      }
    errors = residuals();
    if (!changed) step /= 2;
    if (step < 0.0001) break;
  }
  return {
    frame,
    success: errors.every((r) => r.satisfied),
    iterations,
    rotations: poses,
    contacts: errors,
  };
}

/** Bake using caller-sampled authored motion. A failed frame cannot become a valid bake. */
export function bakeContactGraph(
  graph: unknown,
  frames: number,
  sample: (frame: number) => readonly ContactParticipant[],
) {
  if (!Number.isSafeInteger(frames) || frames < 1)
    throw new TypeError('Invalid contact bake duration');
  const parsed = ContactGraphSchema.parse(graph);
  if (parsed.contacts.some((c) => c.endFrame >= frames))
    throw new TypeError('Contact exceeds bake duration');
  return Array.from({ length: frames }, (_, frame) => {
    const result = solveContactFrame(parsed, sample(frame), frame);
    if (!result.success)
      throw new TypeError(
        `Contact solve failed at frame ${frame}: ${JSON.stringify(result.contacts.filter((c) => !c.satisfied))}`,
      );
    return result;
  });
}
