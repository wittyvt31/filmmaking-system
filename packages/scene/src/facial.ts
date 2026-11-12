import {
  compareStrings,
  type FacialPerformance,
  type FacialRig,
  type MotionQuaternion as Q,
  type MotionVector as V,
  type PreparedCharacter,
  type ShotScene,
  type SpatialConstraint,
} from '@filmmaking/contracts';
import {
  ease,
  identity,
  mix,
  multiply,
  quaternion,
  sameHemisphere,
  sampleCurve,
  slerp,
  withinLimits,
} from './motion-math.js';
import {
  actorWorldPose,
  resolveSceneTargets,
  type TargetScene,
} from './scene-targets.js';
import { worldEntityTransforms, transformPoint } from './collision.js';
import { conjugate, rotateVector } from './rigid-transforms.js';
import { add, rotateTo, scale, sub } from './camera-math.js';
import { prepareKinematics } from './spatial-constraints.js';

export function attachFacialRig(character: PreparedCharacter, rig: FacialRig) {
  if (
    character.source.kind !== 'imported' &&
    (rig.bones.length ||
      Object.values(rig.controls).some((bindings) =>
        bindings.some((b) => b.kind === 'morph'),
      ))
  )
    throw new TypeError(
      'Facial rig bindings require an imported character: ' + character.id,
    );
  const available = new Set(character.bones.map((b) => b.id));
  const pending = new Map(rig.bones.map((b) => [b.id, b]));
  if (
    pending.size !== rig.bones.length ||
    rig.bones.some((b) => available.has(b.id)) ||
    new Set(rig.bones.map((b) => b.source)).size !== rig.bones.length
  )
    throw new TypeError('Duplicate facial bone binding on ' + character.id);
  const mapping: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  while (pending.size) {
    const initial = pending.size;
    for (const [id, bone] of pending) {
      if (!available.has(bone.parent)) continue;
      const { source, ...canonical } = bone;
      character.bones.push(canonical);
      available.add(id);
      mapping[id] = source;
      pending.delete(id);
    }
    if (initial === pending.size)
      throw new TypeError(
        'Unknown or cyclic facial bone parent on ' + character.id,
      );
  }
  if (rig.bones.length) character.facialBoneMap = mapping;
  for (const bindings of Object.values(rig.controls))
    for (const binding of bindings)
      if (binding.kind === 'bone' && !Object.hasOwn(mapping, binding.joint))
        throw new TypeError(
          'Facial control must bind a mapped facial bone: ' + binding.joint,
        );
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));
type Range = {
  startFrame: number;
  endFrame: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  weight: number;
  priority: number;
};
type Layer = Range & {
  blend: 'replace' | 'additive';
  sample(frame: number): Record<string, number>;
};
function weightAt(range: Range, frame: number) {
  const { startFrame, endFrame, fadeInFrames, fadeOutFrames, weight } = range;
  if (frame < startFrame || frame >= endFrame) return 0;
  const fadeIn = fadeInFrames ? (frame - startFrame) / fadeInFrames : 1;
  const fadeOut = fadeOutFrames ? (endFrame - frame) / fadeOutFrames : 1;
  return weight * ease(clamp(Math.min(fadeIn, fadeOut)), 'ease-in-out');
}
function scalarTrack(
  track: FacialPerformance['overrides'][number],
  first: number,
  end: number,
) {
  if (
    track.keys.some(
      (k, i) =>
        k.frame < first ||
        k.frame >= end ||
        (i > 0 && track.keys[i - 1]!.frame >= k.frame),
    )
  )
    throw new TypeError('Invalid facial keyframes for ' + track.control);
  const keys = track.keys.map((k) => ({
    time: k.frame,
    value: k.value,
    interpolation: k.interpolation,
  }));
  return (frame: number) => sampleCurve(keys, frame, mix);
}
function prepareLayers(
  rig: FacialRig,
  performance: FacialPerformance,
  duration: number,
) {
  const requireControl = (id: string) => {
    if (!Object.hasOwn(rig.controls, id))
      throw new TypeError('Unknown facial control ' + id);
  };
  const speechControls = new Set(
    Object.values(rig.visemes).flatMap((v) => Object.keys(v)),
  );
  const layers: Layer[] = performance.layers.map((layer) => {
    if (layer.kind === 'expression') {
      const expression = Object.hasOwn(rig.expressions, layer.expression)
        ? rig.expressions[layer.expression]
        : undefined;
      if (!expression)
        throw new TypeError('Unknown facial expression ' + layer.expression);
      for (const control of Object.keys(expression)) requireControl(control);
      return { ...layer, sample: () => expression };
    }
    requireControl(layer.control);
    const sample = scalarTrack(layer, layer.startFrame, layer.endFrame);
    return {
      ...layer,
      sample: (frame) => ({ [layer.control]: sample(frame) }),
    };
  });
  for (const cue of performance.speech) {
    const viseme =
      cue.kind === 'viseme'
        ? cue.id
        : Object.hasOwn(rig.phonemes, cue.id)
          ? rig.phonemes[cue.id]
          : undefined;
    if (!viseme || !Object.hasOwn(rig.visemes, viseme))
      throw new TypeError('Unknown speech symbol ' + cue.id);
    const values = Object.fromEntries(
      [...speechControls].map((id) => {
        requireControl(id);
        return [id, rig.visemes[viseme]![id] ?? 0];
      }),
    );
    layers.push({ ...cue, blend: 'replace', sample: () => values });
  }
  for (const blink of performance.blinks) {
    requireControl(blink.control);
    layers.push({
      ...blink,
      endFrame:
        blink.startFrame +
        blink.closeFrames +
        blink.holdFrames +
        blink.openFrames,
      fadeInFrames: blink.closeFrames,
      fadeOutFrames: blink.openFrames,
      blend: 'replace',
      sample: () => ({ [blink.control]: 1 }),
    });
  }
  const overrides = performance.overrides.map((track) => {
    requireControl(track.control);
    return {
      control: track.control,
      first: track.keys[0]!.frame,
      sample: scalarTrack(track, 0, duration),
    };
  });
  if (new Set(overrides.map((o) => o.control)).size !== overrides.length)
    throw new TypeError('Duplicate authored facial override');
  if (
    [...layers, ...performance.gaze].some((layer) => layer.endFrame > duration)
  )
    throw new TypeError(
      'Facial layer, blink, gaze or speech exceeds shot duration',
    );
  const work = [...layers, ...performance.gaze].reduce(
    (total, layer) => total + layer.endFrame - layer.startFrame,
    0,
  );
  if (work > 250000)
    throw new TypeError(
      'Facial performance exceeds 250,000 active layer samples',
    );
  return {
    layers: layers.sort((a, b) => a.startFrame - b.startFrame),
    overrides,
  };
}

