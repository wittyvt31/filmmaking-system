import {
  compareStrings,
  canonicalJsonSha256,
  parseProjectManifest,
  type ProjectManifest,
  type Transition,
} from '@filmmaking/contracts';

export interface FrameInterval {
  startFrame: number;
  endFrame: number;
}

export interface CompiledVideoClip extends FrameInterval {
  shotId: string;
}

export interface CompiledAudioClip extends FrameInterval {
  cueId: string;
  shotId: string;
  asset: ProjectManifest['shots'][number]['requiredAssets'][number];
  sourceOffsetFrames: number;
  category?: NonNullable<
    ProjectManifest['shots'][number]['audioCues']
  >[number]['category'];
  speakerId?: string;
  text?: string;
  lipSyncActionId?: string;
}

export interface CompiledOverlap extends FrameInterval {
  fromId: string;
  toId: string;
  transition?: Transition;
}

export interface CompiledVideoTrack {
  id: string;
  clips: CompiledVideoClip[];
  gaps: FrameInterval[];
  overlaps: CompiledOverlap[];
  transitions: (Transition & FrameInterval)[];
}

export interface CompiledAudioTrack {
  id: string;
  clips: CompiledAudioClip[];
  gaps: FrameInterval[];
  overlaps: CompiledOverlap[];
}

export interface CompiledTimeline {
  projectId: string;
  frameRate: ProjectManifest['video']['frameRate'];
  durationFrames: number;
  videoTracks: CompiledVideoTrack[];
  audioTracks: CompiledAudioTrack[];
  sha256: string;
}

function calculateGaps(
  clips: readonly FrameInterval[],
  durationFrames: number,
): FrameInterval[] {
  const gaps: FrameInterval[] = [];
  let cursor = 0;
  for (const clip of clips) {
    if (clip.startFrame > cursor)
      gaps.push({ startFrame: cursor, endFrame: clip.startFrame });
    cursor = Math.max(cursor, clip.endFrame);
  }
  if (cursor < durationFrames)
    gaps.push({ startFrame: cursor, endFrame: durationFrames });
  return gaps;
}

function findOverlaps<T extends FrameInterval>(
  clips: readonly T[],
  getId: (clip: T) => string,
  transitions?: ReadonlyMap<string, Transition>,
): CompiledOverlap[] {
  const overlaps: CompiledOverlap[] = [];
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
      const fromId = getId(left);
      const toId = getId(right);
      const overlap = {
        fromId,
        toId,
        startFrame: right.startFrame,
        endFrame: Math.min(left.endFrame, right.endFrame),
      };
      const transition = transitions?.get(`${fromId}\u0000${toId}`);
      overlaps.push(transition ? { ...overlap, transition } : overlap);
    }
  }
  return overlaps;
}

export function compileTimeline(input: unknown): CompiledTimeline {
  const manifest = parseProjectManifest(input);
  const shotOrder = new Map(
    manifest.shots.map((shot, index) => [shot.id, index]),
  );
  const shotById = new Map(manifest.shots.map((shot) => [shot.id, shot]));
  const placementByShot = new Map<string, number>();
  const transitionsByTrack = new Map<string, Map<string, Transition>>();

  for (const track of manifest.timeline.videoTracks) {
    for (const clip of track.clips)
      placementByShot.set(clip.shotId, clip.startFrame);
  }
  for (const transition of manifest.timeline.transitions) {
    const transitions =
      transitionsByTrack.get(transition.trackId) ??
      new Map<string, Transition>();
    transitions.set(
      `${transition.fromShotId}\u0000${transition.toShotId}`,
      transition,
    );
    transitionsByTrack.set(transition.trackId, transitions);
  }

  const videoTracks: CompiledVideoTrack[] = manifest.timeline.videoTracks.map(
    (track) => {
      const clips = track.clips
        .map((clip) => {
          const shot = shotById.get(clip.shotId);
          if (!shot)
            throw new Error(`Validated manifest lost shot "${clip.shotId}"`);
          return {
            shotId: shot.id,
            startFrame: clip.startFrame,
            endFrame: clip.startFrame + shot.durationFrames,
            order: shotOrder.get(shot.id) ?? Number.MAX_SAFE_INTEGER,
          };
        })
        .sort(
          (left, right) =>
            left.startFrame - right.startFrame ||
            left.order - right.order ||
            compareStrings(left.shotId, right.shotId),
        );
      const publicClips = clips.map(({ shotId, startFrame, endFrame }) => ({
        shotId,
        startFrame,
        endFrame,
      }));
      const transitions = [
        ...(transitionsByTrack.get(track.id)?.values() ?? []),
      ]
        .map((transition) => {
          const from = publicClips.find(
            (clip) => clip.shotId === transition.fromShotId,
          );
          const to = publicClips.find(
            (clip) => clip.shotId === transition.toShotId,
          );
          if (!from || !to)
            throw new Error('Validated manifest lost a transition clip');
          return {
            ...transition,
            startFrame: to.startFrame,
            endFrame: Math.min(from.endFrame, to.endFrame),
          };
        })
        .sort(
          (left, right) =>
            left.startFrame - right.startFrame ||
            compareStrings(left.fromShotId, right.fromShotId),
        );
      const transitionMap =
        transitionsByTrack.get(track.id) ?? new Map<string, Transition>();
      return {
        id: track.id,
        clips: publicClips,
        gaps: calculateGaps(publicClips, manifest.timeline.durationFrames),
        overlaps: findOverlaps(
          publicClips,
          (clip) => clip.shotId,
          transitionMap,
        ),
        transitions,
      };
    },
  );

  const cuesByTrack = new Map<string, CompiledAudioClip[]>();
  for (const shot of manifest.shots) {
    const shotStart = placementByShot.get(shot.id);
    if (shotStart === undefined) continue;
    for (const cue of shot.audioCues ?? []) {
      const clips = cuesByTrack.get(cue.trackId) ?? [];
      clips.push({
        cueId: cue.id,
        shotId: shot.id,
        asset: cue.asset,
        sourceOffsetFrames: cue.sourceOffsetFrames,
        ...(cue.category ? { category: cue.category } : {}),
        ...(cue.speakerId ? { speakerId: cue.speakerId } : {}),
        ...(cue.text ? { text: cue.text } : {}),
        ...(cue.lipSyncActionId
          ? { lipSyncActionId: cue.lipSyncActionId }
          : {}),
        startFrame: shotStart + cue.offsetFrames,
        endFrame: shotStart + cue.offsetFrames + cue.durationFrames,
      });
      cuesByTrack.set(cue.trackId, clips);
    }
  }
  const audioTracks: CompiledAudioTrack[] = manifest.timeline.audioTracks.map(
    (track) => {
      const clips = [...(cuesByTrack.get(track.id) ?? [])].sort(
        (left, right) =>
          left.startFrame - right.startFrame ||
          compareStrings(left.cueId, right.cueId),
      );
      return {
        id: track.id,
        clips,
        gaps: calculateGaps(clips, manifest.timeline.durationFrames),
        overlaps: findOverlaps(clips, (clip) => clip.cueId),
      };
    },
  );

  const timelineWithoutHash = {
    projectId: manifest.projectId,
    frameRate: manifest.video.frameRate,
    durationFrames: manifest.timeline.durationFrames,
    videoTracks,
    audioTracks,
  };
  return {
    ...timelineWithoutHash,
    sha256: canonicalJsonSha256(timelineWithoutHash),
  };
}
