import {
  InteractionActionSchema,
  RigidTransformSchema,
  type InteractionAction,
  type InteractionAnchor,
  type RigidTransform,
} from '@filmmaking/contracts';
import {
  angularDistance,
  blendTransform,
  composeTransform,
  inverseTransform,
} from './rigid-transforms.js';

export interface InteractionState {
  frame: number;
  object: RigidTransform;
  hand: RigidTransform;
  attachment?: RigidTransform;
  transition?: { id: string; start: RigidTransform };
}
export interface InteractionStep {
  frame: number;
  action?: InteractionAction;
  desiredHand?: RigidTransform;
  transition?: { id: string; start: RigidTransform };
}

export function createInteractionState(
  object: RigidTransform,
  hand: RigidTransform,
): InteractionState {
  return {
    frame: -1,
    object: RigidTransformSchema.parse(object),
    hand: RigidTransformSchema.parse(hand),
  };
}

/** Inclusive frame intervals. Events occupy one frame. Ownership is exclusive. */
export function prepareInteractions(
  input: readonly InteractionAction[],
): InteractionAction[] {
  const actions = input.map((a) => InteractionActionSchema.parse(a));
  const ids = new Set<string>();
  for (const action of actions) {
    if (ids.has(action.id))
      throw new TypeError('Duplicate interaction ' + action.id);
    ids.add(action.id);
  }
  actions.sort(
    (a, b) => a.startFrame - b.startFrame || b.priority - a.priority,
  );
  for (let i = 1; i < actions.length; i++)
    if (actions[i]!.startFrame <= actions[i - 1]!.endFrame)
      throw new TypeError(
        'Overlapping interaction ownership or motion intervals',
      );
  let attached = false;
  for (const action of actions) {
    if (action.kind === 'grasp') {
      if (attached) throw new TypeError('Cannot grasp an already held object');
      attached = true;
    } else if (action.kind === 'release') {
      if (!attached) throw new TypeError('Cannot release an unheld object');
      attached = false;
    } else if (['carry', 'place'].includes(action.kind) && !attached) {
      throw new TypeError(action.kind + ' requires a grasp');
    } else if (action.kind === 'reach' && attached) {
      throw new TypeError('Reach requires a free hand');
    }
  }
  return actions;
}

/** Plan a target, solve the rig, then pass its actual hand pose to advanceInteraction. */
export function planInteractionFrame(
  state: InteractionState,
  actions: readonly InteractionAction[],
  frame: number,
  handAnchor: InteractionAnchor,
): InteractionStep {
  if (!Number.isSafeInteger(frame) || frame !== state.frame + 1)
    throw new TypeError('Interactions require consecutive frames');
  const action = actions.find(
    (a) => frame >= a.startFrame && frame <= a.endFrame,
  );
  if (!action) return { frame };
  if (action.kind !== 'reach' && action.kind !== 'place')
    return { frame, action };
  if (action.kind === 'place' && !state.attachment)
    throw new TypeError('Place requires an attachment');
  const transition =
    state.transition?.id === action.id
      ? state.transition
      : { id: action.id, start: state.hand };
  const target =
    action.kind === 'place'
      ? composeTransform(action.target, inverseTransform(state.attachment!))
      : composeTransform(action.target, inverseTransform(handAnchor.transform));
  const t =
    action.endFrame === action.startFrame
      ? 1
      : (frame - action.startFrame) / (action.endFrame - action.startFrame);
  return {
    frame,
    action,
    transition,
    desiredHand: blendTransform(transition.start, target, t * t * (3 - 2 * t)),
  };
}

/** Uses solved poses, so an unsatisfied reach never silently attaches or teleports an object. */
export function advanceInteraction(
  state: InteractionState,
  step: InteractionStep,
  solvedHand: RigidTransform,
  handAnchor: InteractionAnchor,
  objectAnchor: InteractionAnchor,
  tolerance = 0.005,
  angularTolerance = 0.01,
): InteractionState {
  if (step.frame !== state.frame + 1)
    throw new TypeError('Interaction frame is stale or skipped');
  if (!(
    Number.isFinite(tolerance) &&
    tolerance > 0 &&
    Number.isFinite(angularTolerance) &&
    angularTolerance > 0
  ))
    throw new TypeError('Invalid interaction tolerances');
  const hand = RigidTransformSchema.parse(solvedHand);
  const assertContact = (a: RigidTransform, b: RigidTransform) => {
    const distance = Math.hypot(
      ...a.position.map((v, i) => v - b.position[i]!),
    );
    if (
      distance > tolerance ||
      angularDistance(a.rotation, b.rotation) > angularTolerance
    )
      throw new TypeError(
        `Interaction ${step.action?.id} unsatisfied at frame ${step.frame}`,
      );
  };
  if (step.desiredHand) assertContact(hand, step.desiredHand);
  let attachment = state.attachment;
  const object = attachment
    ? composeTransform(hand, attachment)
    : structuredClone(state.object);
  if (step.action?.kind === 'grasp') {
    if (attachment) throw new TypeError('Object is already attached');
    assertContact(
      composeTransform(hand, handAnchor.transform),
      composeTransform(object, objectAnchor.transform),
    );
    attachment = composeTransform(inverseTransform(hand), object);
  }
  if (step.action?.kind === 'release') {
    if (!attachment) throw new TypeError('Object is not attached');
    attachment = undefined;
  }
  if (step.action?.kind === 'place' && step.frame === step.action.endFrame)
    assertContact(object, step.action.target);
  return {
    frame: step.frame,
    object,
    hand,
    ...(attachment ? { attachment } : {}),
    ...(step.transition ? { transition: step.transition } : {}),
  };
}
