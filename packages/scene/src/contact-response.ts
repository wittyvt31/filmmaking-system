import {
  ContactResponseRequestSchema,
  compareStrings,
  type MotionQuaternion,
  type MotionVector,
  type ContactResponseRequest,
  type Rational,
  type RigidTransform,
} from '@filmmaking/contracts';
import { solveContactFrame, type ContactParticipant } from './contact-graph.js';
import { forwardKinematics } from './spatial-constraints.js';
import {
  composeTransform,
  conjugate,
  rotateVector,
} from './rigid-transforms.js';
import {
  ease,
  identity,
  mixVector,
  multiply,
  withinLimits,
} from './motion-math.js';

const zero = (): MotionVector => [0, 0, 0];
const add = (a: MotionVector, b: MotionVector): MotionVector =>
  a.map((v, i) => v + b[i]!) as MotionVector;
const scale = (a: MotionVector, s: number): MotionVector =>
  a.map((v) => v * s) as MotionVector;
const sub = (a: MotionVector, b: MotionVector) => add(a, scale(b, -1));
const cross = (a: MotionVector, b: MotionVector): MotionVector => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const bounded = (v: MotionVector, limit: number) =>
  scale(v, Math.min(1, limit / (Math.hypot(...v) || 1)));

/** Closed-form critically damped response: x'' + 2w x' + w² x = load/mass.
 * This reduced-order compliant model supplies kinematic reactions and step requests.
 * It does not simulate articulated rigid-body dynamics or generate foot trajectories.
 */
function response(time: number, duration: number, frequency: number) {
  if (time <= 0) return { impulse: 0, force: 0 };
  const w = 2 * Math.PI * frequency;
  const active = Math.min(time, duration);
  const elapsed = time - active;
  const x = w * active;
  const step =
    x < 1e-3
      ? active ** 2 * (0.5 - x / 3 + x ** 2 / 8)
      : (-Math.expm1(-x) - x * Math.exp(-x)) / w ** 2;
  return {
    impulse: time * Math.exp(-w * time),
    force:
      Math.exp(-w * elapsed) *
      (step - elapsed * active * (Math.expm1(-x) / x || -1)),
  };
}

function rotationVector(
  degrees: MotionVector,
  weight: number,
): MotionQuaternion {
  const length = Math.hypot(...degrees);
  if (!length) return identity;
  const half = (length * weight * Math.PI) / 360;
  const [x, y, z] = scale(degrees, Math.sin(half) / length);
  return [Math.cos(half), x, y, z];
}

export interface StaggerFootGoal {
  effector: string;
  chainRoot: string;
  /** World-space target for the effector tail, in metres. */
  position: MotionVector;
  phase: 'swing' | 'plant' | 'recover';
}

export interface ReactionPose {
  entityId: string;
  root: RigidTransform;
  rotations: Map<string, MotionQuaternion>;
  displacement: MotionVector;
  stepTarget?: MotionVector;
  staggerFoot?: StaggerFootGoal;
  constrained: string[];
}

type Load = ContactResponseRequest['loads'][number];
type Settings = ContactResponseRequest['characters'][number];

function loadMagnitude(load: Load, time: number, settings: Settings) {
  const gain = response(
    time,
    load.durationSeconds,
    settings.recoveryFrequencyHz,
  );
  return (
    gain.impulse * load.impulseNewtonSeconds + gain.force * load.forceNewtons
  );
}

/** A single rectangular force plus impulse has one positive response peak. */
function peakTime(load: Load, frequency: number) {
  const w = 2 * Math.PI * frequency;
  const impulse = load.impulseNewtonSeconds;
  const force = load.forceNewtons;
  const duration = load.durationSeconds;
  const slope = force - w * impulse;
  if (slope < 0 && -impulse / slope <= duration) return -impulse / slope;
  const decay = Math.exp(-w * duration);
  return (
    duration +
    (decay * (impulse + slope * duration)) /
      (force * -Math.expm1(-w * duration) + decay * w * impulse)
  );
}

function footPosition(p: ContactParticipant, effector: string): MotionVector {
  const bone = forwardKinematics(p.character, p.rotations).get(effector);
  if (!bone) throw new TypeError('Unknown stagger effector ' + effector);
  return add(
    p.root.position,
    rotateVector(p.root.rotation, scale(bone.tail, p.scale)),
  );
}

function footChain(p: ContactParticipant, effector: string, root: string) {
  const chain: string[] = [];
  for (let id: string | undefined = effector; id;) {
    const bone = p.character.bones.find((b) => b.id === id);
    if (!bone || chain.includes(id)) break;
    chain.push(id);
    if (id === root) return chain;
    id = bone.parent;
  }
  throw new TypeError(`Invalid stagger chain ${effector} -> ${root}`);
}

/** sampleAuthored must be pure and return resolved world roots at integer frames.
 * Contact geometry is captured at activation. Each frame is independently evaluated,
 * so seeking and chunking cannot change the response or accumulate integration drift.
 */