function layerMixer(layers: readonly Layer[], frame: number) {
  const groups = new Map<
    number,
    Map<string, { weighted: number; opacity: number; additive: number }>
  >();
  for (const layer of layers) {
    const weight = weightAt(layer, frame);
    if (!weight) continue;
    let channels = groups.get(layer.priority);
    if (!channels) groups.set(layer.priority, (channels = new Map()));
    for (const [id, value] of Object.entries(layer.sample(frame))) {
      const c = channels.get(id) ?? { weighted: 0, opacity: 0, additive: 0 };
      if (layer.blend === 'replace') {
        c.weighted += value * weight;
        c.opacity += weight;
      } else c.additive += value * weight;
      channels.set(id, c);
    }
  }
  const result = new Map<string, number>();
  for (const [, channels] of [...groups].sort(([a], [b]) => a - b))
    for (const [id, c] of channels) {
      const prior = result.get(id) ?? 0;
      result.set(
        id,
        clamp(
          (c.opacity
            ? mix(prior, c.weighted / c.opacity, clamp(c.opacity))
            : prior) + c.additive,
        ),
      );
    }
  return result;
}

function limited(
  base: Q,
  target: Q,
  bone: PreparedCharacter['bones'][number],
): Q {
  if (withinLimits(target, bone.min, bone.max)) return target;
  let low = 0,
    high = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2;
    if (withinLimits(slerp(base, target, mid), bone.min, bone.max)) low = mid;
    else high = mid;
  }
  return slerp(base, target, low);
}
const morphId = (v: { mesh: string; target: string }) =>
  JSON.stringify([v.mesh, v.target]);

