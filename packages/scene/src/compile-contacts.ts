import {
  compareStrings,
  type CompiledSceneInstruction,
  type PreparedCharacter,
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
import { composeTransform } from './rigid-transforms.js';

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
) {
  const graph = scene.contactGraph;
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
      if (frame >= c.startFrame && frame <= c.endFrame)
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
  for (let frame = 0; frame < frames; frame++) {
    if (
      frame !== 0 &&
      !graph.contacts.some((c) => frame >= c.startFrame && frame <= c.endFrame)
    )
      continue;
    const result = solveContactFrame(
      graph,
      actors.map((c) => participant(c, frame)),
      frame,
    );
    if (!result.success) {
      const errors = result.contacts.filter((c) => !c.satisfied);
      throw new TypeError(
        `Contact graph unsatisfied at frame ${frame}: ${JSON.stringify(errors)}`,
      );
    }
    for (const [id, rotations] of result.rotations) {
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
    if (!joints.length) continue;
    const motion: SampledSkeletalMotion = {
      ...character.sampledMotion,
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
