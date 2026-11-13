import {
  canonicalJsonSha256,
  compareStrings,
  ShotSceneSchema,
  type CompiledSceneInstruction,
  type MotionClipLibrary,
  type Rational,
  type Shot,
  type SpatialConstraint,
  type RigidTransform,
} from '@filmmaking/contracts';
import {
  bakeSecondaryMotion,
  bakeSecondarySkeletalMotion,
} from '@filmmaking/secondary-motion';
import { compileWorld } from './world.js';
import { compileStyle } from './visual.js';
export {
  CHARCOAL_HORROR_STYLE,
  CHARCOAL_HORROR_STYLE_2_0,
  STYLE_DEFINITIONS,
  resolveCharcoalHorrorStyle,
} from './visual.js';
import { sampleRetargetedMotion } from './compile-retargeting.js';
import { prepareCharacter } from './character.js';
import { motionLibrary, sampleCharacterMotion } from './skeletal-motion.js';
import { constrainMotion } from './spatial-constraints.js';
import { compileInteractions } from './compile-interactions.js';
import { compileContacts } from './compile-contacts.js';
import { compilePhysics } from './physics.js';
import { bakeCharacterFollowers } from './physics-followers.js';
import { compileCinematography } from './cinematography.js';
import { attachFacialRig, compileFacialPerformance } from './facial.js';
export * from './collision.js';
export { compilePhysics } from './physics.js';
import { sampleLocomotion } from './locomotion.js';
import { worldCollisionProxies } from './collision.js';
import { withinLimits } from './motion-math.js';
export { sampleLocomotion } from './locomotion.js';
export * from './interactions.js';
export * from './contact-graph.js';
export * from './contact-response.js';
export * from './rigid-transforms.js';
export { identity, multiply } from './motion-math.js';
export { constrainMotion, forwardKinematics } from './spatial-constraints.js';
export {
  createArticulatedKinematicsEvaluator,
  evaluateArticulatedKinematics,
} from './articulated-kinematics.js';
export type { ArticulatedKinematicResult } from './articulated-kinematics.js';

export { compileWorld } from './world.js';
export { prepareCharacter } from './character.js';
export { motionLibrary, sampleCharacterMotion } from './skeletal-motion.js';
export { filmPlane, projectCameraPoint } from './camera-math.js';

