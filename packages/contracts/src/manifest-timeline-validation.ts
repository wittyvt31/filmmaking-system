import type {
  ManifestRefinementContext,
  ProjectManifestData,
} from './project-manifest-shape.js';

export function validateManifestTimelinePlacements(
  manifest: ProjectManifestData,
  context: ManifestRefinementContext,
) {
  const issue = (path: (string | number)[], message: string) => {
    context.addIssue({ code: 'custom', path, message });
  };
  const shotById = new Map<string, (typeof manifest.shots)[number]>();
  manifest.shots.forEach((shot, index) => {
    if (shotById.has(shot.id)) {
      issue(['shots', index, 'id'], `Duplicate shot ID "${shot.id}"`);
    } else {
      shotById.set(shot.id, shot);
    }
  });

  const trackIds = new Set<string>();
  manifest.timeline.videoTracks.forEach((track, index) => {
    if (trackIds.has(track.id))
      issue(
        ['timeline', 'videoTracks', index, 'id'],
        `Duplicate track ID "${track.id}"`,
      );
    trackIds.add(track.id);
  });
  manifest.timeline.audioTracks.forEach((track, index) => {
    if (trackIds.has(track.id))
      issue(
        ['timeline', 'audioTracks', index, 'id'],
        `Duplicate track ID "${track.id}"`,
      );
    trackIds.add(track.id);
  });

  const clipsByShot = new Map<
    string,
    { trackId: string; startFrame: number; endFrame: number; index: number }[]
  >();
  const clipsByTrack = new Map<
    string,
    { shotId: string; startFrame: number; endFrame: number; index: number }[]
  >();
  manifest.timeline.videoTracks.forEach((track, trackIndex) => {
    const clips = clipsByTrack.get(track.id) ?? [];
    track.clips.forEach((clip, clipIndex) => {
      const shot = shotById.get(clip.shotId);
      if (!shot) {
        issue(
          ['timeline', 'videoTracks', trackIndex, 'clips', clipIndex, 'shotId'],
          `Unknown shot ID "${clip.shotId}"`,
        );
        return;
      }
      const endFrame = clip.startFrame + shot.durationFrames;
      if (
        !Number.isSafeInteger(endFrame) ||
        endFrame > manifest.timeline.durationFrames
      ) {
        issue(
          ['timeline', 'videoTracks', trackIndex, 'clips', clipIndex],
          'Clip end must be within timeline duration',
        );
      }
      clips.push({
        shotId: clip.shotId,
        startFrame: clip.startFrame,
        endFrame,
        index: clipIndex,
      });
      const placements = clipsByShot.get(clip.shotId) ?? [];
      placements.push({
        trackId: track.id,
        startFrame: clip.startFrame,
        endFrame,
        index: clipIndex,
      });
      clipsByShot.set(clip.shotId, placements);
    });
    clipsByTrack.set(track.id, clips);
  });

  for (const [shotId, shot] of shotById) {
    const placements = clipsByShot.get(shotId) ?? [];
    if (placements.length !== 1) {
      issue(
        ['shots', manifest.shots.indexOf(shot), 'id'],
        `Shot "${shotId}" must appear exactly once on a video track`,
      );
    }
  }
  return { clipsByTrack, clipsByShot };
}

export function validateManifestTimelineTransitions(
  manifest: ProjectManifestData,
  context: ManifestRefinementContext,
  clipMaps: ReturnType<typeof validateManifestTimelinePlacements>,
): void {
  const issue = (path: (string | number)[], message: string) => {
    context.addIssue({ code: 'custom', path, message });
  };
  const { clipsByTrack } = clipMaps;
  const transitions = new Map<
    string,
    (typeof manifest.timeline.transitions)[number]
  >();
  manifest.timeline.transitions.forEach((transition, index) => {
    const key = `${transition.trackId}\u0000${transition.fromShotId}\u0000${transition.toShotId}`;
    if (transitions.has(key))
      issue(
        ['timeline', 'transitions', index],
        'Duplicate transition for the same shot pair',
      );
    transitions.set(key, transition);
    const clips = clipsByTrack.get(transition.trackId);
    const from = clips?.find((clip) => clip.shotId === transition.fromShotId);
    const to = clips?.find((clip) => clip.shotId === transition.toShotId);
    if (!from || !to) {
      issue(
        ['timeline', 'transitions', index],
        'Transition shots must exist on the referenced video track',
      );
      return;
    }
    const overlapFrames =
      Math.min(from.endFrame, to.endFrame) -
      Math.max(from.startFrame, to.startFrame);
    if (
      from.startFrame >= to.startFrame ||
      overlapFrames !== transition.durationFrames
    ) {
      issue(
        ['timeline', 'transitions', index],
        'Transition duration must exactly match a forward overlap between its shots',
      );
    }
  });

  manifest.timeline.videoTracks.forEach((track, trackIndex) => {
    const clips = [...(clipsByTrack.get(track.id) ?? [])].sort(
      (left, right) =>
        left.startFrame - right.startFrame || left.index - right.index,
    );
    for (let leftIndex = 0; leftIndex < clips.length; leftIndex += 1) {
      const left = clips[leftIndex];
      if (!left) continue;
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < clips.length;
        rightIndex += 1
      ) {
        const right = clips[rightIndex];
        if (!right || right.startFrame >= left.endFrame) break;
        const key = `${track.id}\u0000${left.shotId}\u0000${right.shotId}`;
        if (!transitions.has(key)) {
          issue(
            ['timeline', 'videoTracks', trackIndex, 'clips', right.index],
            `Overlap between "${left.shotId}" and "${right.shotId}" requires an explicit transition`,
          );
        }
      }
    }
  });

  if (
    manifest.video.resolution.width !==
      manifest.renderPolicy.outputDimensions.width ||
    manifest.video.resolution.height !==
      manifest.renderPolicy.outputDimensions.height
  ) {
    issue(
      ['renderPolicy', 'outputDimensions'],
      'Render output dimensions must match global video settings',
    );
  }
  if (
    manifest.video.frameRate.numerator !==
      manifest.renderPolicy.frameRate.numerator ||
    manifest.video.frameRate.denominator !==
      manifest.renderPolicy.frameRate.denominator
  ) {
    issue(
      ['renderPolicy', 'frameRate'],
      'Render frame rate must match global video settings',
    );
  }
}
