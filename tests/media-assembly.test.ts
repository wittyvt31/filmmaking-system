import { spawn } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
  canonicalJsonSha256,
  parseProjectManifest,
} from '@filmmaking/contracts';
import {
  ASSEMBLY_IMPLEMENTATION_VERSION,
  createAssemblyFingerprint,
  FfmpegMediaEngine,
} from '@filmmaking/media';
import { compileTimeline } from '@filmmaking/timeline';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'filmmaking-assembly-order-'));
  temporaryDirectories.push(directory);
  return directory;
}

function run(
  executable: string,
  args: string[],
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, { windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', rejectRun);
    child.once('close', (code) => {
      if (code !== 0) {
        rejectRun(
          new Error(
            `Process exited with code ${String(code)}: ${Buffer.concat(stderr).toString('utf8')}`,
          ),
        );
        return;
      }
      resolveRun({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

async function projectForShotCount(count: number) {
  const sample = JSON.parse(
    await readFile(resolve('examples/demo/manifest.json'), 'utf8'),
  ) as {
    shots: Record<string, unknown>[];
    timeline: Record<string, unknown>;
  } & Record<string, unknown>;
  const sourceShot = sample.shots[0];
  if (!sourceShot) throw new Error('Demo manifest has no sample shot.');
  const video = sample['video'] as Record<string, unknown>;
  const renderPolicy = sample['renderPolicy'] as Record<string, unknown>;
  const outputDimensions = (renderPolicy['outputDimensions'] ?? {}) as Record<
    string,
    unknown
  >;
  const resolution = (video['resolution'] ?? {}) as Record<string, unknown>;
  resolution['width'] = 64;
  resolution['height'] = 64;
  outputDimensions['width'] = 64;
  outputDimensions['height'] = 64;
  video['resolution'] = resolution;
  renderPolicy['outputDimensions'] = outputDimensions;
  const shots = Array.from({ length: count }, (_, index) => {
    const shot = structuredClone(sourceShot);
    shot['id'] = `shot.test-${index + 1}`;
    shot['durationFrames'] = 30;
    const composition = shot['composition'] as Record<string, unknown>;
    composition['camera'] = { type: 'static' };
    for (const element of shot['visualElements'] as Record<string, unknown>[])
      element['animation'] = { type: 'static' };
    return shot;
  });
  sample.shots = shots;
  sample.timeline = {
    durationFrames: count * 30,
    videoTracks: [
      {
        id: 'video.main',
        clips: shots.map((shot, index) => ({
          shotId: shot['id'] as string,
          startFrame: index * 30,
        })),
      },
    ],
    audioTracks: [],
    transitions: [],
  };
  return parseProjectManifest(sample);
}

const colors = ['red', 'lime', 'blue', 'yellow', 'magenta'] as const;
const rgbColors: Record<
  (typeof colors)[number],
  readonly [number, number, number]
> = {
  red: [255, 0, 0],
  lime: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  magenta: [255, 0, 255],
};

async function createSolidBitmap(path: string, color: string): Promise<void> {
  const [red, green, blue] = rgbColors[color as (typeof colors)[number]]!;
  const pixelBytes = 64 * 64 * 3;
  const bitmap = Buffer.alloc(54 + pixelBytes);
  bitmap.write('BM', 0, 'ascii');
  bitmap.writeUInt32LE(bitmap.length, 2);
  bitmap.writeUInt32LE(54, 10);
  bitmap.writeUInt32LE(40, 14);
  bitmap.writeInt32LE(64, 18);
  bitmap.writeInt32LE(64, 22);
  bitmap.writeUInt16LE(1, 26);
  bitmap.writeUInt16LE(24, 28);
  bitmap.writeUInt32LE(pixelBytes, 34);
  for (let offset = 54; offset < bitmap.length; offset += 3) {
    bitmap[offset] = blue;
    bitmap[offset + 1] = green;
    bitmap[offset + 2] = red;
  }
  await writeFile(path, bitmap);
}

async function createColorClip(
  path: string,
  color: string,
  frames = 30,
): Promise<void> {
  const ffmpegPath = process.env['FILMIE_FFMPEG'] ?? 'ffmpeg';
  const rgb: Record<string, readonly [number, number, number]> = {
    red: [255, 0, 0],
    lime: [0, 255, 0],
    blue: [0, 0, 255],
    yellow: [255, 255, 0],
    magenta: [255, 0, 255],
  };
  const components = rgb[color];
  if (!components) throw new Error(`Unknown test color: ${color}`);
  const stillPath = path.replace(/\.mp4$/i, '.png');
  await createSolidBitmap(stillPath, color);
  await run(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `nullsrc=s=64x64:r=30,geq=r=${components[0]}:g=${components[1]}:b=${components[2]}`,
    '-frames:v',
    String(frames),
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    '-an',
    '-y',
    path,
  ]);
}

async function centerPixel(path: string, seconds: number): Promise<Buffer> {
  const ffmpegPath = process.env['FILMIE_FFMPEG'] ?? 'ffmpeg';
  const { stdout: png } = await run(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(seconds),
    '-i',
    path,
    '-frames:v',
    '1',
    '-vf',
    'scale=1:1,format=rgb24',
    '-c:v',
    'png',
    '-pred',
    'none',
    '-f',
    'image2pipe',
    'pipe:1',
  ]);
  const compressed: Buffer[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT')
      compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const pixels = inflateSync(Buffer.concat(compressed));
  if (pixels[0] !== 0) throw new Error('Expected an unfiltered one-pixel PNG.');
  return pixels.subarray(1, 4);
}

function colorDistance(left: Buffer, right: Buffer): number {
  return Math.max(
    Math.abs(left[0]! - right[0]!),
    Math.abs(left[1]! - right[1]!),
    Math.abs(left[2]! - right[2]!),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('FFmpeg timeline video assembly', () => {
  it('invalidates image-sequence encoding cache when glow or grade changes', async () => {
    const manifest = await projectForShotCount(1);
    const frames = [{ path: 'frame_000001.png', sha256: 'a'.repeat(64) }];
    const original = canonicalJsonSha256({
      frames,
      policy: manifest.renderPolicy,
      implementationVersion: 'ffmpeg',
    });
    const changed = canonicalJsonSha256({
      frames,
      policy: {
        ...manifest.renderPolicy,
        qualityPostProcessing: { final: { glow: true } },
      },
      implementationVersion: 'ffmpeg',
    });
    expect(changed).not.toBe(original);
  });

  it('invalidates assembly cache identity when the implementation version changes', async () => {
    const manifest = await projectForShotCount(2);
    const timeline = compileTimeline(manifest);
    const shotArtifacts = manifest.shots.map((shot) => ({
      shotId: shot.id,
      sha256: shot.id.padEnd(64, '0'),
    }));
    const fingerprint = createAssemblyFingerprint({
      manifest,
      timeline,
      shotArtifacts,
      audioAssets: [],
      implementationVersion: ASSEMBLY_IMPLEMENTATION_VERSION,
    });
    const changedFingerprint = createAssemblyFingerprint({
      manifest,
      timeline,
      shotArtifacts,
      audioAssets: [],
      implementationVersion: `${ASSEMBLY_IMPLEMENTATION_VERSION}-next`,
    });

    expect(ASSEMBLY_IMPLEMENTATION_VERSION).toBe('ffmpeg-timeline-v6');
    expect(changedFingerprint).not.toBe(fingerprint);
  });

  it('keeps a hard cut and dissolves the adjacent overlapping clips', async () => {
    const root = await temporaryDirectory();
    const manifest = await projectForShotCount(3);
    manifest.shots.forEach((shot) => {
      shot.durationFrames = 8;
    });
    const track = manifest.timeline.videoTracks[0]!;
    track.clips.forEach((clip, index) => {
      clip.startFrame = [0, 8, 12][index]!;
    });
    manifest.timeline.durationFrames = 20;
    manifest.timeline.transitions = [
      {
        type: 'crossfade',
        trackId: track.id,
        fromShotId: track.clips[1]!.shotId,
        toShotId: track.clips[2]!.shotId,
        durationFrames: 4,
      },
    ];
    const shotArtifacts: Record<string, string> = {};
    for (const [index, shot] of manifest.shots.entries()) {
      const path = join(root, shot.id + '.mp4');
      await createColorClip(path, colors[index]!, 8);
      shotArtifacts[shot.id] = path;
    }
    const outputPath = join(root, 'crossfade.mp4');
    const result = await new FfmpegMediaEngine().assemble({
      manifest,
      timeline: compileTimeline(manifest),
      shotArtifacts,
      assets: [],
      outputPath,
    });
    if (result.status === 'failure') throw new Error(result.error.message);
    expect(result.value.frameCount).toBe(20);
    const beforeCut = await centerPixel(outputPath, 7 / 30);
    const afterCut = await centerPixel(outputPath, 8 / 30);
    const dissolve = await centerPixel(outputPath, 14 / 30);
    const end = await centerPixel(outputPath, 18 / 30);
    expect(beforeCut[0]).toBeGreaterThan(200);
    expect(afterCut[1]).toBeGreaterThan(200);
    expect(dissolve[1]).toBeGreaterThan(50);
    expect(dissolve[2]).toBeGreaterThan(50);
    expect(end[2]).toBeGreaterThan(200);
  }, 30_000);

  it.each([2, 3, 5])(
    'assembles %i distinct inputs once each in compiled timeline order',
    async (shotCount) => {
      const root = await temporaryDirectory();
      const manifest = await projectForShotCount(shotCount);
      const timeline = compileTimeline(manifest);
      const shotArtifacts: Record<string, string> = {};
      const sourcePixels: Buffer[] = [];

      for (const [index, shot] of manifest.shots.entries()) {
        const path = join(root, `${shot.id}.mp4`);
        await createColorClip(path, colors[index]!);
        shotArtifacts[shot.id] = path;
        sourcePixels.push(await centerPixel(path, 0.5));
      }

      const outputPath = join(root, 'assembled.mp4');
      const result = await new FfmpegMediaEngine({
        ffmpegPath: process.env['FILMIE_FFMPEG'] ?? 'ffmpeg',
        ffprobePath: process.env['FILMIE_FFPROBE'] ?? 'ffprobe',
      }).assemble({
        manifest,
        timeline,
        shotArtifacts,
        assets: [],
        outputPath,
      });

      if (result.status === 'failure') throw new Error(result.error.message);
      expect(result.status).toBe('success');
      expect(result.value.frameCount).toBe(shotCount * 30);

      const outputPixels: Buffer[] = [];
      for (let index = 0; index < shotCount; index += 1)
        outputPixels.push(await centerPixel(outputPath, index + 0.5));

      for (let index = 0; index < shotCount; index += 1) {
        expect(
          colorDistance(outputPixels[index]!, sourcePixels[index]!),
        ).toBeLessThanOrEqual(35);
        for (let previous = 0; previous < index; previous += 1) {
          expect(
            colorDistance(outputPixels[index]!, outputPixels[previous]!),
          ).toBeGreaterThan(80);
          expect(
            colorDistance(outputPixels[index]!, sourcePixels[previous]!),
          ).toBeGreaterThan(80);
        }
      }
    },
    120_000,
  );

  it('encodes verified PNG sequences to the requested shot video profile', async () => {
    const root = await temporaryDirectory();
    const frameDirectory = join(root, 'frames');
    await mkdir(frameDirectory, { recursive: true });
    const sourceImage = resolve(
      'examples/they-have-reached/assets/backgrounds/interior-wide.png',
    );
    await copyFile(sourceImage, join(frameDirectory, 'frame_000001.png'));
    await copyFile(sourceImage, join(frameDirectory, 'frame_000002.png'));
    const manifest = parseProjectManifest(
      JSON.parse(
        await readFile(
          resolve('examples/they-have-reached-blender/manifest.json'),
          'utf8',
        ),
      ) as unknown,
    );
    const outputPath = join(root, 'shot.mp4');
    manifest.renderPolicy.qualityProfile = 'final';
    manifest.renderPolicy.qualityPostProcessing = {
      final: { glow: true, finalGrade: true },
    };
    const result = await new FfmpegMediaEngine({
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
    }).encodeImageSequence({
      inputDirectory: frameDirectory,
      outputPath,
      frameCount: 2,
      policy: manifest.renderPolicy,
    });
    if (result.status === 'failure') throw new Error(result.error.message);
    expect(result.value.frameCount).toBe(2);
    expect(result.value.width).toBe(1280);
    expect(result.value.height).toBe(720);
    expect(result.value.codec).toBe('h264');
    expect(result.value.pixelFormat).toBe('yuv420p');
    expect(result.value.colorProfile).toBe('bt709');
    expect(result.value.colorTransfer).toBe('bt709');
    expect(result.value.colorPrimaries).toBe('bt709');
  });
});
