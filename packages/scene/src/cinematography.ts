import {
  cameraFitsShot,
  compareStrings,
  type CameraRig,
  type CameraSample,
  type CameraTarget,
  type Cinematography,
  type CompiledCinematography,
  type CompiledSceneInstruction,
  type MotionQuaternion as Q,
  type MotionVector as V,
  type Rational,
} from '@filmmaking/contracts';
import {
  add,
  axisAngle,
  cameraLook,
  filmPlane,
  projectCameraPoint,
  scale,
  sub,
} from './camera-math.js';
import { proxyBlocksSegment } from './camera-visibility.js';
import {
  sceneTransformPose,
  transformPoint,
  worldCollisionProxies,
  worldEntityTransforms,
} from './collision.js';
import {
  ease,
  mix,
  mixVector,
  multiply,
  quaternion,
  sameHemisphere,
  sampleCurve,
  slerp,
} from './motion-math.js';
import { composeTransform, rotateVector } from './rigid-transforms.js';
import { prepareKinematics } from './spatial-constraints.js';

type Scene = Pick<
  CompiledSceneInstruction,
  'characters' | 'world' | 'physics' | 'props' | 'objectMotion'
>;
const toRadians = Math.PI / 180;

function targetResolver(scene: Scene) {
  const actors = new Map(scene.characters.map((c) => [c.id, c]));
  const props = new Map(scene.props.map((p) => [p.id, p]));
  const world = worldEntityTransforms(scene.world);
  const parents = new Map(scene.world?.entities.map((e) => [e.id, e.parentId]));
  const objectTracks = new Map(
    scene.objectMotion?.map((t) => [t.objectId, t.poses]),
  );
  const simulated = new Set(
    scene.physics?.bodies
      .filter((b) => b.properties.mode !== 'static' || b.transitions.length)
      .map((b) => b.entityId),
  );
  const inherits = (
    id: string | undefined,
    set: { has(id: string): boolean },
  ) => {
    for (; id; id = parents.get(id)) if (set.has(id)) return true;
    return false;
  };
  const staticProxies = worldCollisionProxies(scene.world).filter(
    (p) =>
      !inherits(p.entityId, simulated) && !inherits(p.entityId, objectTracks),
  );
  const kinematics = new Map(
    scene.characters.flatMap((c) =>
      'bones' in c ? [[c.id, prepareKinematics(c)] as const] : [],
    ),
  );
  let cachedFrame = -1;
  const bones = new Map<
    string,
    ReturnType<ReturnType<typeof prepareKinematics>>
  >();
  const point = (target: CameraTarget, frame: number): V => {
    if (target.kind === 'point') return target.position;
    if (frame !== cachedFrame) {
      cachedFrame = frame;
      bones.clear();
    }
    const id = target.entityId;
    const actor = actors.get(id);
    const parentId =
      actor && 'bones' in actor ? actor.parentId : parents.get(id);
    if (
      inherits(id, simulated) ||
      inherits(parentId, simulated) ||
      (parentId && inherits(parentId, objectTracks))
    )
      throw new TypeError('Camera target requires a compiled transform: ' + id);
    if (actor && !('bones' in actor) && actor.actions.length)
      throw new TypeError(
        'Camera cannot track runtime-only character actions: ' + id,
      );
    let pose;
    let size;
    if (actor) {
      const motion = 'bones' in actor ? actor.sampledMotion : undefined;
      pose = sceneTransformPose(actor.transform);
      pose.position = motion?.rootPosition?.[frame] ?? pose.position;
      pose.rotation = motion?.rootRotation?.[frame] ?? pose.rotation;
      size = motion?.rootScale?.[frame] ?? actor.transform.scale;
      const parent = parentId ? world.get(parentId) : undefined;
      if (parent) {
        pose = composeTransform(parent.pose, {
          ...pose,
          position: scale(pose.position, parent.scale),
        });
        size *= parent.scale;
      }
      if (target.joint && 'bones' in actor) {
        let frameBones = bones.get(id);
        if (!frameBones) {
          frameBones = kinematics.get(id)!(
            new Map(motion?.joints.map((t) => [t.joint, t.rotations[frame]!])),
          );
          bones.set(id, frameBones);
        }
        const bone = frameBones.get(target.joint);
        if (!bone)
          throw new TypeError(
            'Unknown camera target joint ' + id + '/' + target.joint,
          );
        return transformPoint(
          pose,
          scale(
            add(bone.head, rotateVector(bone.rotation, target.offset)),
            size,
          ),
        );
      }
    } else if (world.has(id)) {
      const entity = world.get(id)!;
      pose = entity.pose;
      size = entity.scale;
    } else {
      const prop = props.get(id);
      if (!prop) throw new TypeError('Unknown camera target entity ' + id);
      pose = sceneTransformPose(prop.transform);
      size = prop.transform.scale;
    }
    if (target.joint)
      throw new TypeError(
        'Camera joint target requires a skeletal character: ' + id,
      );
    return transformPoint(
      objectTracks.get(id)?.[frame] ?? pose,
      scale(target.offset, size),
    );
  };
  return { point, staticProxies };
}