export const SCENE_COMPILER_VERSION = 'scene-compiler-v15';
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
  const retargetProfiles = new Map(
    scene.retargetProfiles?.map((profile) => [profile.id, profile]),
  );
  if (retargetProfiles.size !== (scene.retargetProfiles?.length ?? 0))
    throw new TypeError('Duplicate retarget profile ID');
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
  for (const track of scene.articulatedMotion)
    if (!entities.has(track.objectId))
      throw new TypeError(
        `Articulated motion targets unknown scene entity "${track.objectId}"`,
      );
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
  const secondaryMotionTracks: NonNullable<
    CompiledSceneInstruction['secondaryMotion']
  > = [];
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
            const profile = character.retargetProfileId
              ? retargetProfiles.get(character.retargetProfileId)
              : undefined;
            if (character.retargetProfileId && !profile)
              throw new TypeError(
                'Unknown retarget profile ' + character.retargetProfileId,
              );
            const locomotion = sampleLocomotion(
              prepared,
              character.locomotion,
              profile
                ? sampleRetargetedMotion(
                    prepared,
                    character.motion,
                    profile,
                    skeletalClips,
                    shot.durationFrames,
                    frameRate,
                  )
                : sampleCharacterMotion(
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
            if (!prepared.secondaryMotion) {
              return sampledMotion ? { ...prepared, sampledMotion } : prepared;
            }
            const boneIds = new Set(prepared.bones.map((bone) => bone.id));
            for (const node of prepared.secondaryMotion.nodes)
              if (
                (node.kind === 'skeletal-control' || node.kind === 'chain') &&
                !boneIds.has(node.id)
              )
                throw new TypeError(
                  `Secondary motion node "${node.id}" is not a joint on character "${character.id}"`,
                );
            const baseMotion = sampledMotion ?? {
              joints: prepared.secondaryMotion.nodes.map((node) => ({
                joint: node.id,
                rotations: Array.from(
                  { length: shot.durationFrames },
                  () => [1, 0, 0, 0] as [number, number, number, number],
                ),
              })),
            };
            const sampledJoints = new Set(
              baseMotion.joints.map((track) => track.joint),
            );
            const withSecondaryJoints = {
              ...baseMotion,
              joints: [
                ...baseMotion.joints,
                ...prepared.secondaryMotion.nodes
                  .filter((node) => !sampledJoints.has(node.id))
                  .map((node) => ({
                    joint: node.id,
                    rotations: Array.from(
                      { length: shot.durationFrames },
                      () => [1, 0, 0, 0] as [number, number, number, number],
                    ),
                  })),
              ],
            };
            const secondaryMotion = bakeSecondarySkeletalMotion(
              withSecondaryJoints,
              prepared.secondaryMotion,
              frameRate,
            );
            for (const track of secondaryMotion.joints) {
              const bone = prepared.bones.find(
                (candidate) => candidate.id === track.joint,
              );
              if (
                bone &&
                track.rotations.some(
                  (rotation) => !withinLimits(rotation, bone.min, bone.max),
                )
              )
                throw new TypeError(
                  `Secondary motion exceeds joint limits on "${track.joint}" for character "${character.id}"`,
                );
            }
            if (
              prepared.secondaryMotion.nodes.some(
                (node) => node.kind === 'attachment',
              )
            ) {
              const rotations = new Map(
                secondaryMotion.joints.map((track) => [
                  track.joint,
                  track.rotations,
                ]),
              );
              const authored = prepared.secondaryMotion.nodes.flatMap(
                (node) => {
                  const values = rotations.get(node.id);
                  return values
                    ? values.map((rotation, frame) => ({
                        nodeId: node.id,
                        frame,
                        pose: { position: node.restPose.position, rotation },
                      }))
                    : [];
                },
              );
              secondaryMotionTracks.push({
                ownerId: character.id,
                bindings: prepared.secondaryMotion.nodes
                  .filter((node) => node.kind === 'attachment')
                  .map((node) => ({
                    nodeId: node.id,
                    target: 'control',
                    space: 'local',
                  })),
                frames: bakeSecondaryMotion({
                  config: {
                    frameCount: shot.durationFrames,
                    settings: {
                      frameRate,
                      substeps: prepared.secondaryMotion.substeps,
                      solverIterations:
                        prepared.secondaryMotion.solverIterations,
                      deterministicSeed:
                        prepared.secondaryMotion.deterministicSeed,
                    },
                    nodes: prepared.secondaryMotion.nodes,
                    colliders: prepared.secondaryMotion.colliders,
                  },
                  authored,
                }),
              });
            }
            return {
              ...prepared,
              sampledMotion: {
                ...secondaryMotion,
                joints: secondaryMotion.joints.filter((track) =>
                  boneIds.has(track.joint),
                ),
              },
            };
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
  const worldSecondaryMotion = world
    ? world.entities.flatMap((entity) => {
        if (!entity.secondaryMotion) return [];
        const nodeIds = new Set(
          entity.secondaryMotion.nodes.map((node) => node.id),
        );
        for (const node of entity.secondaryMotion.nodes) {
          if (node.parentId && !nodeIds.has(node.parentId))
            throw new TypeError(
              `Secondary motion node "${node.id}" on "${entity.id}" has an unknown parent`,
            );
        }
        const object = [...interactions.values()].find(
          (driver) => driver.track.objectId === entity.id,
        )?.track.poses;
        const authored: {
          nodeId: string;
          frame: number;
          pose: RigidTransform;
        }[] = [];
        const root = entity.secondaryMotion.nodes.find(
          (node) => !node.parentId,
        );
        if (
          !root ||
          entity.secondaryMotion.nodes.filter((node) => !node.parentId)
            .length !== 1
        )
          throw new TypeError(
            'World secondary motion requires exactly one root on ' + entity.id,
          );
        const body = physics?.bodies.find(
          (candidate) => candidate.entityId === entity.id,
        );
        const ownsRoot = !object && !body;
        if (root && object)
          object.forEach((pose, frame) =>
            authored.push({ nodeId: root.id, frame, pose }),
          );
        const frames = bakeSecondaryMotion({
          config: {
            frameCount: shot.durationFrames,
            settings: {
              frameRate,
              substeps: entity.secondaryMotion.substeps,
              solverIterations: entity.secondaryMotion.solverIterations,
              deterministicSeed: entity.secondaryMotion.deterministicSeed,
            },
            nodes: entity.secondaryMotion.nodes.map((node) =>
              node === root && !ownsRoot
                ? {
                    ...node,
                    anchored: true,
                    restPose: body?.initialPose ?? node.restPose,
                  }
                : node,
            ),
            colliders: [
              ...entity.secondaryMotion.colliders,
              ...(world
                ? worldCollisionProxies(world)
                    .filter(
                      (proxy) =>
                        proxy.entityId !== entity.id &&
                        !physics?.bodies.some(
                          (body) =>
                            body.entityId === proxy.entityId &&
                            body.properties.mode !== 'static',
                        ),
                    )
                    .map(({ id, shape, pose }) => ({ id, shape, pose }))
                : []),
            ],
          },
          authored,
        });
        const bindings: (typeof secondaryMotionTracks)[number]['bindings'] = [];
        for (const node of entity.secondaryMotion.nodes) {
          if (node !== root)
            bindings.push({
              nodeId: node.id,
              target: 'control',
              space: 'local',
            });
          else if (ownsRoot)
            bindings.push({ nodeId: node.id, target: 'root', space: 'world' });
        }
        return [{ ownerId: entity.id, frames, bindings }];
      })
    : [];
  secondaryMotionTracks.push(...worldSecondaryMotion);
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
    ...(scene.articulatedMotion.length
      ? { articulatedMotion: scene.articulatedMotion }
      : {}),
    ...(secondaryMotionTracks.length
      ? { secondaryMotion: secondaryMotionTracks }
      : {}),
  };
  compileFacialPerformance(
    scene,
    targetScene,
    shot.durationFrames,
    protectedConstraints,
    facialRigs,
  );
  if (physics)
    bakeCharacterFollowers(physics, targetScene, shot.durationFrames);
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
    ...(scene.articulatedMotion.length
      ? { articulatedMotion: scene.articulatedMotion }
      : {}),
    ...(secondaryMotionTracks.length
      ? { secondaryMotion: secondaryMotionTracks }
      : {}),
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
export * from './articulated-dynamics.js';