export function createContactResponseEvaluator(
  input: unknown,
  rate: Rational,
  sampleAuthored: (frame: number) => readonly ContactParticipant[],
) {
  const request = ContactResponseRequestSchema.parse(input);
  if (
    !Number.isSafeInteger(rate.numerator) ||
    !Number.isSafeInteger(rate.denominator) ||
    rate.numerator <= 0 ||
    rate.denominator <= 0
  )
    throw new TypeError('Invalid response frame rate');
  const seconds = rate.denominator / rate.numerator;
  const events = [...request.loads]
    .sort((a, b) => compareStrings(a.contact.id, b.contact.id))
    .map((load) => {
      if (
        load.durationSeconds >
        (load.contact.endFrame - load.contact.startFrame + 1) * seconds + 1e-9
      )
        throw new TypeError(
          'Contact force duration exceeds its active interval',
        );
      const sampled = sampleAuthored(load.contact.startFrame);
      // Validate rigs, chains and roots through the shared solver without moving the authored poses.
      solveContactFrame(
        { version: 1, contacts: [load.contact] },
        sampled,
        load.contact.endFrame + 1,
      );
      const sides = [load.contact.a, load.contact.b].map((endpoint, index) => {
        const p = sampled.find((c) => c.character.id === endpoint.entityId)!;
        const fk = forwardKinematics(p.character, p.rotations);
        const bone = fk.get(endpoint.boneId)!;
        const local = composeTransform(
          { position: bone.tail, rotation: bone.rotation },
          endpoint.anchor,
        );
        const point = composeTransform(p.root, {
          ...local,
          position: scale(local.position, p.scale),
        }).position;
        const direction = scale(load.direction, index === 0 ? -1 : 1);
        const settings = request.characters.find(
          (c) => c.entityId === endpoint.entityId,
        )!;
        const torques = settings.joints.map((j) => {
          const joint = fk.get(j.joint);
          if (!joint) throw new TypeError('Unknown response joint ' + j.joint);
          let ancestor: string | undefined = endpoint.boneId;
          while (ancestor && ancestor !== j.joint)
            ancestor = p.character.bones.find((b) => b.id === ancestor)?.parent;
          if (!ancestor) return { joint: j.joint, torque: zero() };
          const pivot = add(
            p.root.position,
            rotateVector(p.root.rotation, scale(joint.head, p.scale)),
          );
          const orientation = multiply(p.root.rotation, joint.rotation);
          return {
            joint: j.joint,
            torque: rotateVector(
              conjugate(orientation),
              cross(sub(point, pivot), direction),
            ),
          };
        });
        return { entityId: endpoint.entityId, point, direction, torques };
      });
      if (
        Math.hypot(...sub(sides[0]!.point, sides[1]!.point)) >
        load.contact.positionTolerance
      )
        throw new TypeError('Impact anchors are separated: ' + load.contact.id);
      return { load, sides };
    });
  const actors = [...request.characters]
    .sort((a, b) => compareStrings(a.entityId, b.entityId))
    .map((settings) => {
      const loads = events.flatMap(({ load, sides }) =>
        sides
          .filter((side) => side.entityId === settings.entityId)
          .map((side) => ({ load, ...side })),
      );
      const displacementAt = (frame: number) =>
        loads.reduce(
          (sum, item) =>
            add(
              sum,
              scale(
                item.direction,
                loadMagnitude(
                  item.load,
                  (frame - item.load.contact.startFrame) * seconds,
                  settings,
                ) / settings.massKg,
              ),
            ),
          zero(),
        );
      const steps: { start: number; end: number; offset: MotionVector }[] = [];
      const stagger = settings.stagger;
      if (stagger && !settings.rootLocked) {
        // Use the peaks of the authored loads as candidates and evaluate their combined
        // displacement there. A foot completes its current step before taking another.
        const candidates = [
          ...new Set(
            loads
              .filter(
                ({ load }) =>
                  load.forceNewtons > 0 || load.impulseNewtonSeconds > 0,
              )
              .map(
                ({ load }) =>
                  load.contact.startFrame +
                  Math.ceil(
                    peakTime(load, settings.recoveryFrequencyHz) / seconds,
                  ),
              ),
          ),
        ]
          .filter(Number.isSafeInteger)
          .sort((a, b) => a - b);
        for (const start of candidates) {
          if (start < (steps.at(-1)?.end ?? 0)) continue;
          const offset = bounded(
            displacementAt(start),
            settings.maxDisplacementMeters,
          );
          offset[2] = 0;
          if (Math.hypot(...offset) <= settings.supportRadiusMeters) continue;
          const end =
            start + (2 * stagger.swingSeconds + stagger.holdSeconds) / seconds;
          steps.push({ start, end, offset });
        }
      }
      return { settings, loads, displacementAt, steps };
    });
  return (frame: number): ReactionPose[] => {
    if (!Number.isSafeInteger(frame) || frame < 0)
      throw new TypeError('Invalid response frame');
    const sampled = sampleAuthored(frame);
    solveContactFrame({ version: 1, contacts: [] }, sampled, frame);
    return actors.map(({ settings, loads, displacementAt, steps }) => {
      const p = sampled.find((c) => c.character.id === settings.entityId);
      if (!p)
        throw new TypeError(
          'Missing response participant ' + settings.entityId,
        );
      let displacement = displacementAt(frame);
      const angles = new Map(settings.joints.map((j) => [j.joint, zero()]));
      for (const { load, torques } of loads) {
        const magnitude = loadMagnitude(
          load,
          (frame - load.contact.startFrame) * seconds,
          settings,
        );
        if (!magnitude) continue;
        for (const { joint, torque } of torques) {
          const inertia = settings.joints.find(
            (j) => j.joint === joint,
          )!.inertiaKgMetersSquared;
          angles.set(
            joint,
            add(
              angles.get(joint)!,
              scale(torque, ((magnitude / inertia) * 180) / Math.PI),
            ),
          );
        }
      }
      const constrained: string[] = [];
      if (Math.hypot(...displacement) > settings.maxDisplacementMeters)
        constrained.push('displacement-limit');
      displacement = bounded(displacement, settings.maxDisplacementMeters);
      if (settings.rootLocked) {
        if (Math.hypot(...displacement) > 0) constrained.push('authored-root');
        displacement = zero();
      }
      const rotations = new Map(p.rotations);
      for (const setting of settings.joints) {
        const bone = p.character.bones.find((b) => b.id === setting.joint);
        if (!bone)
          throw new TypeError('Unknown response joint ' + setting.joint);
        const desired = angles.get(setting.joint)!;
        if (!Math.hypot(...desired)) continue;
        if (p.lockedJoints.has(setting.joint)) {
          constrained.push('authored-joint:' + setting.joint);
          continue;
        }
        const base = rotations.get(setting.joint) ?? identity;
        const angle = bounded(desired, setting.maxRecoilDegrees);
        let weight = 1;
        while (
          weight > 1e-6 &&
          !withinLimits(
            multiply(base, rotationVector(angle, weight)),
            bone.min,
            bone.max,
          )
        )
          weight /= 2;
        if (weight < 1) constrained.push('joint-limit:' + setting.joint);
        rotations.set(
          setting.joint,
          multiply(base, rotationVector(angle, weight > 1e-6 ? weight : 0)),
        );
      }
      const root = {
        ...p.root,
        position: add(p.root.position, displacement),
      };
      const horizontal = Math.hypot(displacement[0], displacement[1]);
      let staggerFoot: StaggerFootGoal | undefined;
      const stagger = settings.stagger;
      const step = steps.find((s) => frame >= s.start && frame < s.end);
      if (stagger && step) {
        const chain = footChain(p, stagger.effector, stagger.chainRoot);
        if (chain.some((id) => p.lockedJoints.has(id)))
          constrained.push('authored-stagger-chain');
        else {
          const startPose =
            frame === step.start
              ? p
              : sampleAuthored(step.start).find(
                  (p) => p.character.id === settings.entityId,
                );
          if (!startPose)
            throw new TypeError(
              'Missing stagger start pose for ' + settings.entityId,
            );
          const from = footPosition(startPose, stagger.effector);
          const plant = add(from, step.offset);
          const elapsed = (frame - step.start) * seconds;
          const recoveryStart = stagger.swingSeconds + stagger.holdSeconds;
          const phase =
            elapsed < stagger.swingSeconds
              ? 'swing'
              : elapsed < recoveryStart
                ? 'plant'
                : 'recover';
          const progress =
            phase === 'swing'
              ? elapsed / stagger.swingSeconds
              : phase === 'recover'
                ? Math.min(1, (elapsed - recoveryStart) / stagger.swingSeconds)
                : 0;
          const eased = ease(progress, 'ease-in-out');
          const position =
            phase === 'swing'
              ? mixVector(from, plant, eased)
              : phase === 'recover'
                ? mixVector(plant, footPosition(p, stagger.effector), eased)
                : plant;
          position[2] +=
            16 * progress ** 2 * (1 - progress) ** 2 * stagger.clearanceMeters;
          staggerFoot = {
            effector: stagger.effector,
            chainRoot: stagger.chainRoot,
            position,
            phase,
          };
        }
      }
      return {
        entityId: settings.entityId,
        root,
        rotations,
        displacement,
        constrained,
        ...(staggerFoot ? { staggerFoot } : {}),
        ...(horizontal > settings.supportRadiusMeters
          ? {
              stepTarget: [
                root.position[0],
                root.position[1],
                p.root.position[2],
              ] as MotionVector,
            }
          : {}),
      };
    });
  };
}
