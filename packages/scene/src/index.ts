import {
  canonicalJsonSha256,
  compareStrings,
  ShotSceneSchema,
  type CompiledSceneInstruction,
  type MotionClipLibrary,
  type Rational,
  type Shot,
  type SpatialConstraint,
} from '@filmmaking/contracts';
import { compileWorld } from './world.js';
import { compileStyle } from './visual.js';
export {
  CHARCOAL_HORROR_STYLE,
  CHARCOAL_HORROR_STYLE_2_0,
  STYLE_DEFINITIONS,
  resolveCharcoalHorrorStyle,
} from './visual.js';
import { prepareCharacter } from './character.js';
import { motionLibrary, sampleCharacterMotion } from './skeletal-motion.js';
import { constrainMotion } from './spatial-constraints.js';
import { compileInteractions } from './compile-interactions.js';
import { compileContacts } from './compile-contacts.js';
import { compilePhysics } from './physics.js';
import { compileCinematography } from './cinematography.js';
import { attachFacialRig, compileFacialPerformance } from './facial.js';
export * from './collision.js';
export { compilePhysics } from './physics.js';
import { sampleLocomotion } from './locomotion.js';
export { sampleLocomotion } from './locomotion.js';
export * from './interactions.js';
export * from './contact-graph.js';
export * from './contact-response.js';
export * from './rigid-transforms.js';
export { constrainMotion, forwardKinematics } from './spatial-constraints.js';

export { compileWorld } from './world.js';
export { prepareCharacter } from './character.js';
export { motionLibrary, sampleCharacterMotion } from './skeletal-motion.js';
export { filmPlane, projectCameraPoint } from './camera-math.js';

export const SCENE_COMPILER_VERSION = 'scene-compiler-v12';
export const SEMANTIC_ANIMATION_LIBRARY_VERSION = '1.0.0';

export type CompiledScene = CompiledSceneInstruction;