function positionSampler(keys: CameraRig['position']) {
  let i = 0;
  return (frame: number): V => {
    while (keys[i + 1] && keys[i + 1]!.frame <= frame) i++;
    const a = keys[i]!,
      b = keys[i + 1];
    if (!b || frame <= a.frame) return a.value;
    const t = ease(
      (frame - a.frame) / (b.frame - a.frame),
      a.interpolation,
      a.easing,
    );
    if (!a.outControl && !b.inControl) return mixVector(a.value, b.value, t);
    const p1 = a.outControl ?? a.value,
      p2 = b.inControl ?? b.value;
    const u = 1 - t;
    return add(
      add(scale(a.value, u ** 3), scale(p1, 3 * u * u * t)),
      add(scale(p2, 3 * u * t * t), scale(b.value, t ** 3)),
    );
  };
}

function track<T>(
  keys: readonly {
    frame: number;
    value: T;
    interpolation: string;
    easing?: readonly number[] | undefined;
  }[],
) {
  return keys.map((k) => ({
    time: k.frame,
    value: k.value,
    interpolation: k.interpolation,
    bezier: k.easing,
  }));
}
const axisX: V = [1, 0, 0];
const axisY: V = [0, 1, 0];
const axisZ: V = [0, 0, 1];
function phase(seed: number, index: number) {
  let n = Math.imul(seed ^ Math.imul(index + 1, 0x9e3779b1), 0x85ebca6b);
  n = Math.imul(n ^ (n >>> 13), 0xc2b2ae35);
  return (((n ^ (n >>> 16)) >>> 0) / 2 ** 32) * Math.PI * 2;
}

