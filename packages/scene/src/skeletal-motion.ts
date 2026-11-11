import {
  compareStrings,
  findRigProfile,
  type MotionLayer,
  type MotionQuaternion,
  type MotionVector,
  type PreparedCharacter,
  type Rational,
  type SampledSkeletalMotion,
  type SkeletalClip,
} from '@filmmaking/contracts';
import {
  ease,
  identity,
  mix,
  mixVector,
  multiply,
  quaternion,
  sameHemisphere,
  sampleCurve,
  slerp,
  withinLimits,
  type CurveKey,
} from './motion-math.js';
import { primitiveClip } from './motion-primitives.js';

const zero: MotionVector = [0, 0, 0];
const epsilon = 1e-8;
type Track<T> = { layer: MotionLayer; duration: number; keys: CurveKey<T>[] };
type Transform = PreparedCharacter['transform'];
const xyz = ({ x, y, z }: Transform['position']): MotionVector => [x, y, z];

function validateClip(clip: SkeletalClip) {
  const profile = findRigProfile(clip.rig.profile, clip.rig.version);
  if (!profile)
    throw new TypeError(
      `Motion clip "${clip.id}" uses an unknown rig profile or version`,
    );
  for (const { joint, keys } of clip.joints) {
    const bone = profile.joints.find((candidate) => candidate.id === joint);
    if (!bone)
      throw new TypeError(
        `Motion clip "${clip.id}" references unknown joint "${joint}"`,
      );
    for (const key of keys)
      if (
        key.value.some(
          (value, axis) => value < bone.min[axis]! || value > bone.max[axis]!,
        )
      )
        throw new TypeError(
          `Motion clip "${clip.id}" exceeds "${joint}" joint limits`,
        );
  }
}

export function motionLibrary(
  clips: readonly SkeletalClip[],
): ReadonlyMap<string, SkeletalClip> {
  const library = new Map<string, SkeletalClip>();
  for (const clip of clips) {
    if (library.has(clip.id))
      throw new TypeError(`Duplicate motion clip "${clip.id}"`);
    validateClip(clip);
    library.set(clip.id, clip);
  }
  return library;
}

function appendTrack<T extends MotionVector | MotionQuaternion>(
  tracks: Track<T>[],
  layer: MotionLayer,
  clip: SkeletalClip,
  keys: CurveKey<T>[],
) {
  if (!keys.length) return;
  if (layer.loop) {
    const first = keys[0]!.value;
    const end = keys.at(-1)!.value;
    const equivalent =
      first.length === 4 ? sameHemisphere(first, end as MotionQuaternion) : end;
    if (
      first.some(
        (value, index) => Math.abs(value - equivalent[index]!) > epsilon,
      )
    )
      throw new TypeError(
        `Looping motion layer "${layer.id}" requires matching first and last channel values`,
      );
  }
  tracks.push({ layer, duration: clip.duration, keys });
}

function weighted<T>(
  tracks: Track<T>[],
  frame: number,
  secondsPerFrame: number,
  baseline: T,
  neutral: T,
  label: string,
  blend: (a: T, b: T, t: number) => T,
  add: (base: T, delta: T) => T,
): T {
  const additive: { value: T; weight: number }[] = [];
  const replace: { value: T; weight: number }[] = [];
  let total = 0;
  for (const { layer, duration, keys } of tracks) {
    if (frame < layer.startFrame || frame > layer.endFrame) continue;
    const elapsed = (frame - layer.startFrame) * secondsPerFrame;
    const remaining = (layer.endFrame - frame) * secondsPerFrame;
    const weight =
      layer.weight *
      Math.min(
        layer.fadeIn ? ease(Math.min(1, elapsed / layer.fadeIn), 'ease') : 1,
        layer.fadeOut
          ? ease(Math.min(1, remaining / layer.fadeOut), 'ease')
          : 1,
      );
    if (weight <= epsilon) continue;
    const clock = elapsed * layer.speed;
    const time = layer.loop ? clock % duration : Math.min(duration, clock);
    const value = sampleCurve(keys, time, blend);
    if (layer.blend === 'additive') additive.push({ value, weight });
    else {
      replace.push({ value, weight });
      total += weight;
    }
  }
  if (total > 1 + epsilon)
    throw new TypeError(
      `Conflicting replacement motion on ${label} at frame ${frame}: combined weight exceeds 1. Add a crossfade or mask.`,
    );
  let amount = Math.max(0, 1 - total);
  let value = baseline;
  for (const next of replace) {
    amount += next.weight;
    value = blend(value, next.value, next.weight / amount);
  }
  for (const next of additive)
    value = add(value, blend(neutral, next.value, next.weight));
  return value;
}

function frameKeys<T, K extends { frame: number; interpolation: string }>(
  keys: K[],
  value: (key: K) => T,
): CurveKey<T>[] {
  return keys.map((key) => ({
    time: key.frame,
    interpolation: key.interpolation,
    value: value(key),
  }));
}
function rotations(
  keys: CurveKey<MotionVector>[],
): CurveKey<MotionQuaternion>[] {
  return keys.map((key) => ({ ...key, value: quaternion(key.value) }));
}
function sampledQuaternions(
  length: number,
  sample: (frame: number) => MotionQuaternion,
): MotionQuaternion[] {
  const output: MotionQuaternion[] = [];
  for (let frame = 0; frame < length; frame++)
    output.push(sameHemisphere(output.at(-1) ?? identity, sample(frame)));
  return output;
}