export function compileScene(
  shotInput: Shot,
  frameRate: Rational,
  motionClipLibraries: readonly MotionClipLibrary[] = [],
  renderAspect = 16 / 9,
): CompiledScene {
  const shot: Shot = shotInput;
  if (!shot.scene) {
    throw new TypeError(`Shot "${shot.id}" has no structured scene`);
  }
  const scene = ShotSceneSchema.parse(shot.scene);
  const facialRigs = new Map(scene.facialRigs?.map((rig) => [rig.id, rig]));
  if (facialRigs.size !== (scene.facialRigs?.length ?? 0))
    throw new TypeError('Duplicate facial rig ID');
  const skeletalClips = motionLibrary(scene.motionClips);
  const style = compileStyle(scene);
  if (scene.animationLibraryVersion !== SEMANTIC_ANIMATION_LIBRARY_VERSION)
    throw new TypeError(
      `Unsupported semantic animation library version "${scene.animationLibraryVersion}"; available version is "${SEMANTIC_ANIMATION_LIBRARY_VERSION}"`,
    );
  const entities = new Set([
    ...scene.characters.map((character) => character.id),
    ...scene.props.map((prop) => prop.id),
  ]);
  for (const character of scene.characters) {
    for (const action of character.actions) {
      if (
        action.endFrame <= action.startFrame ||
        action.endFrame > shot.durationFrames
      ) {
        throw new TypeError(
          `Action "${action.id}" on character "${character.id}" is outside shot "${shot.id}"`,
        );
      }
      const targetEntityId =
        'targetEntityId' in action ? action.targetEntityId : undefined;
      if (targetEntityId !== undefined && !entities.has(targetEntityId)) {
        throw new TypeError(
          `Action "${action.id}" targets unknown scene entity "${targetEntityId}"`,
        );
      }
    }
    const motionClips = character.actions
      .filter((action) => action.type === 'motion-clip')
      .sort((left, right) => left.startFrame - right.startFrame);
    for (let index = 1; index < motionClips.length; index += 1) {
      const previous = motionClips[index - 1];
      const current = motionClips[index];
      if (previous && current && current.startFrame < previous.endFrame) {
        throw new TypeError(
          `Overlapping motion clips "${previous.id}" and "${current.id}" on character "${character.id}" are unsupported`,
        );
      }
    }
  }
  const libraryMap = new Map(
    motionClipLibraries.map((library) => [
      `${library.libraryId}\u0000${library.version}`,
      library,
    ]),
  );
  const motionCurves: CompiledSceneInstruction['motionCurves'] = [];
  for (const character of scene.characters) {
    for (const action of character.actions) {
      if (action.type !== 'motion-clip') continue;
      const library = libraryMap.get(
        `${action.library.assetId}\u0000${action.library.version}`,
      );
      if (!library)
        throw new TypeError(
          `Motion clip library ${action.library.assetId}@${action.library.version} was not resolved`,
        );
      const clip = library.clips.find(
        (candidate) => candidate.id === action.clipId,
      );
      if (!clip)
        throw new TypeError(
          `Motion clip "${action.clipId}" was not found in ${library.libraryId}@${library.version}`,
        );
      const expectedDuration = Math.round(
        clip.durationFrames / action.playbackRate,
      );
      if (action.endFrame - action.startFrame !== expectedDuration)
        throw new TypeError(
          `Motion clip "${action.clipId}" must occupy ${expectedDuration} frames at playback rate ${action.playbackRate}`,
        );
      for (const track of clip.tracks) {
        for (const keyframe of track.keyframes) {
          motionCurves.push({
            characterId: character.id,
            control: track.control,
            channel: track.channel,
            frame:
              action.startFrame +
              Math.round(keyframe.frame / action.playbackRate),
            value: keyframe.value,
            blendMode: action.blendMode,
            ...(keyframe.interpolation !== 'linear'
              ? { interpolation: keyframe.interpolation }
              : {}),
            ...(keyframe.interpolation === 'cubic-bezier' && keyframe.bezier
              ? { bezier: keyframe.bezier }
              : {}),
          });
        }
      }
      if (clip.rootMotion) {
        motionCurves.push({
          characterId: character.id,
          control: clip.rootMotion.control,
          channel: clip.rootMotion.channel,
          frame: action.startFrame,
          value: [0, 0, 0],
          blendMode: action.blendMode,
        });
        motionCurves.push({
          characterId: character.id,
          control: clip.rootMotion.control,
          channel: clip.rootMotion.channel,
          frame: action.endFrame - 1,
          value: [...clip.rootMotion.distance],
          blendMode: action.blendMode,
        });
      }
    }
  }
  const world = scene.world ? compileWorld(scene.world) : undefined;
  const interactions = compileInteractions(scene, shot.durationFrames);
  const physics = compilePhysics(
    world,
    scene.interactions,
    shot.durationFrames,
  );
  const protectedConstraints = new Map<string, SpatialConstraint[]>();
  const characters = [...scene.characters]
    .map((character) =>
      'source' in character
        ? (() => {
            const prepared = prepareCharacter(character, shot.durationFrames);
            if (character.facial) {
              const rig = facialRigs.get(character.facial.rigId);
              if (!rig)
                throw new TypeError(
                  'Unknown facial rig ' + character.facial.rigId,
                );
              attachFacialRig(prepared, rig);
            }
            const locomotion = sampleLocomotion(
              prepared,
              character.locomotion,
              sampleCharacterMotion(
                prepared,
                character.motion,
                skeletalClips,
                shot.durationFrames,
                frameRate,
              ),
              shot.durationFrames,
              frameRate,
              world,
            );
            const constraints = [
              ...character.constraints,
              ...locomotion.contacts,
            ];
            if (scene.contactGraph || character.facial)
              protectedConstraints.set(character.id, constraints);
            const sampledMotion = constrainMotion(
              prepared,
              locomotion.motion,
              constraints,
              shot.durationFrames,
              world,
              interactions.get(character.id),
              new Set(locomotion.contacts.map((contact) => contact.id)),
            );
            return sampledMotion ? { ...prepared, sampledMotion } : prepared;
          })()
        : {
            ...character,
            actions: [...character.actions].sort(
              (left, right) =>
                left.startFrame - right.startFrame ||
                compareStrings(left.id, right.id),
            ),
          },
    )
    .sort((left, right) => compareStrings(left.id, right.id));
  compileContacts(
    scene,
    shot.durationFrames,
    characters,
    protectedConstraints,
    world,
    physics,
    frameRate,
  );
  const objectMotion = interactions.size
    ? [...interactions.values()]
        .map(({ track }) => track)
        .sort((a, b) => compareStrings(a.objectId, b.objectId))
    : undefined;
  const targetScene = {
    characters,
    props: scene.props,
    ...(world ? { world } : {}),
    ...(physics ? { physics } : {}),
    ...(objectMotion ? { objectMotion } : {}),
  };
  compileFacialPerformance(
    scene,
    targetScene,
    shot.durationFrames,
    protectedConstraints,
    facialRigs,
  );
  const cinematography =
    scene.camera.type === 'rigs'
      ? compileCinematography(
          scene.camera,
          targetScene,
          shot.durationFrames,
          frameRate,
          renderAspect,
        )
      : undefined;
  const withoutHash = {
    version: SCENE_COMPILER_VERSION,
    shotId: shot.id,
    durationFrames: shot.durationFrames,
    frameRate,
    animationLibraryVersion: scene.animationLibraryVersion,
    styleVersion: scene.styleVersion,
    style,
    ...(scene.visualSettings ? { visualSettings: scene.visualSettings } : {}),
    ...(scene.environment ? { environment: scene.environment } : {}),
    ...(world ? { world } : {}),
    ...(physics ? { physics } : {}),
    characters,
    ...(objectMotion ? { objectMotion } : {}),
    props: [...scene.props].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    lights: [...scene.lights].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    camera: scene.camera,
    ...(cinematography ? { cinematography } : {}),
    cameraKeyframes: (() => {
      const camera = scene.camera;
      if (camera.type === 'rigs') return [];
      const keyframe = (
        frame: number,
        target: { x: number; y: number; z: number },
        distance: number,
        focalLength: number,
      ) => ({
        frame,
        distance,
        position: { x: target.x, y: target.y - distance, z: target.z },
        target,
        focalLength,
      });
      if (camera.type === 'push-in') {
        return [
          keyframe(
            camera.startFrame + 1,
            camera.target,
            camera.fromDistance,
            50,
          ),
          keyframe(
            camera.startFrame + camera.durationFrames,
            camera.target,
            camera.toDistance,
            50,
          ),
        ];
      }
      if (camera.type === 'pan') {
        return [
          keyframe(
            camera.startFrame + 1,
            camera.fromTarget,
            camera.distance,
            50,
          ),
          keyframe(
            camera.startFrame + camera.durationFrames,
            camera.toTarget,
            camera.distance,
            50,
          ),
        ];
      }
      if (camera.type === 'zoom') {
        return [
          keyframe(
            camera.startFrame + 1,
            camera.target,
            camera.distance,
            camera.fromFocalLength,
          ),
          keyframe(
            camera.startFrame + camera.durationFrames,
            camera.target,
            camera.distance,
            camera.toFocalLength,
          ),
        ];
      }
      return [
        keyframe(1, camera.target, camera.distance, camera.focalLength),
        keyframe(
          shot.durationFrames,
          camera.target,
          camera.distance,
          camera.focalLength,
        ),
      ];
    })(),
    actions: scene.characters.flatMap((character) =>
      character.actions.map((action) => ({
        characterId: character.id,
        action,
        interval: {
          startFrame: action.startFrame,
          endFrame: action.endFrame,
        },
      })),
    ),
    motionCurves: motionCurves.sort(
      (left, right) =>
        left.frame - right.frame ||
        compareStrings(
          `${left.characterId}:${left.control}:${left.channel}`,
          `${right.characterId}:${right.control}:${right.channel}`,
        ),
    ),
  };
  return {
    ...withoutHash,
    sha256: canonicalJsonSha256(withoutHash),
  };
}
export * from './retargeting.js';
