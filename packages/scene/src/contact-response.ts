import {
  ContactResponseRequestSchema,
  compareStrings,
  type MotionVector,
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
import { identity, multiply, quaternion, withinLimits } from './motion-math.js';

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
  const w = 2 * Math.PI * frequency;
  const impulse = (t: number) => (t < 0 ? 0 : t * Math.exp(-w * t));
  const step = (t: number) =>
    t < 0 ? 0 : (1 - (1 + w * t) * Math.exp(-w * t)) / (w * w);
  return { impulse: impulse(time), force: step(time) - step(time - duration) };
}

export interface ReactionPose {
  entityId: string;
  root: RigidTransform;
  rotations: Map<string, import('@filmmaking/contracts').MotionQuaternion>;
  displacement: MotionVector;
  stepTarget?: MotionVector;
  constrained: string[];
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
  return (frame: number): ReactionPose[] => {
    if (!Number.isSafeInteger(frame) || frame < 0)
      throw new TypeError('Invalid response frame');
    const sampled = sampleAuthored(frame);
    solveContactFrame({ version: 1, contacts: [] }, sampled, frame);
    return [...request.characters]
      .sort((a, b) => compareStrings(a.entityId, b.entityId))
      .map((settings) => {
        const p = sampled.find((c) => c.character.id === settings.entityId);
        if (!p)
          throw new TypeError(
            'Missing response participant ' + settings.entityId,
          );
        let displacement = zero();
        const angles = new Map(settings.joints.map((j) => [j.joint, zero()]));
        for (const { load, sides } of events) {
          const gain = response(
            (frame - load.contact.startFrame) * seconds,
            load.durationSeconds,
            settings.recoveryFrequencyHz,
          );
          const magnitude =
            gain.impulse * load.impulseNewtonSeconds +
            gain.force * load.forceNewtons;
          for (const side of sides.filter(
            (s) => s.entityId === settings.entityId,
          )) {
            displacement = add(
              displacement,
              scale(side.direction, magnitude / settings.massKg),
            );
            for (const { joint, torque } of side.torques) {
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
        }
        const constrained: string[] = [];
        if (Math.hypot(...displacement) > settings.maxDisplacementMeters)
          constrained.push('displacement-limit');
        displacement = bounded(displacement, settings.maxDisplacementMeters);
        if (settings.rootLocked) {
          if (Math.hypot(...displacement) > 0)
            constrained.push('authored-root');
          displacement = zero();
        }
        const rotations = new Map(p.rotations);
        for (const setting of settings.joints) {
          const bone = p.character.bones.find((b) => b.id === setting.joint);
          if (!bone)
            throw new TypeError('Unknown response joint ' + setting.joint);
          if (p.lockedJoints.has(setting.joint)) {
            constrained.push('authored-joint:' + setting.joint);
            continue;
          }
          const base = rotations.get(setting.joint) ?? identity;
          const angle = bounded(
            angles.get(setting.joint)!,
            setting.maxRecoilDegrees,
          );
          let weight = 1;
          while (
            weight > 1e-6 &&
            !withinLimits(
              multiply(base, quaternion(scale(angle, weight))),
              bone.min,
              bone.max,
            )
          )
            weight /= 2;
          if (weight < 1) constrained.push('joint-limit:' + setting.joint);
          rotations.set(
            setting.joint,
            multiply(
              base,
              quaternion(scale(angle, weight > 1e-6 ? weight : 0)),
            ),
          );
        }
        const root = {
          ...p.root,
          position: add(p.root.position, displacement),
        };
        const horizontal = Math.hypot(displacement[0], displacement[1]);
        return {
          entityId: settings.entityId,
          root,
          rotations,
          displacement,
          constrained,
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
