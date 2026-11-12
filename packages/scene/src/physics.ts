import {
  PhysicsSettingsSchema,
  RigidBodySchema,
  type CompiledWorld,
  type ObjectInteraction,
  type PhysicsSimulation,
} from '@filmmaking/contracts';
import { worldCollisionProxies, worldEntityTransforms } from './collision.js';
import {
  composeTransform,
  inverseTransform,
  angularDistance,
} from './rigid-transforms.js';

export function compilePhysics(
  world: CompiledWorld | undefined,
  interactions: readonly ObjectInteraction[],
  frames: number,
): PhysicsSimulation | undefined {
  if (
    !world ||
    (!world.physics &&
      !world.joints?.length &&
      !world.entities.some(
        ({ physics }) =>
          physics &&
          (physics.mode !== 'static' ||
            physics.transitions.length ||
            physics.keyframes.length ||
            physics.releaseOnInteraction),
      ))
  )
    return;
  const proxies = worldCollisionProxies(world);
  const grouped = new Map<string, typeof proxies>();
  for (const proxy of proxies) {
    const colliders = grouped.get(proxy.entityId) ?? [];
    colliders.push(proxy);
    grouped.set(proxy.entityId, colliders);
  }
  const transforms = worldEntityTransforms(world);
  const entities = new Map(world.entities.map((e) => [e.id, e]));
  const animated = new Set([
    ...interactions.map((i) => i.objectId),
    ...world.entities
      .filter((e) => e.physics && e.physics.mode !== 'static')
      .map((e) => e.id),
  ]);
  const bindings = new Map(interactions.map((i) => [i.objectId, i]));
  const bodies: PhysicsSimulation['bodies'] = [];
  for (const entity of world.entities) {
    const {
      mode,
      transitions,
      keyframes,
      releaseOnInteraction,
      followCharacter,
      ...properties
    } = entity.physics ?? RigidBodySchema.parse({});
    const binding = bindings.get(entity.id);
    const colliders = grouped.get(entity.id) ?? [];
    const fail = (message: string): never => {
      throw new TypeError(`Physics body ${entity.id}: ${message}`);
    };
    if (
      followCharacter &&
      (mode !== 'kinematic' ||
        binding ||
        keyframes.length ||
        releaseOnInteraction ||
        transitions.length > 1 ||
        transitions.some((t) => t.mode !== 'dynamic'))
    )
      fail(
        'character following requires exclusive kinematic ownership with at most one dynamic release',
      );
    if (!colliders.length) {
      if (
        mode !== 'static' ||
        transitions.length ||
        keyframes.length ||
        releaseOnInteraction
      )
        fail('requires collision geometry');
      continue;
    }
    if (mode !== 'static' && (entity.parentId || colliders.length !== 1))
      fail(
        'kinematic and dynamic bodies require a root entity with exactly one collider',
      );
    for (
      let parent = entity.parentId;
      parent;
      parent = entities.get(parent)?.parentId
    )
      if (animated.has(parent))
        fail('colliders cannot be parented to a moving entity');
    if (
      mode === 'static' &&
      (binding ||
        transitions.length ||
        keyframes.length ||
        releaseOnInteraction)
    )
      fail('static colliders cannot animate. Use kinematic mode');
    if (binding && (mode !== 'kinematic' || keyframes.length))
      fail('interactions require a kinematic body with no competing keyframes');
    const schedule = [...transitions];
    if (releaseOnInteraction) {
      const releases =
        binding?.actions.filter((a) => a.kind === 'release') ?? [];
      if (releases.length !== 1)
        fail('releaseOnInteraction requires exactly one release action');
      schedule.push({ frame: releases[0]!.endFrame + 1, mode: 'dynamic' });
    }
    schedule.sort((a, b) => a.frame - b.frame);
    const keys = [...keyframes].sort((a, b) => a.frame - b.frame);
    for (let i = 0; i < keys.length; i++)
      if (keys[i]!.frame >= frames || keys[i - 1]?.frame === keys[i]!.frame)
        fail('duplicate or out-of-shot keyframe');
    let previousMode: string = mode;
    for (let i = 0; i < schedule.length; i++) {
      const transition = schedule[i]!;
      if (
        transition.frame === 0 ||
        transition.frame >= frames ||
        schedule[i - 1]?.frame === transition.frame ||
        previousMode === transition.mode
      )
        fail('duplicate, redundant or out-of-shot mode transition');
      if (
        transition.mode === 'kinematic' &&
        !keys.some((key) => key.frame === transition.frame)
      )
        fail('animation takeover requires a keyframe on the transition frame');
      if (
        transition.mode === 'dynamic' &&
        binding?.actions.some((action) => action.endFrame >= transition.frame)
      )
        fail('interaction continues into a dynamic interval');
      previousMode = transition.mode;
    }
    const initialPose = transforms.get(entity.id)!.pose;
    const inverse = inverseTransform(initialPose);
    bodies.push({
      entityId: entity.id,
      initialPose,
      properties: { ...properties, mode },
      colliders: colliders.map((c) => ({
        ...c,
        pose: composeTransform(inverse, c.pose),
      })),
      transitions: schedule,
      keyframes: keys,
      ...(followCharacter ? { followCharacter } : {}),
    });
  }
  if (
    bodies.filter((b) => b.properties.mode !== 'static').length * frames >
    250_000
  )
    throw new TypeError('Physics simulation exceeds the motion sample budget');
  const bodyById = new Map(bodies.map((body) => [body.entityId, body]));
  const jointIds = new Set<string>();
  for (const joint of world.joints ?? []) {
    const a = bodyById.get(joint.bodyA);
    const b = bodyById.get(joint.bodyB);
    const label = 'Physics joint ' + joint.id + ': ';
    if (jointIds.has(joint.id))
      throw new TypeError(label + 'duplicate joint ID');
    jointIds.add(joint.id);
    if (!a || !b || a.colliders.length !== 1 || b.colliders.length !== 1)
      throw new TypeError(
        label + 'each endpoint requires exactly one collision proxy',
      );
    if (a.properties.mode === 'static' && b.properties.mode === 'static')
      throw new TypeError(label + 'requires at least one moving body');
    if (joint.motorKeys.some(({ frame }) => frame >= frames))
      throw new TypeError(label + 'motor key is outside the shot');
    if (joint.minimum > 0 || joint.maximum < 0)
      throw new TypeError(
        label + 'limits must include the bind coordinate zero',
      );
    const bind = (body: typeof a, anchor: typeof joint.anchorA) =>
      composeTransform(
        body.keyframes[0]?.frame === 0
          ? body.keyframes[0].pose
          : body.initialPose,
        anchor,
      );
    const left = bind(a, joint.anchorA);
    const right = bind(b, joint.anchorB);
    if (
      Math.hypot(...left.position.map((v, i) => v - right.position[i]!)) >
        1e-5 ||
      angularDistance(left.rotation, right.rotation) > 1e-5
    )
      throw new TypeError(
        label + 'anchors must share a world pose at bind time',
      );
  }
  return {
    ...(world.joints?.length ? { joints: world.joints } : {}),
    version: 1,
    settings: world.physics ?? PhysicsSettingsSchema.parse({}),
    bodies,
  };
}