export function sampleCharacterMotion(
  character: PreparedCharacter,
  layers: readonly MotionLayer[],
  library: ReadonlyMap<string, SkeletalClip>,
  durationFrames: number,
  fps: Rational,
): SampledSkeletalMotion | undefined {
  const positions: Track<MotionVector>[] = [];
  const orientations: Track<MotionQuaternion>[] = [];
  const joints = new Map(
    character.bones.map((bone) => [bone.id, [] as Track<MotionQuaternion>[]]),
  );
  const secondsPerFrame = fps.denominator / fps.numerator;
  const ids = new Set<string>();
  for (const layer of [...layers].sort((a, b) => compareStrings(a.id, b.id))) {
    if (ids.has(layer.id))
      throw new TypeError(
        `Duplicate motion layer "${layer.id}" on "${character.id}"`,
      );
    ids.add(layer.id);
    if (
      layer.endFrame >= durationFrames ||
      layer.fadeIn + layer.fadeOut >
        (layer.endFrame - layer.startFrame) * secondsPerFrame + epsilon
    )
      throw new TypeError(
        `Motion layer "${layer.id}" exceeds the shot or has fades longer than its frame window`,
      );
    const clip =
      layer.source.kind === 'clip'
        ? library.get(layer.source.clipId)
        : primitiveClip(layer, character.rig);
    if (!clip)
      throw new TypeError(
        `Motion layer "${layer.id}" references an unknown clip`,
      );
    if (
      clip.rig.profile !== character.rig.profile ||
      clip.rig.version !== character.rig.version
    )
      throw new TypeError(
        `Motion layer "${layer.id}" requires ${clip.rig.profile} v${clip.rig.version}`,
      );
    if (layer.source.kind === 'primitive') validateClip(clip);
    const channels = new Set(clip.joints.map((track) => track.joint));
    if (clip.rootPosition.length || clip.rootRotation) channels.add('root');
    const mask = new Set(layer.mask ?? channels);
    if (
      layer.mask &&
      (mask.size !== layer.mask.length ||
        layer.mask.some((channel) => !channels.has(channel)))
    )
      throw new TypeError(
        `Motion layer "${layer.id}" has duplicate or unavailable mask channels`,
      );
    if (mask.has('root')) {
      appendTrack(positions, layer, clip, clip.rootPosition);
      appendTrack(
        orientations,
        layer,
        clip,
        rotations(clip.rootRotation ?? []),
      );
    }
    for (const track of clip.joints)
      if (mask.has(track.joint))
        appendTrack(
          joints.get(track.joint)!,
          layer,
          clip,
          rotations(track.keys),
        );
  }

  const authored = character.poses;
  const rootKeys = authored.root;
  const jointKeys = new Map(
    authored.joints.map((track) => [
      track.joint,
      rotations(frameKeys(track.keys, (key) => key.rotationDegrees)),
    ]),
  );
  const active = character.bones.filter(
    (bone) => jointKeys.has(bone.id) || joints.get(bone.id)!.length,
  );
  const channelCount =
    active.length +
    (rootKeys.length
      ? 3
      : Number(!!positions.length) + Number(!!orientations.length));
  if (!channelCount) return undefined;
  if (durationFrames * channelCount > 250_000)
    throw new TypeError(
      `Character "${character.id}" exceeds 250,000 motion samples; split the animation into shorter shots`,
    );
  const label = (channel: string) => `"${character.id}" channel "${channel}"`;
  const output: SampledSkeletalMotion = { joints: [] };
  const add = (a: MotionVector, b: MotionVector): MotionVector => [
    a[0] + b[0],
    a[1] + b[1],
    a[2] + b[2],
  ];
  const frames = (sample: (frame: number) => MotionVector) =>
    Array.from({ length: durationFrames }, (_, frame) => sample(frame));
  if (rootKeys.length) {
    const location = frameKeys(rootKeys, (key) => xyz(key.transform.position));
    const rotation = rotations(
      frameKeys(rootKeys, (key) => xyz(key.transform.rotationDegrees)),
    );
    const scale = frameKeys(rootKeys, (key) => key.transform.scale);
    output.rootPosition = frames((frame) =>
      sampleCurve(location, frame, mixVector),
    );
    output.rootRotation = sampledQuaternions(durationFrames, (frame) =>
      sampleCurve(rotation, frame, slerp),
    );
    output.rootScale = Array.from({ length: durationFrames }, (_, frame) =>
      sampleCurve(scale, frame, mix),
    );
  } else {
    if (positions.length)
      output.rootPosition = frames((frame) => {
        const value = add(
          xyz(character.transform.position),
          weighted(
            positions,
            frame,
            secondsPerFrame,
            zero,
            zero,
            label('root.position'),
            mixVector,
            add,
          ),
        );
        if (!value.every(Number.isFinite))
          throw new TypeError(
            `Non-finite trajectory on ${label('root.position')}`,
          );
        return value;
      });
    if (orientations.length) {
      const base = quaternion(xyz(character.transform.rotationDegrees));
      output.rootRotation = sampledQuaternions(durationFrames, (frame) =>
        multiply(
          base,
          weighted(
            orientations,
            frame,
            secondsPerFrame,
            identity,
            identity,
            label('root.rotation'),
            slerp,
            multiply,
          ),
        ),
      );
    }
  }
  for (const bone of active) {
    const keys = jointKeys.get(bone.id);
    output.joints.push({
      joint: bone.id,
      rotations: sampledQuaternions(durationFrames, (frame) => {
        const value = keys
          ? sampleCurve(keys, frame, slerp)
          : weighted(
              joints.get(bone.id)!,
              frame,
              secondsPerFrame,
              identity,
              identity,
              label(bone.id),
              slerp,
              multiply,
            );
        if (!withinLimits(value, bone.min, bone.max))
          throw new TypeError(
            `Motion exceeds joint limits on ${label(bone.id)} at frame ${frame}`,
          );
        return value;
      }),
    });
  }
  return output;
}