export function compileFacialPerformance(
  scene: ShotScene,
  compiled: TargetScene,
  duration: number,
  protectedConstraints: ReadonlyMap<string, readonly SpatialConstraint[]>,
  rigs: ReadonlyMap<string, FacialRig>,
) {
  const performers = scene.characters.flatMap((c) =>
    'source' in c && c.facial ? [{ id: c.id, performance: c.facial }] : [],
  );
  if (!performers.length) return;
  const original = compiled.characters.map((c) => ({ ...c }));
  const targets = resolveSceneTargets({ ...compiled, characters: original });
  const world = worldEntityTransforms(compiled.world);
  for (const { id, performance } of performers) {
    const actor = compiled.characters.find(
      (c): c is PreparedCharacter => c.id === id && 'bones' in c,
    )!;
    const rig = rigs.get(performance.rigId)!;
    const { layers, overrides } = prepareLayers(rig, performance, duration);
    if (performance.gaze.length)
      targets.point({ kind: 'entity', entityId: id, offset: [0, 0, 0] }, 0);
    for (const cue of performance.gaze)
      targets.point(cue.target, cue.startFrame);
    const slots = Object.values(rig.controls).flat();
    const animated = new Set([
      ...slots.flatMap((b) => (b.kind === 'bone' ? [b.joint] : [])),
      ...performance.gaze.map((g) => g.joint),
    ]);
    const authoredJoints = new Set(actor.poses.joints.map((t) => t.joint));
    const protectedMorphs = new Set(actor.morphs?.map(morphId));
    const morphs = new Map(
      slots.flatMap((b) =>
        b.kind === 'morph' && !protectedMorphs.has(morphId(b))
          ? [
              [
                morphId(b),
                {
                  mesh: b.mesh,
                  target: b.target,
                  keys: [] as NonNullable<
                    PreparedCharacter['morphs']
                  >[number]['keys'],
                },
              ] as const,
            ]
          : [],
      ),
    );
    if (duration * (animated.size + morphs.size) > 250000)
      throw new TypeError('Facial performance exceeds 250,000 output samples');
    const byJoint = new Map(actor.bones.map((b) => [b.id, b]));
    for (const joint of animated)
      if (!byJoint.has(joint))
        throw new TypeError('Unknown facial gaze joint ' + joint);
    const base = actor.sampledMotion;
    const tracks = new Map(
      [...animated]
        .filter((j) => !authoredJoints.has(j))
        .map((j) => [j, [] as Q[]]),
    );
    const solve = prepareKinematics(actor);
    const owns = (joint: string, effector: string) => {
      for (
        let current: string | undefined = effector;
        current;
        current = byJoint.get(current)?.parent
      )
        if (current === joint) return true;
      return false;
    };
    const objectEffectors = scene.interactions
      .filter((i) => i.characterId === id)
      .map((i) => i.effector);
    const contacts =
      scene.contactGraph?.contacts.flatMap((c) =>
        [c.a, c.b]
          .filter((e) => e.entityId === id)
          .map((e) => ({
            startFrame: c.startFrame,
            endFrame: c.endFrame,
            effector: e.boneId,
          })),
      ) ?? [];
    const constraints = [...(protectedConstraints.get(id) ?? []), ...contacts];
    const gaze = new Map(
      actor.bones.map((b) => [
        b.id,
        performance.gaze
          .filter((g) => g.joint === b.id)
          .sort((a, b) => a.priority - b.priority),
      ]),
    );
    let cursor = 0;
    let active: Layer[] = [];
    for (let frame = 0; frame < duration; frame++) {
      active = active.filter((l) => l.endFrame > frame);
      while (layers[cursor]?.startFrame === frame)
        active.push(layers[cursor++]!);
      const values = layerMixer(active, frame);
      for (const override of overrides)
        if (frame >= override.first)
          values.set(override.control, override.sample(frame));
      const morphValues = new Map<string, number>();
      const angles = new Map<string, V>();
      for (const [id, value] of values)
        for (const binding of rig.controls[id]!) {
          if (binding.kind === 'morph') {
            const key = morphId(binding);
            morphValues.set(
              key,
              (morphValues.get(key) ?? 0) + binding.amount * value,
            );
          } else
            angles.set(
              binding.joint,
              add(
                angles.get(binding.joint) ?? [0, 0, 0],
                scale(binding.rotationDegrees, value),
              ),
            );
        }
      for (const [key, morph] of morphs)
        morph.keys.push({
          frame,
          interpolation: 'linear',
          value: clamp(morphValues.get(key) ?? 0),
        });
      const rotations = new Map(
        base?.joints.map((t) => [t.joint, t.rotations[frame]!]),
      );
      const blocked = [
        ...objectEffectors,
        ...constraints
          .filter((c) => frame >= c.startFrame && frame <= c.endFrame)
          .map((c) => c.effector),
      ];
      const root = actorWorldPose(actor, frame, world);
      for (const bone of actor.bones) {
        const out = tracks.get(bone.id);
        if (!out) continue;
        const prior = rotations.get(bone.id) ?? identity;
        const offset = angles.get(bone.id);
        const gazeCues = gaze
          .get(bone.id)!
          .filter((g) => weightAt(g, frame) > 0);
        let q = prior;
        if (!blocked.some((e) => owns(bone.id, e))) {
          if (offset)
            q = limited(prior, multiply(prior, quaternion(offset)), bone);
          rotations.set(bone.id, q);
          for (const cue of gazeCues) {
            const posed = solve(rotations).get(bone.id)!;
            const origin = transformPoint(
              root.pose,
              scale(posed.head, root.size),
            );
            const direction = sub(targets.point(cue.target, frame), origin);
            const length = Math.hypot(...direction);
            if (length < 1e-8)
              throw new TypeError(
                `Facial gaze target coincides with ${actor.id}/${bone.id} at frame ${frame}`,
              );
            const local = rotateVector(
              conjugate(multiply(root.pose.rotation, posed.rotation)),
              scale(direction, 1 / length),
            );
            const delta = rotateTo(
              scale(cue.forward, 1 / Math.hypot(...cue.forward)),
              local,
            );
            q = limited(
              q,
              multiply(q, slerp(identity, delta, weightAt(cue, frame))),
              bone,
            );
            rotations.set(bone.id, q);
          }
        }
        out.push(out.length ? sameHemisphere(out.at(-1)!, q) : q);
      }
    }
    if (morphs.size)
      actor.morphs = [...(actor.morphs ?? []), ...morphs.values()].sort(
        (a, b) => compareStrings(morphId(a), morphId(b)),
      );
    if (tracks.size)
      actor.sampledMotion = {
        ...base,
        joints: [
          ...(base?.joints.filter((t) => !tracks.has(t.joint)) ?? []),
          ...[...tracks].map(([joint, rotations]) => ({ joint, rotations })),
        ].sort((a, b) => compareStrings(a.joint, b.joint)),
      };
  }
}
