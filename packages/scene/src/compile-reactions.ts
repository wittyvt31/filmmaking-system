import type {
  MotionVector,
  Rational,
  ShotScene,
  SpatialConstraint,
} from '@filmmaking/contracts';
import { createContactResponseEvaluator } from './contact-response.js';
import type { ContactParticipant } from './contact-graph.js';
import { scaleVector } from './collision.js';
import { identity, mixVector, sampleCurve } from './motion-math.js';
import { constrainMotion, forwardKinematics } from './spatial-constraints.js';
import { angularDistance, composeTransform } from './rigid-transforms.js';

export function compileReactions(
  settings: NonNullable<ShotScene['contactResponse']>,
  graph: NonNullable<ShotScene['contactGraph']>,
  frames: number,
  rate: Rational,
  sample: (frame: number) => ContactParticipant[],
  sampleImpact: (frame: number) => ContactParticipant[],
  constraints: ReadonlyMap<string, readonly SpatialConstraint[]>,
  objectOwners: ReadonlySet<string>,
) {
  const ids = new Set(sample(0).map((p) => p.character.id));
  const configured = new Set(settings.characters.map((c) => c.entityId));
  const authored = new Map(
    settings.authored.map((track) => [
      track.entityId,
      track.keys.map((key) => ({
        time: key.frame,
        value: key.offset,
        interpolation: 'ease-in-out',
      })),
    ]),
  );
  if (authored.size !== settings.authored.length)
    throw new TypeError('Duplicate authored contact reaction');
  if (!settings.loads.length && !authored.size)
    throw new TypeError('Contact response needs a load or authored reaction');
  for (const id of configured)
    if (!ids.has(id))
      throw new TypeError('Unknown contact response character ' + id);
  for (const [id, keys] of authored) {
    if (
      !configured.has(id) ||
      keys.some(
        (key, i) =>
          key.time >= frames || (i > 0 && key.time <= keys[i - 1]!.time),
      )
    )
      throw new TypeError('Invalid authored contact reaction for ' + id);
  }
  const evaluate = createContactResponseEvaluator(
    {
      version: 1,
      characters: settings.characters,
      loads: settings.loads.map(({ contactId, impactFrame, ...load }) => {
        const contact = graph.contacts.find((c) => c.id === contactId);
        if (!contact)
          throw new TypeError('Unknown response contact ' + contactId);
        const startFrame =
          impactFrame ?? contact.startFrame + contact.blendInFrames;
        if (startFrame < contact.startFrame || startFrame > contact.endFrame)
          throw new TypeError('Impact frame is outside contact ' + contactId);
        return {
          ...load,
          contact: {
            ...contact,
            startFrame,
            blendInFrames: 0,
            blendOutFrames: 0,
          },
        };
      }),
    },
    rate,
    sample,
    sampleImpact,
  );

  return (frame: number, base: ContactParticipant[]): ContactParticipant[] => {
    const reactions = new Map(evaluate(frame).map((r) => [r.entityId, r]));
    const hardLocks = new Map(
      sample(frame).map((p) => [p.character.id, p.lockedJoints]),
    );
    return base.map((p) => {
      const id = p.character.id;
      const reaction = reactions.get(id);
      if (!reaction) return p;
      const active =
        constraints
          .get(id)
          ?.filter((c) => frame >= c.startFrame && frame <= c.endFrame) ?? [];
      const feet = active.filter((c) => c.id.startsWith('locomotion.'));
      const previous = frame
        ? p.character.sampledMotion?.rootPosition?.[frame - 1]
        : undefined;
      const current = p.character.sampledMotion?.rootPosition?.[frame];
      const heading = p.character.sampledMotion?.rootRotation;
      const moving =
        feet.some((c) => c.startFrame === c.endFrame) ||
        (feet.length > 0 &&
          heading &&
          frame > 0 &&
          angularDistance(heading[frame - 1]!, heading[frame]!) > 1e-5) ||
        (previous &&
          current &&
          Math.hypot(...current.map((v, i) => v - previous[i]!)) > 1e-5);
      const allowRoot =
        !settings.characters.find((c) => c.entityId === id)!.rootLocked &&
        !p.character.poses.root.length &&
        !moving &&
        !objectOwners.has(id) &&
        active.every(
          (c) =>
            c.id.startsWith('locomotion.') || c.space === 'character-local',
        );
      const keys = authored.get(id);
      const authoredOffset =
        keys && frame >= keys[0]!.time && frame <= keys.at(-1)!.time
          ? sampleCurve(keys, frame, mixVector)
          : undefined;
      if (!allowRoot && authoredOffset && Math.hypot(...authoredOffset) > 0)
        throw new TypeError(
          `Authored reaction conflicts with root motion or contact ownership on ${id} at frame ${frame}`,
        );
      const offset = authoredOffset ?? reaction.displacement;
      const root = allowRoot
        ? {
            ...p.root,
            position: p.root.position.map(
              (v, i) => v + offset[i]!,
            ) as MotionVector,
          }
        : p.root;
      const rotations = new Map(reaction.rotations);
      // Prior passes own authored, interaction and locomotion joints. A stagger
      // only replaces the selected stationary foot goal while the other stays planted.
      for (const joint of p.lockedJoints) {
        const rotation = p.rotations.get(joint);
        if (rotation) rotations.set(joint, rotation);
        else rotations.delete(joint);
      }
      const step =
        allowRoot && !authoredOffset ? reaction.staggerFoot : undefined;
      if (
        (feet.length && root !== p.root && Math.hypot(...offset) > 1e-9) ||
        step
      ) {
        const baseFeet = forwardKinematics(p.character, p.rotations);
        const goals = feet.map((c) => {
          const bone = baseFeet.get(c.effector)!;
          const foot = composeTransform(p.root, {
            position: scaleVector(bone.tail, p.scale),
            rotation: bone.rotation,
          });
          return {
            ...c,
            startFrame: 0,
            endFrame: 0,
            fadeFrames: 0,
            target:
              step?.effector === c.effector ? step.position : foot.position,
            orientation: foot.rotation,
          };
        });
        if (step && !feet.some((c) => c.effector === step.effector)) {
          goals.push({
            id: 'reaction.stagger',
            effector: step.effector,
            chainRoot: step.chainRoot,
            startFrame: 0,
            endFrame: 0,
            fadeFrames: 0,
            space: 'world',
            target: step.position,
            orientation: composeTransform(p.root, {
              position: [0, 0, 0],
              rotation: baseFeet.get(step.effector)!.rotation,
            }).rotation,
            tolerance: 0.007,
            angularTolerance: 0.045,
            priority: 90,
          });
        }
        // Preserve explicitly locked joints. Existing locomotion keys are the IK seed.
        const character = {
          ...p.character,
          poses: {
            ...p.character.poses,
            joints: [...hardLocks.get(id)!].map((joint) => ({
              joint,
              keys: [],
            })),
          },
        };
        delete character.parentId;
        const result = constrainMotion(
          character,
          {
            rootPosition: [root.position],
            rootRotation: [root.rotation],
            rootScale: [p.scale],
            joints: p.character.bones.map((b) => ({
              joint: b.id,
              rotations: [rotations.get(b.id) ?? identity],
            })),
          },
          goals,
          1,
          undefined,
          undefined,
          new Set(feet.map((c) => c.id)),
        )!;
        for (const track of result.joints)
          rotations.set(track.joint, track.rotations[0]!);
      }
      return { ...p, root, rotations };
    });
  };
}
