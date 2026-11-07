import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AssetVersionReferenceSchema,
  canonicalJson,
  canonicalJsonSha256,
  parseProjectManifest,
  type ProjectManifest,
} from '@filmmaking/contracts';
import {
  AssetRegistry,
  AssetRegistryError,
  AssetVersionSchema,
  resolveAssetFiles,
} from '@filmmaking/assets';
import { compileTimeline } from '@filmmaking/timeline';
import { prepareProductionPlan } from '@filmmaking/planner';
import { createAssemblyFingerprint } from '@filmmaking/media';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let assetDirectory: string;
let imagePath: string;
let audioPath: string;

const imageBytes = Buffer.from('prepared image bytes');
const audioBytes = Buffer.from('prepared audio bytes');
const imageHash = createHash('sha256').update(imageBytes).digest('hex');
const audioHash = createHash('sha256').update(audioBytes).digest('hex');

function imageAsset(sourceUri = pathToFileURL(imagePath).href) {
  return {
    assetId: 'image.hero',
    version: '1.0.0',
    type: 'image',
    sourceUri,
    contentHash: imageHash,
    metadata: { width: 1920, height: 1080, labels: ['prepared', 'reference'] },
    license: { name: 'Test license', restrictions: ['internal use'] },
    provenance: {
      source: 'local test fixture',
      attribution: 'Test fixture author',
      acquiredAt: '2026-01-02T03:04:05Z',
    },
  } as const;
}

function audioAsset(sourceUri = pathToFileURL(audioPath).href) {
  return {
    assetId: 'audio.ambience',
    version: '2.1.0',
    type: 'audio',
    sourceUri,
    contentHash: audioHash,
    metadata: { durationFrames: 1200 },
    license: { name: 'Test license', restrictions: [] },
    provenance: { source: 'local test fixture' },
  } as const;
}

function registry(): AssetRegistry {
  return new AssetRegistry([imageAsset(), audioAsset()]);
}

function manifest(): ProjectManifest {
  const hero = { assetId: 'image.hero', version: '1.0.0' };
  const ambience = { assetId: 'audio.ambience', version: '2.1.0' };
  return {
    projectId: 'project.sample',
    version: '1.0.0',
    video: {
      resolution: { width: 1920, height: 1080 },
      frameRate: { numerator: 30000, denominator: 1001 },
    },
    renderPolicy: {
      outputDimensions: { width: 1920, height: 1080 },
      frameRate: { numerator: 30000, denominator: 1001 },
      codec: 'h264',
      container: 'mp4',
      pixelFormat: 'yuv420p',
      colorProfile: 'bt709',
      quality: { mode: 'crf', value: 18 },
      renderer: {
        id: 'remotion',
        config: { compositionId: 'PreparedShot', concurrency: 2 },
      },
    },
    shots: [
      {
        id: 'shot.open',
        durationFrames: 10,
        visualDescription:
          'A prepared wide landscape image in cool morning light.',
        composition: {
          framing: 'Wide shot',
          subjectPlacement: 'Horizon on the upper third',
          cameraMovement: 'Locked-off',
          instructions: ['Preserve the source image crop'],
        },
        requiredAssets: [hero],
        audioCues: [
          {
            id: 'cue.roomtone',
            asset: ambience,
            trackId: 'audio.main',
            offsetFrames: 2,
            durationFrames: 3,
            sourceOffsetFrames: 0,
          },
        ],
      },
      {
        id: 'shot.detail',
        durationFrames: 8,
        visualDescription: 'A prepared close view of water moving over stones.',
        composition: {
          framing: 'Close-up',
          subjectPlacement: 'Primary detail centered',
          cameraMovement: 'Slow push-in',
          instructions: [],
        },
        requiredAssets: [hero],
      },
      {
        id: 'shot.finish',
        durationFrames: 6,
        visualDescription: 'A prepared still frame of the same location.',
        composition: {
          framing: 'Medium-wide shot',
          subjectPlacement: 'Subject right of center',
          cameraMovement: 'Locked-off',
          instructions: ['Keep the frame level'],
        },
        requiredAssets: [hero],
      },
    ],
    timeline: {
      durationFrames: 30,
      videoTracks: [
        {
          id: 'video.main',
          clips: [
            { shotId: 'shot.open', startFrame: 0 },
            { shotId: 'shot.detail', startFrame: 12 },
            { shotId: 'shot.finish', startFrame: 17 },
          ],
        },
      ],
      audioTracks: [{ id: 'audio.main' }],
      transitions: [
        {
          type: 'crossfade',
          trackId: 'video.main',
          fromShotId: 'shot.detail',
          toShotId: 'shot.finish',
          durationFrames: 3,
        },
      ],
    },
  };
}

