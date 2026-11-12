import type { PhysicsSimulation } from '@filmmaking/contracts';
import { worldEntityTransforms } from './collision.js';
import { actorWorldPose, type TargetScene } from './scene-targets.js';
import { prepareKinematics } from './spatial-constraints.js';
import { angularDistance, composeTransform } from './rigid-transforms.js';
import { scale } from './camera-math.js';

export function bakeCharacterFollowers(
  simulation: PhysicsSimulation,
  scene: TargetScene,
  frames: number,
) {
  const world = worldEntityTransforms(scene.world);
  const moving = new Set(
    simulation.bodies
      .filter((b) => b.properties.mode !== 'static')
      .map((b) => b.entityId),
  );
  for (const body of simulation.bodies) {
    const binding = body.followCharacter;
    if (!binding) continue;
    const actor = scene.characters.find(({ id }) => id === binding.characterId);
    if (!actor || !('bones' in actor))
      throw new TypeError(
        'Physics follower requires a skeletal character: ' +
          binding.characterId,
      );
    for (
      let id = actor.parentId;
      id;
      id = scene.world?.entities.find((entity) => entity.id === id)?.parentId
    )
      if (moving.has(id))
        throw new TypeError(
          'Physics follower cannot depend on simulated parent ' + id,
        );
    const evaluate = prepareKinematics(actor);
    const release = body.transitions[0]?.frame ?? frames;
    body.keyframes = Array.from({ length: release }, (_, frame) => {
      const root = actorWorldPose(actor, frame, world);
      let anchor = root.pose;
      if (binding.joint) {
        const sampled = actor.sampledMotion?.joints ?? [];
        const bone = evaluate(
          new Map(
            sampled.map((track) => [track.joint, track.rotations[frame]!]),
          ),
        ).get(binding.joint);
        if (!bone)
          throw new TypeError(
            'Unknown physics follower joint: ' + binding.joint,
          );
        anchor = composeTransform(anchor, {
          position: scale(bone.head, root.size),
          rotation: bone.rotation,
        });
      }
      return {
        frame,
        pose: composeTransform(anchor, {
          ...binding.offset,
          position: scale(binding.offset.position, root.size),
        }),
      };
    });
    const start = body.keyframes[0]!.pose;
    if (
      Math.hypot(
        ...start.position.map((v, i) => v - body.initialPose.position[i]!),
      ) > 1e-5 ||
      angularDistance(start.rotation, body.initialPose.rotation) > 1e-5
    )
      throw new TypeError(
        'Physics follower frame zero must match the world bind pose: ' +
          body.entityId,
      );
  }
}
