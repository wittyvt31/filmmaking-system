import {
  canonicalJsonSha256,
  compareStrings,
  ShotSceneSchema,
  type CompiledSceneInstruction,
  type MotionClipLibrary,
  type CharcoalStyleOverrides,
  type Rational,
  type Shot,
} from '@filmmaking/contracts';

export const SCENE_COMPILER_VERSION = 'scene-compiler-v4';
export const SEMANTIC_ANIMATION_LIBRARY_VERSION = '1.0.0';

export const CHARCOAL_HORROR_STYLE = {
  id: 'charcoal_horror',
  version: '1.1.0',
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
  const style = resolveCharcoalHorrorStyle(scene.styleOverrides);
  if (scene.styleVersion !== CHARCOAL_HORROR_STYLE.version)
    throw new TypeError(
      `Unsupported charcoal_horror style version "${scene.styleVersion}"; available version is "${CHARCOAL_HORROR_STYLE.version}"`,
    );
  if (scene.animationLibraryVersion !== SEMANTIC_ANIMATION_LIBRARY_VERSION)
    throw new TypeError(
      `Unsupported semantic animation library version "${scene.animationLibraryVersion}"; available version is "${SEMANTIC_ANIMATION_LIBRARY_VERSION}"`,
    );
  const entities = new Set([
    ...scene.layers.map((layer) => layer.id),
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
  const withoutHash = {
    version: SCENE_COMPILER_VERSION,
    shotId: shot.id,
    durationFrames: shot.durationFrames,
    frameRate,
    animationLibraryVersion: scene.animationLibraryVersion,
    styleVersion: scene.styleVersion,
    style,
    environment: scene.environment,
    groups: [...scene.groups].sort((left, right) =>
      compareStrings(left.id, right.id),
    ),
    layers: [...scene.layers].sort(
      (left, right) =>
        left.order - right.order ||
        left.transform.position.y - right.transform.position.y ||
        compareStrings(left.id, right.id),
    ),
    characters: [...scene.characters]
      .map((character) => ({
        ...character,
        actions: [...character.actions].sort(
          (left, right) =>
            left.startFrame - right.startFrame ||
            compareStrings(left.id, right.id),
        ),
      }))
      .sort((left, right) => compareStrings(left.id, right.id)),
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
