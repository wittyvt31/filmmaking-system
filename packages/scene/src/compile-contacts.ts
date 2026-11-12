import {
  compareStrings,
  type CompiledSceneInstruction,
  type PreparedCharacter,
  type Rational,
  type MotionVector,
  type SampledSkeletalMotion,
  type ShotScene,
  type SpatialConstraint,
} from '@filmmaking/contracts';
import {
  scaleVector,
  sceneTransformPose,
  worldEntityTransforms,
} from './collision.js';
import { solveContactFrame, type ContactParticipant } from './contact-graph.js';
import { identity, sameHemisphere } from './motion-math.js';
import { composeTransform, inverseTransform } from './rigid-transforms.js';
import { compileReactions } from './compile-reactions.js';

/** Preserve the effector's entire inherited transform when another pass owns it. */
function lockEffector(
  character: PreparedCharacter,
  joint: string,
  locks: Set<string>,
) {
  for (let id: string | undefined = joint; id;) {
    locks.add(id);
    id = character.bones.find((bone) => bone.id === id)?.parent;
  }
}

export function compileContacts(
  scene: ShotScene,
  frames: number,
  characters: CompiledSceneInstruction['characters'],
  protectedConstraints: ReadonlyMap<string, readonly SpatialConstraint[]>,
  world: CompiledSceneInstruction['world'],
  physics: CompiledSceneInstruction['physics'],
  rate: Rational,
) {
  const graph = scene.contactGraph;
  if (scene.contactResponse && !graph?.contacts.length)
    throw new TypeError('Contact response requires a contact graph');
  if (!graph?.contacts.length) return;
  const ids = new Set(
    graph.contacts.flatMap(({ a, b }) => [a.entityId, b.entityId]),
  );
  const worldTransforms = worldEntityTransforms(world);
  const moving = new Set([
    ...scene.interactions.map(({ objectId }) => objectId),
    ...(physics?.bodies
      .filter(({ properties }) => properties.mode !== 'static')
      .map(({ entityId }) => entityId) ?? []),
  ]);
  const actors = [...ids].sort(compareStrings).map((id) => {
    const character = characters.find((c) => c.id === id);
    if (!character || !('bones' in character))
      throw new TypeError(`Contact graph requires a skeletal character: ${id}`);
    for (let parentId = character.parentId; parentId;) {
      if (moving.has(parentId))
        throw new TypeError(
          `Contact character ${id} cannot inherit an animated world body: ${parentId}`,
        );
      parentId = world?.entities.find((e) => e.id === parentId)?.parentId;
    }
    return character;
  });
  if (graph.contacts.some(({ endFrame }) => endFrame >= frames))
    throw new TypeError('Contact exceeds shot duration');
  if (frames * actors.reduce((n, c) => n + c.bones.length, 0) > 250_000)
    throw new TypeError(
      'Contact graph exceeds 250,000 potential joint samples',
    );

  const tracks = new Map(
    actors.map((c) => [
      c.id,
      new Map(
        c.sampledMotion?.joints.map((track) => [
          track.joint,
          [...track.rotations],
        ]),
      ),
    ]),
  );
  const participant = (
    character: PreparedCharacter,
    frame: number,
    allowFootAdjustment = false,
  ): ContactParticipant => {
    const base = character.sampledMotion;
    const root = sceneTransformPose(character.transform);
    root.position = base?.rootPosition?.[frame] ?? root.position;
    root.rotation = base?.rootRotation?.[frame] ?? root.rotation;
    const parent = character.parentId
      ? worldTransforms.get(character.parentId)
      : undefined;
    if (parent) root.position = scaleVector(root.position, parent.scale);
    const locks = new Set(character.poses.joints.map(({ joint }) => joint));
    for (const c of protectedConstraints.get(character.id) ?? [])
      if (
        frame >= c.startFrame &&
        frame <= c.endFrame &&
        !(allowFootAdjustment && c.id.startsWith('locomotion.'))
      )
        lockEffector(character, c.effector, locks);
    for (const interaction of scene.interactions)
      if (interaction.characterId === character.id)
        lockEffector(character, interaction.effector, locks);
    return {
      character,
      root: parent ? composeTransform(parent.pose, root) : root,
      scale:
        (base?.rootScale?.[frame] ?? character.transform.scale) *
        (parent?.scale ?? 1),
      rotations: new Map(
        base?.joints.map(({ joint, rotations }) => [joint, rotations[frame]!]),
      ),
      lockedJoints: locks,
    };
  };
  const solve = (base: ContactParticipant[], frame: number) => {
    const result = solveContactFrame(graph, base, frame);
    if (!result.success) {
      const errors = result.contacts.filter((c) => !c.satisfied);
      throw new TypeError(
        `Contact graph unsatisfied at frame ${frame}: ${JSON.stringify(errors)}`,
      );
    }
    return result.rotations;
  };
  const reactions =
    scene.contactResponse &&
    compileReactions(
      scene.contactResponse,
      graph,
      frames,
      rate,
      (frame) => actors.map((c) => participant(c, frame, true)),
      (frame) => {
        const base = actors.map((c) => participant(c, frame));
        const rotations = solve(base, frame);
        return base.map((p) => ({
          ...p,
          rotations: rotations.get(p.character.id)!,
        }));
      },
      protectedConstraints,
      new Set(scene.interactions.map((i) => i.characterId)),
    );
  const rootTracks = new Map<string, MotionVector[]>();
  for (let frame = 0; frame < frames; frame++) {
    const active = graph.contacts.some(
      (c) => frame >= c.startFrame && frame <= c.endFrame,
    );
    if (frame !== 0 && !active && !reactions) continue;
    const base = actors.map((c) => participant(c, frame));
    const poses = reactions ? reactions(frame, base) : base;
    for (const [i, p] of poses.entries()) {
      if (
        p.root === base[i]!.root ||
        p.root.position.every(
          (value, axis) => value === base[i]!.root.position[axis],
        )
      )
        continue;
      const c = p.character;
      const parent = c.parentId ? worldTransforms.get(c.parentId) : undefined;
      const position = parent
        ? scaleVector(
            composeTransform(inverseTransform(parent.pose), p.root).position,
            1 / parent.scale,
          )
        : p.root.position;
      if (!rootTracks.has(c.id)) {
        const fallback = sceneTransformPose(c.transform).position;
        rootTracks.set(
          c.id,
          c.sampledMotion?.rootPosition?.slice() ??
            Array.from({ length: frames }, () => fallback),
        );
      }
      rootTracks.get(c.id)![frame] = position;
    }
    const rotationsById =
      active || frame === 0
        ? solve(poses, frame)
        : new Map(poses.map((p) => [p.character.id, p.rotations]));
    for (const [id, rotations] of rotationsById) {
      const joints = tracks.get(id)!;
      for (const [joint, rotation] of rotations) {
        if (!joints.has(joint))
          joints.set(
            joint,
            Array.from({ length: frames }, () => identity),
          );
        joints.get(joint)![frame] = rotation;
      }
    }
  }
  for (const character of actors) {
    const joints = [...tracks.get(character.id)!].sort(([a], [b]) =>
      compareStrings(a, b),
    );
    const rootPosition = rootTracks.get(character.id);
    if (!joints.length && !rootPosition) continue;
    const motion: SampledSkeletalMotion = {
      ...character.sampledMotion,
      ...(rootPosition ? { rootPosition } : {}),
      joints: [],
    };
    for (const [joint, rotations] of joints) {
      for (let i = 1; i < rotations.length; i++)
        rotations[i] = sameHemisphere(rotations[i - 1]!, rotations[i]!);
      motion.joints.push({ joint, rotations });
    }
    character.sampledMotion = motion;
  }
}
