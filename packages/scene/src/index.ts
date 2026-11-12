import {
  canonicalJsonSha256,
  compareStrings,
  ShotSceneSchema,
  STYLE_DEFINITION_REGISTRY,
  type CompiledSceneInstruction,
  type MotionClipLibrary,
  type CharcoalStyleOverrides,
  type Rational,
  type Shot,
  type SpatialConstraint,
} from '@filmmaking/contracts';
import { compileWorld } from './world.js';
import { prepareCharacter } from './character.js';
import { motionLibrary, sampleCharacterMotion } from './skeletal-motion.js';
import { constrainMotion } from './spatial-constraints.js';
import { compileInteractions } from './compile-interactions.js';
import { compileContacts } from './compile-contacts.js';
import { compilePhysics } from './physics.js';
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

export const SCENE_COMPILER_VERSION = 'scene-compiler-v11';
export const SEMANTIC_ANIMATION_LIBRARY_VERSION = '1.0.0';

export const CHARCOAL_HORROR_STYLE = {
  id: 'charcoal_horror',
  version: '1.2.0',
  palette: {
    shadow: [0.065, 0.057, 0.049],
    graphite: [0.31, 0.285, 0.255],
    paper: [0.78, 0.75, 0.69],
  },
  lighting: {
    keyColor: [0.73, 0.69, 0.62],
    keyEnergy: 110,
    keySize: 3.4,
    keyPosition: [-2.0, -3.5, 2.4],
    ambientFill: 0.34,
  },
  grainScale: 42,
  grainStrength: 0.09,
  vignetteStrength: 0.2,
  hazeStrength: 0.025,
  paperFiberScale: 240,
  paperOpacity: 0.045,
  lineBoilStrength: 0.12,
} as const;

export const CHARCOAL_HORROR_STYLE_2_0 = {
  ...CHARCOAL_HORROR_STYLE,
  version: '2.0.0',
  edgeBreakup: 0.24,
  edgeSoftness: 0.015,
  shadowSmudge: 0.18,
  graphiteSheen: 0.16,
  contrastCurve: [0.12, 0.88] as const,
  paperWhitePoint: 0.78,
  hazeDrift: 0.12,
  dustDensity: 0,
  shadows: 'soft-cast' as const,
} as const;

export const STYLE_DEFINITIONS = {
  'charcoal_horror@1.2.0': CHARCOAL_HORROR_STYLE,
  'charcoal_horror@2.0.0': CHARCOAL_HORROR_STYLE_2_0,
} as const;

export type CompiledScene = CompiledSceneInstruction;

export function resolveCharcoalHorrorStyle(
  overrides: CharcoalStyleOverrides = {},
) {
  return {
    id: CHARCOAL_HORROR_STYLE.id,
    version: CHARCOAL_HORROR_STYLE.version,
    palette: {
      shadow: overrides.palette?.shadow ?? CHARCOAL_HORROR_STYLE.palette.shadow,
      graphite:
        overrides.palette?.graphite ?? CHARCOAL_HORROR_STYLE.palette.graphite,
      paper: overrides.palette?.paper ?? CHARCOAL_HORROR_STYLE.palette.paper,
    },
    lighting: {
      keyColor:
        overrides.lighting?.keyColor ?? CHARCOAL_HORROR_STYLE.lighting.keyColor,
      keyEnergy:
        overrides.lighting?.keyEnergy ??
        CHARCOAL_HORROR_STYLE.lighting.keyEnergy,
      keySize:
        overrides.lighting?.keySize ?? CHARCOAL_HORROR_STYLE.lighting.keySize,
      keyPosition:
        overrides.lighting?.keyPosition ??
        CHARCOAL_HORROR_STYLE.lighting.keyPosition,
      ambientFill:
        overrides.lighting?.ambientFill ??
        CHARCOAL_HORROR_STYLE.lighting.ambientFill,
    },
    grainScale: overrides.grainScale ?? CHARCOAL_HORROR_STYLE.grainScale,
    grainStrength:
      overrides.grainStrength ?? CHARCOAL_HORROR_STYLE.grainStrength,
    vignetteStrength:
      overrides.vignetteStrength ?? CHARCOAL_HORROR_STYLE.vignetteStrength,
    hazeStrength: overrides.hazeStrength ?? CHARCOAL_HORROR_STYLE.hazeStrength,
    paperFiberScale:
      overrides.paperFiberScale ?? CHARCOAL_HORROR_STYLE.paperFiberScale,
    paperOpacity: overrides.paperOpacity ?? CHARCOAL_HORROR_STYLE.paperOpacity,
    lineBoilStrength:
      overrides.lineBoilStrength ?? CHARCOAL_HORROR_STYLE.lineBoilStrength,
  };
}

