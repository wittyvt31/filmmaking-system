import {
  SpatialConstraintSchema,
  type CompiledSceneInstruction,
  type ObjectInteraction,
  type RigidTransform,
  type Shot,
} from '@filmmaking/contracts';
import {
  advanceInteraction,
  createInteractionState,
  planInteractionFrame,
  prepareInteractions,
  type InteractionState,
  type InteractionStep,
} from './interactions.js';
import { quaternion } from './motion-math.js';
import { composeTransform, inverseTransform } from './rigid-transforms.js';

export function compileInteractions(
  scene: NonNullable<Shot['scene']>,
  frames: number,
) {
  const drivers = new Map<string, ReturnType<typeof createDriver>>();
  const objectIds = new Set<string>();
  const ids = new Set<string>();
  if (scene.interactions.length * frames > 250_000)
    throw new TypeError('Object interactions exceed 250,000 samples');
  for (const interaction of scene.interactions) {
    const character = scene.characters.find(
      (c) => c.id === interaction.characterId,
    );
    const object =
      scene.props.find((p) => p.id === interaction.objectId) ??
      scene.world?.entities.find((e) => e.id === interaction.objectId);
    if (!character || !('source' in character))
      throw new TypeError(
        `Interaction ${interaction.id} requires a skeletal character: ${interaction.characterId}`,
      );
    if (!object || ('parentId' in object && object.parentId))
      throw new TypeError(
        `Interaction ${interaction.id} requires a root world object or prop: ${interaction.objectId}`,
      );
    if (
      ids.has(interaction.id) ||
      objectIds.has(interaction.objectId) ||
      drivers.has(interaction.characterId)
    )
      throw new TypeError(
        `Duplicate interaction, object or character binding: ${interaction.id}`,
      );
    ids.add(interaction.id);
    objectIds.add(interaction.objectId);
    const { position, rotationDegrees, scale } = object.transform;
    const initial = {
      position: [position.x, position.y, position.z],
      rotation: quaternion([
        rotationDegrees.x,
        rotationDegrees.y,
        rotationDegrees.z,
      ]),
    } satisfies RigidTransform;
    const scaled = {
      ...interaction,
      objectAnchor: {
        ...interaction.objectAnchor,
        transform: {
          ...interaction.objectAnchor.transform,
          position: interaction.objectAnchor.transform.position.map(
            (v) => v * scale,
          ) as RigidTransform['position'],
        },
      },
    };
    drivers.set(interaction.characterId, createDriver(scaled, initial, frames));
  }
  for (const character of scene.characters) {
    for (const action of character.actions) {
      if (
        (action.type === 'grasp' ||
          action.type === 'lift' ||
          action.type === 'place' ||
          action.type === 'kick') &&
        objectIds.has(action.targetEntityId)
      )
        throw new TypeError(
          `Action ${action.id} conflicts with compiled interaction on ${action.targetEntityId}`,
        );
    }
    if (!('source' in character)) continue;
    for (let id = character.parentId; id;) {
      if (objectIds.has(id))
        throw new TypeError(
          `Character ${character.id} cannot be parented to an interaction object`,
        );
      id = scene.world?.entities.find((e) => e.id === id)?.parentId;
    }
  }
  return drivers;
}

function createDriver(
  interaction: ObjectInteraction,
  initial: RigidTransform,
  frames: number,
) {
  const actions = prepareInteractions(interaction.actions);
  if (actions.some((a) => a.endFrame >= frames))
    throw new TypeError(`Interaction ${interaction.id} exceeds shot duration`);
  const { handAnchor, objectAnchor, tolerance, angularTolerance } = interaction;
  const track: NonNullable<CompiledSceneInstruction['objectMotion']>[number] = {
    objectId: interaction.objectId,
    poses: [],
  };
  const constraint = SpatialConstraintSchema.parse({
    id: interaction.id,
    effector: interaction.effector,
    chainRoot: interaction.chainRoot,
    startFrame: 0,
    endFrame: frames - 1,
    target: initial.position,
    tolerance,
    angularTolerance,
  });
  let state: InteractionState;
  let step: InteractionStep;
  return {
    track,
    constraint,
    target(frame: number, hand: RigidTransform) {
      state ??= createInteractionState(initial, hand);
      step = planInteractionFrame(
        state,
        actions,
        frame,
        handAnchor,
        objectAnchor,
      );
      if (step.action?.kind === 'grasp') {
        step.desiredHand = composeTransform(
          composeTransform(state.object, objectAnchor.transform),
          inverseTransform(handAnchor.transform),
        );
      }
      return (
        step.desiredHand && {
          pose: step.desiredHand,
          priority: step.action!.priority,
        }
      );
    },
    resolved(_frame: number, hand: RigidTransform) {
      state = advanceInteraction(
        state,
        step,
        hand,
        handAnchor,
        objectAnchor,
        tolerance,
        angularTolerance,
      );
      track.poses.push(state.object);
    },
  };
}