function mutableManifest(): Record<string, unknown> {
  return structuredClone(manifest()) as unknown as Record<string, unknown>;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
    );
  }
  return value;
}

beforeEach(async () => {
  assetDirectory = await mkdtemp(join(tmpdir(), 'filmmaking-plan-'));
  imagePath = join(assetDirectory, 'hero.png');
  audioPath = join(assetDirectory, 'ambience.wav');
  await Promise.all([
    writeFile(imagePath, imageBytes),
    writeFile(audioPath, audioBytes),
  ]);
});

afterEach(async () => {
  await rm(assetDirectory, { recursive: true, force: true });
});

describe('manifest validation and planning', () => {
  it('accepts a valid three-shot project and produces a deterministic plan', async () => {
    const prepared = await prepareProductionPlan(
      manifest(),
      registry(),
      assetDirectory,
    );

    expect(prepared.manifest.shots).toHaveLength(3);
    expect(prepared.assets.map((asset) => asset.assetId)).toEqual([
      'audio.ambience',
      'image.hero',
    ]);
    expect(prepared.timeline.videoTracks[0]?.clips).toEqual([
      { shotId: 'shot.open', startFrame: 0, endFrame: 10 },
      { shotId: 'shot.detail', startFrame: 12, endFrame: 20 },
      { shotId: 'shot.finish', startFrame: 17, endFrame: 23 },
    ]);
    expect(prepared.timeline.videoTracks[0]?.gaps).toEqual([
      { startFrame: 10, endFrame: 12 },
      { startFrame: 23, endFrame: 30 },
    ]);
    expect(prepared.timeline.videoTracks[0]?.overlaps).toEqual([
      {
        fromId: 'shot.detail',
        toId: 'shot.finish',
        startFrame: 17,
        endFrame: 20,
        transition: manifest().timeline.transitions[0],
      },
    ]);
    expect(prepared.timeline.audioTracks[0]?.clips[0]).toMatchObject({
      cueId: 'cue.roomtone',
      startFrame: 2,
      endFrame: 5,
      sourceOffsetFrames: 0,
    });
    expect(prepared.renderPlan.shotsToRender).toEqual([
      'shot.open',
      'shot.detail',
      'shot.finish',
    ]);
    expect(prepared.renderPlan.jobs).toHaveLength(4);
    expect(prepared.renderPlan.jobs[0]).toMatchObject({
      kind: 'render-shot',
      durationFrames: 10,
      inputAssets: [{ assetId: 'image.hero', version: '1.0.0' }],
      renderer: { id: 'remotion' },
      dependsOn: [],
    });
    expect(prepared.renderPlan.jobs[3]).toMatchObject({
      kind: 'assemble-project',
      renderer: { id: 'ffmpeg' },
      inputAssets: [{ assetId: 'audio.ambience', version: '2.1.0' }],
      dependsOn: [
        'render-shot:shot.open',
        'render-shot:shot.detail',
        'render-shot:shot.finish',
      ],
    });

    const repeat = await prepareProductionPlan(
      manifest(),
      registry(),
      assetDirectory,
    );
    expect(repeat.timeline.sha256).toBe(prepared.timeline.sha256);
    expect(compileTimeline(manifest()).sha256).toBe(prepared.timeline.sha256);
    expect(repeat.renderPlan.sha256).toBe(prepared.renderPlan.sha256);
  });

  it('rejects a missing shot ID', () => {
    const input = mutableManifest();
    const shots = input.shots as Record<string, unknown>[];
    delete shots[0]?.id;
    expect(() => parseProjectManifest(input)).toThrow();
  });

  it('rejects duplicate shot IDs', () => {
    const input = mutableManifest();
    const shots = input.shots as Record<string, unknown>[];
    shots[1] = { ...shots[1], id: 'shot.open' };
    expect(() => parseProjectManifest(input)).toThrow(/Duplicate shot ID/);
  });

  it('requires exact registered asset versions', async () => {
    const input = manifest();
    const newerImageVersion = { ...imageAsset(), version: '1.0.1' };
    await expect(
      prepareProductionPlan(
        input,
        new AssetRegistry([audioAsset(), newerImageVersion]),
        assetDirectory,
      ),
    ).rejects.toMatchObject({
      code: 'ASSET_VERSION_NOT_FOUND',
      asset: { assetId: 'image.hero', version: '1.0.0' },
    });
  });

  it('rejects invalid or non-reduced frame rates', () => {
    const input = mutableManifest();
    const video = input.video as Record<string, unknown>;
    video.frameRate = { numerator: 60, denominator: 2 };
    const policy = input.renderPolicy as Record<string, unknown>;
    policy.frameRate = { numerator: 60, denominator: 2 };
    expect(() => parseProjectManifest(input)).toThrow(/lowest terms/);

    video.frameRate = { numerator: 0, denominator: 1 };
    expect(() => parseProjectManifest(input)).toThrow();
  });

  it('rejects zero and negative shot durations', () => {
    const input = mutableManifest();
    const shots = input.shots as Record<string, unknown>[];
    shots[0] = { ...shots[0], durationFrames: 0 };
    expect(() => parseProjectManifest(input)).toThrow();

    shots[0] = { ...shots[0], durationFrames: -1 };
    expect(() => parseProjectManifest(input)).toThrow();
  });

  it('rejects clips outside declared timeline boundaries', () => {
    const input = mutableManifest();
    const timeline = input.timeline as Record<string, unknown>;
    const tracks = timeline.videoTracks as Record<string, unknown>[];
    const clips = tracks[0]?.clips as Record<string, unknown>[];
    clips[0] = { ...clips[0], startFrame: -1 };
    expect(() => parseProjectManifest(input)).toThrow();

    clips[0] = { ...clips[0], startFrame: 25 };
    expect(() => parseProjectManifest(input)).toThrow(
      /within timeline duration/,
    );
  });

  it('rejects missing asset files and hash mismatches', async () => {
    const missingUri = pathToFileURL(
      join(assetDirectory, 'not-present.png'),
    ).href;
    const missingRegistry = new AssetRegistry([imageAsset(missingUri)]);
    await expect(
      resolveAssetFiles(
        [
          AssetVersionReferenceSchema.parse({
            assetId: 'image.hero',
            version: '1.0.0',
          }),
        ],
        missingRegistry,
        assetDirectory,
      ),
    ).rejects.toMatchObject({ code: 'ASSET_FILE_NOT_FOUND' });

    const wrongHash = { ...imageAsset(), contentHash: '0'.repeat(64) };
    const hashRegistry = new AssetRegistry([wrongHash]);
    await expect(
      resolveAssetFiles(
        [{ assetId: 'image.hero', version: '1.0.0' }],
        hashRegistry,
        assetDirectory,
      ),
    ).rejects.toMatchObject({ code: 'ASSET_HASH_MISMATCH' });
  });

  it('accepts an absolute Windows asset path containing spaces', async () => {
    const spacedDirectory = join(assetDirectory, 'asset path with spaces');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(spacedDirectory);
    const spacedPath = join(spacedDirectory, 'hero image.png');
    await writeFile(spacedPath, imageBytes);
    const windowsRegistry = new AssetRegistry([imageAsset(spacedPath)]);

    const resolved = await resolveAssetFiles(
      [{ assetId: 'image.hero', version: '1.0.0' }],
      windowsRegistry,
      assetDirectory,
    );
    expect(resolved[0]?.localPath).toBe(spacedPath);
  });

  it('rejects unsupported renderer configurations and invalid transitions', () => {
    const unsupportedRenderer = mutableManifest();
    const policy = unsupportedRenderer.renderPolicy as Record<string, unknown>;
    policy.renderer = {
      id: 'remotion',
      config: { compositionId: 'PreparedShot', unknownSetting: true },
    };
    expect(() => parseProjectManifest(unsupportedRenderer)).toThrow();

    const incompatibleCodec = mutableManifest();
    const incompatiblePolicy = incompatibleCodec.renderPolicy as Record<
      string,
      unknown
    >;
    incompatiblePolicy.codec = 'prores';
    incompatiblePolicy.container = 'mp4';
    expect(() => parseProjectManifest(incompatibleCodec)).toThrow(
      /Container is not supported by the selected codec/,
    );

    const invalidTransition = mutableManifest();
    const timeline = invalidTransition.timeline as Record<string, unknown>;
    timeline.transitions = [
      {
        type: 'wipe',
        trackId: 'video.main',
        fromShotId: 'shot.detail',
        toShotId: 'shot.finish',
        durationFrames: 3,
        direction: 'diagonal',
      },
    ];
    expect(() => parseProjectManifest(invalidTransition)).toThrow();
  });

  it('requires explicit transitions for overlaps and rejects invalid transition boundaries', () => {
    const input = mutableManifest();
    const timeline = input.timeline as Record<string, unknown>;
    timeline.transitions = [];
    expect(() => parseProjectManifest(input)).toThrow(
      /requires an explicit transition/,
    );

    timeline.transitions = [
      {
        type: 'crossfade',
        trackId: 'video.main',
        fromShotId: 'shot.detail',
        toShotId: 'shot.finish',
        durationFrames: 2,
      },
    ];
    expect(() => parseProjectManifest(input)).toThrow(/exactly match/);
  });

  it('ends a transition at the shorter clip boundary', () => {
    const input = manifest();
    input.shots[2]!.durationFrames = 2;
    input.timeline.transitions[0] = {
      ...input.timeline.transitions[0]!,
      durationFrames: 2,
    };

    expect(compileTimeline(input).videoTracks[0]?.transitions[0]).toMatchObject(
      {
        startFrame: 17,
        endFrame: 19,
        durationFrames: 2,
      },
    );
  });

  it('compiles multiple video tracks and supports projects without audio tracks', () => {
    const input = manifest();
    input.timeline.videoTracks = [
      { id: 'video.main', clips: [{ shotId: 'shot.open', startFrame: 0 }] },
      {
        id: 'video.detail',
        clips: [
          { shotId: 'shot.detail', startFrame: 12 },
          { shotId: 'shot.finish', startFrame: 17 },
        ],
      },
    ];
    input.timeline.transitions = [
      {
        ...input.timeline.transitions[0]!,
        trackId: 'video.detail',
      },
    ];
    input.timeline.audioTracks = [];
    delete input.shots[0]!.audioCues;

    const compiled = compileTimeline(input);
    expect(compiled.videoTracks).toHaveLength(2);
    expect(compiled.videoTracks[1]?.overlaps).toHaveLength(1);
    expect(compiled.audioTracks).toEqual([]);
  });

  it('includes creative instructions and render settings in render-plan identity', async () => {
    const first = await prepareProductionPlan(
      manifest(),
      registry(),
      assetDirectory,
    );
    const changed = manifest();
    changed.renderPolicy.quality = { mode: 'crf', value: 20 };

    const second = await prepareProductionPlan(
      changed,
      registry(),
      assetDirectory,
    );
    expect(second.renderPlan.sha256).not.toBe(first.renderPlan.sha256);
    expect(second.renderPlan.renderPolicy.quality).toEqual({
      mode: 'crf',
      value: 20,
    });
  });

  it('invalidates assembly identity for transition-only changes', () => {
    const firstManifest = manifest();
    const firstTimeline = compileTimeline(firstManifest);
    const shotArtifacts = firstManifest.shots.map((shot) => ({
      shotId: shot.id,
      sha256: createHash('sha256').update(shot.id).digest('hex'),
    }));
    const firstFingerprint = createAssemblyFingerprint({
      timeline: firstTimeline,
      manifest: firstManifest,
      shotArtifacts,
      audioAssets: [],
    });

    const changedManifest = manifest();
    changedManifest.timeline.transitions[0] = {
      type: 'wipe',
      trackId: 'video.main',
      fromShotId: 'shot.detail',
      toShotId: 'shot.finish',
      durationFrames: 3,
      direction: 'left',
    };
    const secondFingerprint = createAssemblyFingerprint({
      timeline: compileTimeline(changedManifest),
      manifest: changedManifest,
      shotArtifacts,
      audioAssets: [],
    });

    expect(secondFingerprint).not.toBe(firstFingerprint);
    expect(shotArtifacts).toEqual(
      firstManifest.shots.map((shot) => ({
        shotId: shot.id,
        sha256: createHash('sha256').update(shot.id).digest('hex'),
      })),
    );
  });

  it('does not replace an immutable asset version', () => {
    const version = AssetVersionSchema.parse(imageAsset());
    const assetRegistry = new AssetRegistry([version]);
    let caught: unknown;
    try {
      assetRegistry.register({ ...version, sourceUri: 'other.png' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AssetRegistryError);
    expect(caught).toMatchObject({ code: 'ASSET_VERSION_EXISTS' });
  });

  it('canonicalizes equivalent manifests to identical RFC 8785 JSON and hashes', () => {
    const first = manifest();
    const second = reverseObjectKeys(first);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(canonicalJsonSha256(first)).toBe(canonicalJsonSha256(second));
    expect(() => canonicalJson({ omitted: undefined })).toThrow(/undefined/);
  });

  it('rejects invalid asset registry license and SHA-256 metadata', () => {
    expect(() =>
      AssetVersionSchema.parse({ ...imageAsset(), contentHash: 'bad' }),
    ).toThrow();
    expect(() =>
      AssetVersionSchema.parse({
        ...imageAsset(),
        license: { name: 'license', extra: 'unsupported' },
      }),
    ).toThrow();
  });
});