function resolveStyle(
  preset: string,
  version: string,
  overrides: CharcoalStyleOverrides = {},
) {
  const normalizedVersion = version === '1.1.0' ? '1.2.0' : version;
  const registryKey =
    `${preset}@${normalizedVersion}` as keyof typeof STYLE_DEFINITIONS;
  const definition = STYLE_DEFINITIONS[registryKey] as
    typeof CHARCOAL_HORROR_STYLE_2_0 | undefined;
  const registered = STYLE_DEFINITION_REGISTRY.some(
    (item) => item.id === preset && item.version === normalizedVersion,
  );
  if (!definition || !registered)
    throw new TypeError(
      `Unknown style "${preset}@${version}". Registered styles: ${Object.keys(STYLE_DEFINITIONS).join(', ')}`,
    );
  const base = resolveCharcoalHorrorStyle(overrides);
  if (version === '1.1.0' || version === '1.2.0') return base;
  return {
    ...base,
    id: definition.id,
    version: definition.version,
    edgeBreakup: overrides.edgeBreakup ?? definition.edgeBreakup,
    edgeSoftness: overrides.edgeSoftness ?? definition.edgeSoftness,
    shadowSmudge: overrides.shadowSmudge ?? definition.shadowSmudge,
    graphiteSheen: overrides.graphiteSheen ?? definition.graphiteSheen,
    contrastCurve: overrides.contrastCurve ?? definition.contrastCurve,
    paperWhitePoint: overrides.paperWhitePoint ?? definition.paperWhitePoint,
    hazeDrift: overrides.hazeDrift ?? definition.hazeDrift,
    dustDensity: overrides.dustDensity ?? definition.dustDensity,
    shadows: overrides.shadows ?? definition.shadows,
    glow: overrides.glow ?? true,
    finalGrade: overrides.finalGrade ?? true,
  };
}

export function compileScene(
  shotInput: Shot,
  frameRate: Rational,
  motionClipLibraries: readonly MotionClipLibrary[] = [],
): CompiledScene {
  const shot: Shot = shotInput;
  if (!shot.scene) {
    throw new TypeError(`Shot "${shot.id}" has no structured scene`);
  }
  const scene = ShotSceneSchema.parse(shot.scene);
  const skeletalClips = motionLibrary(scene.motionClips);
  if (scene.stylePreset !== 'charcoal_horror')
    throw new TypeError(`Unknown style "${scene.stylePreset}"`);
  const style = resolveStyle(
    scene.stylePreset,
    scene.styleVersion,
    scene.styleOverrides,
  );
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
            if (scene.contactGraph)
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
  const withoutHash = {
    version: SCENE_COMPILER_VERSION,
    shotId: shot.id,
    durationFrames: shot.durationFrames,
    frameRate,
    animationLibraryVersion: scene.animationLibraryVersion,
    styleVersion: scene.styleVersion,
    style,
    ...(scene.environment ? { environment: scene.environment } : {}),
    ...(world ? { world } : {}),
    ...(physics ? { physics } : {}),
    characters,
    ...(interactions.size
      ? {
          objectMotion: [...interactions.values()]
            .map(({ track }) => track)
            .sort((a, b) => compareStrings(a.objectId, b.objectId)),
        }
      : {}),
    props: [...scene.props].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    lights: [...scene.lights].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    camera: scene.camera,
    cameraKeyframes: (() => {
      const camera = scene.camera;
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