export function compileCinematography(
  camera: Cinematography,
  scene: Scene,
  duration: number,
  rate: Rational,
  aspect: number,
): CompiledCinematography {
  if (!cameraFitsShot(camera, duration))
    throw new TypeError('Camera cuts and keys must fit the shot duration');
  if (
    !Number.isFinite(aspect) ||
    aspect <= 0 ||
    duration * camera.rigs.length > 250000
  )
    throw new TypeError(
      'Invalid camera aspect or camera sample budget exceeded',
    );
  const { point, staticProxies } = targetResolver(scene);
  const active: string[] = [];
  for (const cut of camera.cuts)
    for (let frame = cut.startFrame; frame < cut.endFrame; frame++)
      active.push(cut.cameraId);
  const rigs = [...camera.rigs]
    .sort((a, b) => compareStrings(a.id, b.id))
    .map((rig) => {
      const { focalLengthKeys, focalLength, focus, ...optics } = rig.optics;
      const focalTrack = focalLengthKeys ? track(focalLengthKeys) : undefined;
      const focusTrack =
        focus.kind === 'distance' && focus.keys ? track(focus.keys) : undefined;
      const rotations = rig.orientation ? track(rig.orientation) : undefined;
      const positionAt = positionSampler(rig.position);
      const plane = filmPlane(optics.sensor, aspect);
      const aim = rig.lookAt ?? rig.framing?.target;
      const behaviors = rig.behaviors.map((b) => ({
        b,
        keys: 'keys' in b ? track(b.keys) : undefined,
        origin: b.kind === 'tracking' ? point(b.target, 0) : undefined,
      }));
      const frames: CameraSample[] = [];
      for (let frame = 0; frame < duration; frame++) {
        try {
          const lens = focalTrack
            ? sampleCurve(focalTrack, frame, mix)
            : focalLength;
          let position = positionAt(frame);
          const target = aim ? point(aim, frame) : undefined;
          const authored = rotations
            ? sampleCurve(rotations, frame, slerp)
            : undefined;
          const framing = rig.framing;
          const ray: V = framing
            ? [
                ((framing.x - 0.5) * plane[0]) / lens,
                (((framing.headroom === undefined
                  ? (framing.y ?? 0.5)
                  : 1 - framing.headroom) -
                  0.5) *
                  plane[1]) /
                  lens,
                -1,
              ]
            : [0, 0, -1];
          const orientationAt = (p: V): Q =>
            authored ?? cameraLook(p, target!, ray);
          const offsets: Q[] = [];
          for (const { b, keys, origin } of behaviors) {
            const amount = keys ? sampleCurve(keys, frame, mix) : 0;
            if (b.kind === 'tracking')
              position = add(position, sub(point(b.target, frame), origin!));
            else if (b.kind === 'orbit') {
              const pivot = point(b.target, frame);
              position = add(
                pivot,
                rotateVector(
                  axisAngle(axisZ, amount * toRadians),
                  sub(position, pivot),
                ),
              );
            } else if (b.kind === 'dolly')
              position = add(
                position,
                rotateVector(orientationAt(position), [0, 0, -amount]),
              );
            else if (b.kind === 'crane')
              position = add(position, [0, 0, amount]);
            else if (b.kind === 'pan' || b.kind === 'tilt')
              offsets.push(
                axisAngle(b.kind === 'pan' ? axisY : axisX, amount * toRadians),
              );
            else if (b.kind === 'handheld') {
              const t =
                ((frame * rate.denominator) / rate.numerator) *
                b.frequencyHz *
                Math.PI *
                2;
              const wave = (i: number) =>
                Math.sin(t * (1 + i * 0.19) + phase(b.seed, i));
              position = add(
                position,
                rotateVector(orientationAt(position), [
                  wave(0) * b.positionAmplitude,
                  wave(1) * b.positionAmplitude,
                  wave(2) * b.positionAmplitude,
                ]),
              );
              offsets.push(
                quaternion([
                  wave(3) * b.rotationAmplitude,
                  wave(4) * b.rotationAmplitude,
                  wave(5) * b.rotationAmplitude,
                ]),
              );
            }
          }
          let orientation = offsets.reduce(multiply, orientationAt(position));
          if (frame)
            orientation = sameHemisphere(
              frames[frame - 1]!.orientation,
              orientation,
            );
          const sample: CameraSample = {
            position,
            orientation,
            focalLength: lens,
            focusDistance: focusTrack
              ? sampleCurve(focusTrack, frame, mix)
              : focus.kind === 'distance'
                ? focus.distance
                : 1,
          };
          const depthValid = (depth: number) =>
            depth >= optics.clipNear && depth <= optics.clipFar;
          if (focus.kind === 'target') {
            sample.focusDistance = projectCameraPoint(
              sample,
              point(focus.target, frame),
              plane,
            ).depth;
            if (!depthValid(sample.focusDistance))
              throw new TypeError('Focus target is outside the clip range');
          }
          if (active[frame] === rig.id) {
            if (framing && target) {
              const projected = projectCameraPoint(sample, target, plane);
              if (
                !depthValid(projected.depth) ||
                Math.abs(projected.x - (0.5 + (ray[0] * lens) / plane[0])) >
                  1e-6 ||
                Math.abs(projected.y - (0.5 + (ray[1] * lens) / plane[1])) >
                  1e-6
              )
                throw new TypeError(
                  'Framing conflicts with camera motion or clipping',
                );
            }
            for (const check of rig.visibility) {
              const subject = point(check.target, frame);
              const projected = projectCameraPoint(sample, subject, plane);
              const margin = check.margin - 1e-8;
              if (
                !depthValid(projected.depth) ||
                projected.x < margin ||
                projected.x > 1 - margin ||
                projected.y < margin ||
                projected.y > 1 - margin
              )
                throw new TypeError(
                  'Visibility target is outside the camera frame or clip range',
                );
              if (
                check.occlusion === 'proxies' &&
                staticProxies.some(
                  (proxy) =>
                    !(
                      check.target.kind === 'entity' &&
                      proxy.entityId === check.target.entityId
                    ) && proxyBlocksSegment(proxy, position, subject),
                )
              )
                throw new TypeError(
                  'Visibility target is occluded by a static world proxy',
                );
            }
          }
          frames.push(sample);
        } catch (error) {
          throw new TypeError(
            `Camera ${rig.id} at frame ${frame}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        }
      }
      return { id: rig.id, optics, frames };
    });
  return { aspect, rigs, cuts: camera.cuts };
}
