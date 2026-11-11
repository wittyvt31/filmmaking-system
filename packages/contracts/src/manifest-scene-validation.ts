import type {
  ManifestRefinementContext,
  ProjectManifestData,
} from './project-manifest-shape.js';
import type { validateManifestTimelinePlacements } from './manifest-timeline-validation.js';

export function validateManifestSceneInstructions(
  manifest: ProjectManifestData,
  context: ManifestRefinementContext,
  clipsByShot: ReturnType<
    typeof validateManifestTimelinePlacements
  >['clipsByShot'],
): void {
  const issue = (path: (string | number)[], message: string) => {
    context.addIssue({ code: 'custom', path, message });
  };
  const audioTrackIds = new Set(
    manifest.timeline.audioTracks.map((track) => track.id),
  );
  const cueIds = new Set<string>();
  manifest.shots.forEach((shot, shotIndex) => {
    if (shot.scene) {
      if (manifest.renderPolicy.renderer.id !== 'blender') {
        issue(
          ['shots', shotIndex, 'scene'],
          'Structured scene instructions require the Blender renderer',
        );
      }
      const references = new Set(
        shot.requiredAssets.map(
          (reference) => `${reference.assetId}\u0000${reference.version}`,
        ),
      );
      const sceneReferences = [
        ...(shot.scene.environment ? [shot.scene.environment] : []),
        ...(shot.scene.world?.entities.flatMap(({ geometry }) =>
          geometry.kind === 'asset' ? [geometry.asset] : [],
        ) ?? []),
        ...shot.scene.motionLibraries,
        ...shot.scene.characters.flatMap((character) => {
          const asset = characterAsset(character);
          return asset ? [asset] : [];
        }),
        ...shot.scene.props.map((prop) => prop.asset),
      ];
      for (const reference of sceneReferences) {
        if (!references.has(`${reference.assetId}\u0000${reference.version}`)) {
          issue(
            ['shots', shotIndex, 'scene'],
            `Scene asset ${reference.assetId}@${reference.version} must also appear in requiredAssets`,
          );
        }
      }
      const entityIds = new Set<string>();
      for (const entityId of [
        ...shot.scene.characters.map((character) => character.id),
        ...shot.scene.props.map((prop) => prop.id),
      ]) {
        if (entityIds.has(entityId))
          issue(
            ['shots', shotIndex, 'scene'],
            `Duplicate scene entity ID "${entityId}"`,
          );
        entityIds.add(entityId);
      }
      if (
        shot.scene.camera.type !== 'static' &&
        shot.scene.camera.startFrame + shot.scene.camera.durationFrames >
          shot.durationFrames
      ) {
        issue(
          ['shots', shotIndex, 'scene', 'camera'],
          'Scene camera movement must fit within its shot duration',
        );
      }
      shot.scene.characters.forEach((character, characterIndex) => {
        if ('poses' in character) {
          const { poses } = character;
          const prefix = [
            'shots',
            shotIndex,
            'scene',
            'characters',
            characterIndex,
            'poses',
          ];
          const validateFrames = (
            keys: readonly { frame: number }[],
            path: (number | string)[],
          ) => {
            keys.forEach((key, index) => {
              if (key.frame >= shot.durationFrames)
                issue(
                  [...prefix, ...path, index, 'frame'],
                  'Pose keyframe must be within the shot',
                );
            });
          };
          validateFrames(poses.root, ['root']);
          poses.joints.forEach((track, index) =>
            validateFrames(track.keys, ['joints', index, 'keys']),
          );
        }
        const actionIds = new Set<string>();
        character.actions.forEach((action, actionIndex) => {
          if (actionIds.has(action.id))
            issue(
              [
                'shots',
                shotIndex,
                'scene',
                'characters',
                characterIndex,
                'actions',
                actionIndex,
                'id',
              ],
              `Duplicate character action ID "${action.id}"`,
            );
          actionIds.add(action.id);
          if (
            action.endFrame <= action.startFrame ||
            action.endFrame > shot.durationFrames
          ) {
            issue(
              [
                'shots',
                shotIndex,
                'scene',
                'characters',
                characterIndex,
                'actions',
                actionIndex,
              ],
              'Character action must have a positive interval within the shot',
            );
          }
          if (action.type === 'motion-clip') {
            const libraryKey = `${action.library.assetId}\u0000${action.library.version}`;
            if (
              !shot.scene?.motionLibraries.some(
                (library) =>
                  `${library.assetId}\u0000${library.version}` === libraryKey,
              )
            )
              issue(
                [
                  'shots',
                  shotIndex,
                  'scene',
                  'characters',
                  characterIndex,
                  'actions',
                  actionIndex,
                  'library',
                ],
                'Motion clip library must be pinned in scene.motionLibraries',
              );
          }
          if (
            (action.type === 'head-turn' ||
              action.type === 'interaction' ||
              action.type === 'reach' ||
              action.type === 'grasp' ||
              action.type === 'lift' ||
              action.type === 'place') &&
            !entityIds.has(action.targetEntityId)
          ) {
            issue(
              [
                'shots',
                shotIndex,
                'scene',
                'characters',
                characterIndex,
                'actions',
                actionIndex,
                'targetEntityId',
              ],
              `Unknown scene target "${action.targetEntityId}"`,
            );
          }
          if (
            action.type === 'reach' ||
            action.type === 'grasp' ||
            action.type === 'lift' ||
            action.type === 'place'
          ) {
            const earlierActions = character.actions.slice(0, actionIndex);
            const matching = earlierActions.filter(
              (candidate) =>
                (candidate.type === 'reach' ||
                  candidate.type === 'grasp' ||
                  candidate.type === 'lift' ||
                  candidate.type === 'place') &&
                candidate.effector === action.effector &&
                candidate.targetEntityId === action.targetEntityId,
            );
            const previous = matching.at(-1);
            if (action.type === 'grasp' && previous?.type !== 'reach') {
              issue(
                [
                  'shots',
                  shotIndex,
                  'scene',
                  'characters',
                  characterIndex,
                  'actions',
                  actionIndex,
                ],
                'A grasp must follow a reach to the same target using the same effector',
              );
            }
            if (action.type === 'lift' && previous?.type !== 'grasp') {
              issue(
                [
                  'shots',
                  shotIndex,
                  'scene',
                  'characters',
                  characterIndex,
                  'actions',
                  actionIndex,
                ],
                'A lift must follow a grasp of the same target using the same effector',
              );
            }
            if (action.type === 'place' && previous?.type !== 'lift') {
              issue(
                [
                  'shots',
                  shotIndex,
                  'scene',
                  'characters',
                  characterIndex,
                  'actions',
                  actionIndex,
                ],
                'A place must follow a lift of the same target using the same effector',
              );
            }
          }
        });
      });
    }
    shot.audioCues?.forEach((cue, cueIndex) => {
      if (cueIds.has(cue.id))
        issue(
          ['shots', shotIndex, 'audioCues', cueIndex, 'id'],
          `Duplicate audio cue ID "${cue.id}"`,
        );
      cueIds.add(cue.id);
      if (cue.category === 'dialogue' && (!cue.speakerId || !cue.text)) {
        issue(
          ['shots', shotIndex, 'audioCues', cueIndex],
          'Dialogue cues require both a speaker ID and prepared dialogue text',
        );
      }
      if (cue.category === 'narration' && !cue.text) {
        issue(
          ['shots', shotIndex, 'audioCues', cueIndex, 'text'],
          'Narration cues require prepared narration text',
        );
      }
      if (
        cue.speakerId &&
        !shot.scene?.characters.some(
          (character) => character.id === cue.speakerId,
        )
      ) {
        issue(
          ['shots', shotIndex, 'audioCues', cueIndex, 'speakerId'],
          `Unknown dialogue speaker "${cue.speakerId}"`,
        );
      }
      if (cue.lipSyncActionId) {
        const speaker = shot.scene?.characters.find(
          (character) => character.id === cue.speakerId,
        );
        const action = speaker?.actions.find(
          (candidate) =>
            candidate.id === cue.lipSyncActionId &&
            candidate.type === 'lip-sync',
        );
        if (!action) {
          issue(
            ['shots', shotIndex, 'audioCues', cueIndex, 'lipSyncActionId'],
            `Lip-sync action "${cue.lipSyncActionId}" must belong to the dialogue speaker`,
          );
        } else if (
          action.startFrame > cue.offsetFrames ||
          action.endFrame < cue.offsetFrames + cue.durationFrames
        ) {
          issue(
            ['shots', shotIndex, 'audioCues', cueIndex, 'lipSyncActionId'],
            'Lip-sync action must cover the complete dialogue cue interval',
          );
        }
      }
      if (!audioTrackIds.has(cue.trackId)) {
        issue(
          ['shots', shotIndex, 'audioCues', cueIndex, 'trackId'],
          `Unknown audio track ID "${cue.trackId}"`,
        );
      }
      if (cue.offsetFrames + cue.durationFrames > shot.durationFrames) {
        issue(
          ['shots', shotIndex, 'audioCues', cueIndex],
          'Audio cue must fit within its shot duration',
        );
      }
      const placement = clipsByShot.get(shot.id)?.[0];
      if (
        placement &&
        placement.startFrame + cue.offsetFrames + cue.durationFrames >
          manifest.timeline.durationFrames
      ) {
        issue(
          ['shots', shotIndex, 'audioCues', cueIndex],
          'Audio cue end must be within timeline duration',
        );
      }
    });
  });
}
import { characterAsset } from './character.js';
