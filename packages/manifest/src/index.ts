import {
  canonicalJsonSha256,
  compareStrings,
  PreparedScreenplaySchema,
  ProjectManifestSchema,
  type ProjectManifest,
} from '@filmmaking/contracts';

export function compilePreparedScreenplay(input: unknown): {
  manifest: ProjectManifest;
  sourceFingerprint: string;
} {
  const screenplay = PreparedScreenplaySchema.parse(input);
  const shots = screenplay.scenes.flatMap((scene) => scene.shots);
  const timeline =
    screenplay.timeline ??
    (() => {
      let cursor = 0;
      const clips = shots.map((shot) => {
        const clip = { shotId: shot.id, startFrame: cursor };
        cursor += shot.durationFrames;
        return clip;
      });
      const audioTrackIds = [
        ...new Set(
          shots.flatMap((shot) =>
            (shot.audioCues ?? []).map((cue) => cue.trackId),
          ),
        ),
      ].sort(compareStrings);
      return {
        durationFrames: cursor,
        videoTracks: [{ id: screenplay.videoTrackId, clips }],
        audioTracks: audioTrackIds.map((id) => ({ id })),
        transitions: [],
      };
    })();
  const manifest = ProjectManifestSchema.parse({
    projectId: screenplay.projectId,
    version: screenplay.version,
    video: screenplay.video,
    renderPolicy: screenplay.renderPolicy,
    shots,
    timeline,
  });
  return { manifest, sourceFingerprint: canonicalJsonSha256(screenplay) };
}

export {
  PreparedScreenplaySchema,
  ProjectManifestSchema,
  RenderPolicySchema,
  parseProjectManifest,
  type ProjectManifest,
  type RenderPolicy,
  type Shot,
} from '@filmmaking/contracts';
