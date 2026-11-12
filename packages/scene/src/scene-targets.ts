import type {
  CameraTarget,
  CompiledSceneInstruction,
  MotionVector as V,
} from '@filmmaking/contracts';
import { add, scale } from './camera-math.js';
import {
  sceneTransformPose,
  transformPoint,
  worldCollisionProxies,
  worldEntityTransforms,
} from './collision.js';
import { composeTransform, rotateVector } from './rigid-transforms.js';
import { prepareKinematics } from './spatial-constraints.js';

export type TargetScene = Pick<
  CompiledSceneInstruction,
  'characters' | 'world' | 'physics' | 'props' | 'objectMotion'
>;
export function actorWorldPose(
  actor: TargetScene['characters'][number],
  frame: number,
  world: ReturnType<typeof worldEntityTransforms>,
) {
  const motion = 'bones' in actor ? actor.sampledMotion : undefined;
  let pose = sceneTransformPose(actor.transform);
  pose.position = motion?.rootPosition?.[frame] ?? pose.position;
  pose.rotation = motion?.rootRotation?.[frame] ?? pose.rotation;
  let size = motion?.rootScale?.[frame] ?? actor.transform.scale;
  const parentId = 'bones' in actor ? actor.parentId : undefined;
  const parent = parentId ? world.get(parentId) : undefined;
  if (parent) {
    pose = composeTransform(parent.pose, {
      ...pose,
      position: scale(pose.position, parent.scale),
    });
    size *= parent.scale;
  }
  return { pose, size };
}

export function resolveSceneTargets(scene: TargetScene) {
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
      throw new TypeError(
        'Tracking target requires a compiled transform: ' + id,
      );
    if (actor && !('bones' in actor) && actor.actions.length)
      throw new TypeError(
        'Tracking cannot follow runtime-only character actions: ' + id,
      );
    let pose;
    let size;
    if (actor) {
      const motion = 'bones' in actor ? actor.sampledMotion : undefined;
      ({ pose, size } = actorWorldPose(actor, frame, world));
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
            'Unknown tracking target joint ' + id + '/' + target.joint,
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
      if (!prop) throw new TypeError('Unknown tracking target entity ' + id);
      pose = sceneTransformPose(prop.transform);
      size = prop.transform.scale;
    }
    if (target.joint)
      throw new TypeError(
        'Joint tracking target requires a skeletal character: ' + id,
      );
    return transformPoint(
      objectTracks.get(id)?.[frame] ?? pose,
      scale(target.offset, size),
    );
  };
  return { point, staticProxies };
}
