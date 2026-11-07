import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { dirname, extname, join, resolve } from 'node:path';
import {
  canonicalJsonSha256,
  compareStrings,
  type ProjectManifest,
  type RenderPolicy,
} from '@filmmaking/contracts';
import type { CompiledTimeline } from '@filmmaking/timeline';

export const ASSEMBLY_IMPLEMENTATION_VERSION = 'ffmpeg-timeline-v5';

export interface MediaAssetInput {
  assetId: string;
  version: string;
  localPath: string;
  contentHash: string;
}

export interface MediaAssemblyRequest {
  manifest: ProjectManifest;
  timeline: CompiledTimeline;
  shotArtifacts: Readonly<Record<string, string>>;
  assets: readonly MediaAssetInput[];
  outputPath: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ImageSequenceEncodingRequest {
  inputDirectory: string;
  outputPath: string;
  frameCount: number;
  policy: RenderPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface MediaInspection {
  path: string;
  durationSeconds: number;
  frameCount: number;
  width: number;
  height: number;
  frameRate: number;
  codec: string;
  pixelFormat: string;
  colorProfile: string;
  colorTransfer: string;
  colorPrimaries: string;
  audioStreamCount: number;
  sha256: string;
  bytes: number;
}

export type MediaOperationResult<T> =
  | { status: 'success'; value: T }
  | {
      status: 'failure';
      error: { code: string; message: string; retryable: boolean };
      logs: string[];
    };

export interface MediaEngine {
  readonly identity: { id: 'ffmpeg'; version: string };
  assemble(
    request: MediaAssemblyRequest,
  ): Promise<
    MediaOperationResult<
      MediaInspection & { logs: string[]; durationMs: number }
    >
  >;
  encodeImageSequence(
    request: ImageSequenceEncodingRequest,
  ): Promise<
    MediaOperationResult<
      MediaInspection & { logs: string[]; durationMs: number }
    >
  >;
  inspect(
    path: string,
    expected: { frames: number; policy: RenderPolicy },
    binaries?: { ffprobePath?: string },
  ): Promise<MediaOperationResult<MediaInspection>>;
}

interface SpawnResult {
  code: number;
  stdout: string;
  stderr: string;
  logs: string[];
}

export class MediaEngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'MediaEngineError';
  }
}

function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      hash.update(buffer);
    });
    stream.on('error', reject);
    stream.on('end', () =>
      resolvePromise({ sha256: hash.digest('hex'), bytes }),
    );
  });
}

async function promoteFile(
  temporaryPath: string,
  outputPath: string,
): Promise<void> {
  try {
    await rename(temporaryPath, outputPath);
  } catch (initialError) {
    const backupPath = `${outputPath}.previous-${randomUUID()}`;
    try {
      const existing = await lstat(outputPath);
      if (!existing.isFile() || existing.isSymbolicLink()) throw initialError;
      await rename(outputPath, backupPath);
    } catch {
      throw initialError;
    }
    try {
      await rename(temporaryPath, outputPath);
    } catch (promotionError) {
      await rename(backupPath, outputPath);
      throw promotionError;
    }
    await rm(backupPath, { force: true });
  }
}

function spawnCapture(
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; signal?: AbortSignal; maxLogLines?: number },
): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(
        new MediaEngineError(
          'INTERRUPTED',
          'Media operation was interrupted before the process started',
          true,
        ),
      );
      return;
    }
    let stdout = '';
    let stderr = '';
    const logs: string[] = [];
    let finished = false;
    let timeout = false;
    let interrupted = false;
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
    });
    const appendLines = (target: 'stdout' | 'stderr', data: Buffer) => {
      const text = data.toString('utf8');
      if (target === 'stdout') stdout = `${stdout}${text}`.slice(-1_000_000);
      else stderr = `${stderr}${text}`.slice(-1_000_000);
      for (const line of text.split(/\r?\n/)) {
        if (line && logs.length < (options.maxLogLines ?? 500)) logs.push(line);
      }
    };
    child.stdout.on('data', (data: Buffer) => appendLines('stdout', data));
    child.stderr.on('data', (data: Buffer) => appendLines('stderr', data));
    const timer = setTimeout(() => {
      timeout = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, options.timeoutMs);
    const onAbort = () => {
      interrupted = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.once('error', (error) => {
      cleanup();
      reject(
        new MediaEngineError(
          'EXECUTABLE_NOT_FOUND',
          `Could not start ${executable}: ${error.message}`,
        ),
      );
    });
    child.once('close', (code) => {
      cleanup();
      if (timeout) {
        reject(
          new MediaEngineError(
            'TIMEOUT',
            `Process exceeded ${options.timeoutMs} ms`,
            true,
          ),
        );
      } else if (interrupted) {
        reject(
          new MediaEngineError(
            'INTERRUPTED',
            'Media operation was interrupted',
            true,
          ),
        );
      } else if (code !== 0) {
        reject(
          new MediaEngineError(
            'PROCESS_FAILED',
            `${executable} exited with code ${String(code)}: ${stderr.slice(-4000)}`,
            true,
          ),
        );
      } else {
        resolvePromise({ code: code ?? 0, stdout, stderr, logs });
      }
    });
  });
}

function rate(policy: RenderPolicy): string {
  return `${policy.frameRate.numerator}/${policy.frameRate.denominator}`;
}

function seconds(frames: number, policy: RenderPolicy): string {
  const value =
    (frames * policy.frameRate.denominator) / policy.frameRate.numerator;
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

function validateTimeline(request: MediaAssemblyRequest): void {
  if (request.timeline.videoTracks.length !== 1) {
    throw new MediaEngineError(
      'UNSUPPORTED_TIMELINE',
      'FFmpeg MVP supports exactly one video track; multiple video tracks are not silently flattened.',
    );
  }
  const track = request.timeline.videoTracks[0];
  if (!track)
    throw new MediaEngineError(
      'INVALID_TIMELINE',
      'Compiled timeline has no video track.',
    );
  if (track.overlaps.length || track.transitions.length) {
    throw new MediaEngineError(
      'UNSUPPORTED_TRANSITION',
      'Timeline transitions and overlapping video clips are not implemented by this assembly engine. Remove them or use a renderer that supports transitions.',
    );
  }
  if (
    request.timeline.audioTracks.some(
      (audioTrack) => audioTrack.overlaps.length,
    )
  ) {
    throw new MediaEngineError(
      'UNSUPPORTED_AUDIO_OVERLAP',
      'Overlapping cues on a single audio track are unsupported; separate them across audio tracks.',
    );
  }
  for (const transition of request.manifest.timeline.transitions) {
    if (!['crossfade', 'wipe', 'dip-to-color'].includes(transition.type)) {
      throw new MediaEngineError(
        'UNSUPPORTED_TRANSITION',
        `Unsupported transition type: ${transition.type}`,
      );
    }
  }
}

function buildAssemblyArgs(
  request: MediaAssemblyRequest,
  temporaryPath: string,
  gapClipPaths: ReadonlyMap<number, string>,
): string[] {
  const { manifest, timeline } = request;
  const policy = manifest.renderPolicy;
  validateTimeline(request);
  if (
    policy.codec !== 'h264' ||
    policy.container !== 'mp4' ||
    policy.pixelFormat !== 'yuv420p' ||
    policy.colorProfile !== 'bt709'
  ) {
    throw new MediaEngineError(
      'UNSUPPORTED_OUTPUT_PROFILE',
      'FFmpeg MVP assembly requires H.264 MP4, yuv420p, and Rec.709.',
    );
  }
  const videoTrack = timeline.videoTracks[0];
  if (!videoTrack)
    throw new MediaEngineError(
      'INVALID_TIMELINE',
      'Compiled timeline has no video track.',
    );
  const inputArgs: string[] = [];
  const filterSegments: string[] = [];
  const orderedSegments: string[] = [];
  let inputIndex = 0;
  let cursor = 0;
  let segmentIndex = 0;
  const appendGap = (gapFrames: number) => {
    if (gapFrames <= 0) return;
    const gapPath = gapClipPaths.get(cursor);
    if (!gapPath)
      throw new MediaEngineError(
        'INVALID_TIMELINE',
        `Missing generated black gap clip at frame ${cursor}.`,
      );
    inputArgs.push('-i', gapPath);
    const label = `v${segmentIndex}`;
    filterSegments.push(`[${inputIndex}:v]null[${label}]`);
    orderedSegments.push(`[${label}]`);
    inputIndex += 1;
    segmentIndex += 1;
  };

  for (const clip of videoTrack.clips) {
    if (clip.startFrame < cursor)
      throw new MediaEngineError(
        'UNSUPPORTED_TRANSITION',
        `Clip ${clip.shotId} overlaps the preceding clip.`,
      );
    appendGap(clip.startFrame - cursor);
    const artifact = request.shotArtifacts[clip.shotId];
    if (!artifact)
      throw new MediaEngineError(
        'MISSING_SHOT',
        `Rendered clip is missing for shot ${clip.shotId}.`,
      );
    inputArgs.push('-i', resolve(artifact));
    const label = `v${segmentIndex}`;
    filterSegments.push(`[${inputIndex}:v]null[${label}]`);
    orderedSegments.push(`[${label}]`);
    inputIndex += 1;
    segmentIndex += 1;
    cursor = clip.endFrame;
  }
  appendGap(timeline.durationFrames - cursor);
  if (!orderedSegments.length)
    throw new MediaEngineError(
      'INVALID_TIMELINE',
      'Video track contains no renderable segments.',
    );
  const audioLabels: string[] = [];
  let audioInputIndex = inputIndex;
  for (const track of timeline.audioTracks) {
    for (const cue of track.clips) {
      const asset = request.assets.find(
        (candidate) =>
          candidate.assetId === cue.asset.assetId &&
          candidate.version === cue.asset.version,
      );
      if (!asset)
        throw new MediaEngineError(
          'MISSING_AUDIO_ASSET',
          `Missing audio asset ${cue.asset.assetId}@${cue.asset.version} for cue ${cue.cueId}.`,
        );
      inputArgs.push('-i', resolve(asset.localPath));
      const label = `a${audioLabels.length}`;
      const start = seconds(cue.sourceOffsetFrames, policy);
      const duration = seconds(cue.endFrame - cue.startFrame, policy);
      const delayMs = Math.round(
        (cue.startFrame * 1000 * policy.frameRate.denominator) /
          policy.frameRate.numerator,
      );
      filterSegments.push(
        `[${audioInputIndex}:a]atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1,apad,atrim=duration=${seconds(timeline.durationFrames, policy)}[${label}]`,
      );
      audioLabels.push(`[${label}]`);
      audioInputIndex += 1;
    }
  }
  const videoFilter = `${orderedSegments.join('')}concat=n=${orderedSegments.length}:v=1:a=0[vout];[vout]colorspace=all=bt709:iprimaries=bt709:itrc=bt709:ispace=bt709:irange=tv[v709]`;
  if (audioLabels.length > 1)
    filterSegments.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0,apad,atrim=duration=${seconds(timeline.durationFrames, policy)}[aout]`,
    );

  const args = ['-hide_banner', '-loglevel', 'error', ...inputArgs];
  const filters = [...filterSegments, videoFilter];
  args.push('-filter_complex', filters.join(';'), '-map', '[v709]');
  if (audioLabels.length)
    args.push(
      '-map',
      audioLabels.length === 1 ? audioLabels[0]! : '[aout]',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-ar',
      '48000',
    );
  else args.push('-an');
  args.push(
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
    '-r',
    rate(policy),
    '-frames:v',
    String(timeline.durationFrames),
  );
  if (policy.quality.mode === 'crf')
    args.push('-crf', String(policy.quality.value));
  else if (policy.quality.mode === 'bitrate')
    args.push('-b:v', String(policy.quality.bitsPerSecond));
  else args.push('-crf', '0', '-preset', 'veryslow');
  args.push('-movflags', '+faststart', '-y', temporaryPath);
  return args;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function blackPng(width: number, height: number): Buffer {
  const rowBytes = width * 4 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    pixels[rowStart] = 0;
    for (let x = 0; x < width; x += 1) pixels[rowStart + 1 + x * 4 + 3] = 255;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function timelineGaps(
  timeline: CompiledTimeline,
): { startFrame: number; durationFrames: number }[] {
  const track = timeline.videoTracks[0];
  if (!track) return [];
  const gaps: { startFrame: number; durationFrames: number }[] = [];
  let cursor = 0;
  for (const clip of track.clips) {
    if (clip.startFrame > cursor)
      gaps.push({
        startFrame: cursor,
        durationFrames: clip.startFrame - cursor,
      });
    cursor = Math.max(cursor, clip.endFrame);
  }
  if (cursor < timeline.durationFrames)
    gaps.push({
      startFrame: cursor,
      durationFrames: timeline.durationFrames - cursor,
    });
  return gaps;
}

async function createBlackGapClip(
  ffmpegPath: string,
  workDirectory: string,
  gapIndex: number,
  durationFrames: number,
  policy: RenderPolicy,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const { width, height } = policy.outputDimensions;
  const stillPath = join(workDirectory, `black-${width}x${height}.png`);
  const outputPath = join(workDirectory, `gap-${gapIndex}.mp4`);
  await writeFile(stillPath, blackPng(width, height));
  await spawnCapture(
    ffmpegPath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-framerate',
      rate(policy),
      '-i',
      stillPath,
      '-frames:v',
      String(durationFrames),
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
      '-r',
      rate(policy),
      '-an',
      '-y',
      outputPath,
    ],
    { timeoutMs, ...(signal ? { signal } : {}) },
  );
  return outputPath;
}

export class FfmpegMediaEngine implements MediaEngine {
  readonly identity = {
    id: 'ffmpeg' as const,
    version: ASSEMBLY_IMPLEMENTATION_VERSION,
  };
  readonly ffmpegPath: string;
  readonly ffprobePath: string;

  constructor(binaries: { ffmpegPath?: string; ffprobePath?: string } = {}) {
    this.ffmpegPath =
      binaries.ffmpegPath ?? process.env['FILMIE_FFMPEG'] ?? 'ffmpeg';
    this.ffprobePath =
      binaries.ffprobePath ?? process.env['FILMIE_FFPROBE'] ?? 'ffprobe';
  }

  async inspect(
    pathInput: string,
    expected: { frames: number; policy: RenderPolicy },
    binaries: { ffprobePath?: string } = {},
  ): Promise<MediaOperationResult<MediaInspection>> {
    const path = resolve(pathInput);
    try {
      const probe = await spawnCapture(
        binaries.ffprobePath ?? this.ffprobePath,
        [
          '-v',
          'error',
          '-count_frames',
          '-show_entries',
          'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt,color_space,color_transfer,color_primaries,nb_read_frames',
          '-of',
          'json',
          path,
        ],
        { timeoutMs: 30_000, maxLogLines: 100 },
      );
      const parsed = JSON.parse(probe.stdout) as {
        format?: { duration?: string };
        streams?: {
          codec_type?: string;
          codec_name?: string;
          width?: number;
          height?: number;
          avg_frame_rate?: string;
          pix_fmt?: string;
          color_space?: string;
          color_transfer?: string;
          color_primaries?: string;
          nb_read_frames?: string;
        }[];
      };
      const streams = parsed.streams ?? [];
      const video = streams.find((stream) => stream.codec_type === 'video');
      if (!video || !parsed.format?.duration)
        throw new MediaEngineError(
          'INVALID_MEDIA',
          `FFprobe did not find a video stream in ${path}.`,
        );
      const [fpsNum, fpsDen] = (video.avg_frame_rate ?? '0/1')
        .split('/')
        .map(Number);
      const frameRate = (fpsNum ?? 0) / (fpsDen || 1);
      const frameCount = Number(
        video.nb_read_frames ??
          Math.round(Number(parsed.format.duration) * frameRate),
      );
      const fileHash = await hashFile(path);
      const info: MediaInspection = {
        path,
        durationSeconds: Number(parsed.format.duration),
        frameCount,
        width: video.width ?? 0,
        height: video.height ?? 0,
        frameRate,
        codec: video.codec_name ?? 'unknown',
        pixelFormat: video.pix_fmt ?? 'unknown',
        colorProfile: video.color_space ?? 'unknown',
        colorTransfer: video.color_transfer ?? 'unknown',
        colorPrimaries: video.color_primaries ?? 'unknown',
        audioStreamCount: streams.filter(
          (stream) => stream.codec_type === 'audio',
        ).length,
        ...fileHash,
      };
      const policy = expected.policy;
      const failures: string[] = [];
      if (info.frameCount !== expected.frames)
        failures.push(
          `expected ${expected.frames} frames, found ${info.frameCount}`,
        );
      if (
        info.width !== policy.outputDimensions.width ||
        info.height !== policy.outputDimensions.height
      )
        failures.push(
          `expected ${policy.outputDimensions.width}x${policy.outputDimensions.height}, found ${info.width}x${info.height}`,
        );
      if (
        Math.abs(
          info.frameRate -
            policy.frameRate.numerator / policy.frameRate.denominator,
        ) > 0.0001
      )
        failures.push(`expected ${rate(policy)} FPS, found ${info.frameRate}`);
      if (info.codec !== 'h264')
        failures.push(`expected H.264, found ${info.codec}`);
      if (info.pixelFormat !== policy.pixelFormat)
        failures.push(
          `expected ${policy.pixelFormat}, found ${info.pixelFormat}`,
        );
      if (info.colorProfile !== policy.colorProfile)
        failures.push(
          `expected ${policy.colorProfile}, found ${info.colorProfile}`,
        );
      if (policy.colorProfile === 'bt709') {
        if (info.colorTransfer !== 'bt709')
          failures.push(`expected bt709 transfer, found ${info.colorTransfer}`);
        if (info.colorPrimaries !== 'bt709')
          failures.push(
            `expected bt709 primaries, found ${info.colorPrimaries}`,
          );
      }
      if (failures.length)
        throw new MediaEngineError(
          'MEDIA_VALIDATION_FAILED',
          failures.join('; '),
        );
      return { status: 'success', value: info };
    } catch (error) {
      return { status: 'failure', error: toFailure(error), logs: [] };
    }
  }

  async encodeImageSequence(
    request: ImageSequenceEncodingRequest,
  ): Promise<
    MediaOperationResult<
      MediaInspection & { logs: string[]; durationMs: number }
    >
  > {
    const started = Date.now();
    const inputDirectory = resolve(request.inputDirectory);
    const outputPath = resolve(request.outputPath);
    const temporaryPath = join(
      dirname(outputPath),
      `.${randomUUID()}.partial${extname(outputPath) || '.mp4'}`,
    );
    let logs: string[] = [];
    try {
      if (!Number.isSafeInteger(request.frameCount) || request.frameCount < 1)
        throw new MediaEngineError(
          'INVALID_SEQUENCE',
          'PNG sequence frame count must be a positive safe integer.',
        );
      const policy = request.policy;
      if (
        policy.codec !== 'h264' ||
        policy.container !== 'mp4' ||
        policy.pixelFormat !== 'yuv420p' ||
        policy.colorProfile !== 'bt709'
      ) {
        throw new MediaEngineError(
          'UNSUPPORTED_OUTPUT_PROFILE',
          'PNG sequence encoding requires H.264 MP4, yuv420p, and Rec.709.',
        );
      }
      await mkdir(dirname(outputPath), { recursive: true });
      const inputPattern = join(inputDirectory, 'frame_%06d.png');
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-framerate',
        rate(policy),
        '-start_number',
        '1',
        '-i',
        inputPattern,
        '-vf',
        `scale=w=${policy.outputDimensions.width}:h=${policy.outputDimensions.height}:force_original_aspect_ratio=increase,crop=w=${policy.outputDimensions.width}:h=${policy.outputDimensions.height},colorspace=all=bt709:iall=bt709:iprimaries=bt709:itrc=iec61966-2-1:irange=pc:range=tv`,
        '-frames:v',
        String(request.frameCount),
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
        '-r',
        rate(policy),
      ];
      if (policy.quality.mode === 'crf')
        args.push('-crf', String(policy.quality.value));
      else if (policy.quality.mode === 'bitrate')
        args.push('-b:v', String(policy.quality.bitsPerSecond));
      else args.push('-crf', '0', '-preset', 'veryslow');
      args.push('-movflags', '+faststart', '-y', temporaryPath);
      const spawned = await spawnCapture(this.ffmpegPath, args, {
        timeoutMs: request.timeoutMs ?? 10 * 60 * 1000,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      logs = spawned.logs;
      const file = await stat(temporaryPath);
      if (!file.isFile() || file.size === 0)
        throw new MediaEngineError(
          'INCOMPLETE_OUTPUT',
          'FFmpeg produced no complete shot video from the PNG sequence.',
          true,
        );
      const inspected = await this.inspect(temporaryPath, {
        frames: request.frameCount,
        policy,
      });
      if (inspected.status === 'failure')
        throw new MediaEngineError(
          inspected.error.code,
          inspected.error.message,
          inspected.error.retryable,
        );
      await promoteFile(temporaryPath, outputPath);
      return {
        status: 'success',
        value: {
          ...inspected.value,
          path: outputPath,
          logs,
          durationMs: Date.now() - started,
        },
      };
    } catch (error) {
      return { status: 'failure', error: toFailure(error), logs };
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async assemble(
    request: MediaAssemblyRequest,
  ): Promise<
    MediaOperationResult<
      MediaInspection & { logs: string[]; durationMs: number }
    >
  > {
    const started = Date.now();
    const outputPath = resolve(request.outputPath);
    const temporaryPath = join(
      dirname(outputPath),
      `.${randomUUID()}.partial${extname(outputPath) || '.mp4'}`,
    );
    const workDirectory = join(
      dirname(outputPath),
      `.assembly-${randomUUID()}`,
    );
    let logs: string[] = [];
    try {
      validateTimeline(request);
      await mkdir(dirname(outputPath), { recursive: true });
      await mkdir(workDirectory, { recursive: true });
      const ffmpegPath = request.ffmpegPath ?? this.ffmpegPath;
      const gapClipPaths = new Map<number, string>();
      for (const [index, gap] of timelineGaps(request.timeline).entries()) {
        const path = await createBlackGapClip(
          ffmpegPath,
          workDirectory,
          index,
          gap.durationFrames,
          request.manifest.renderPolicy,
          request.timeoutMs ?? 10 * 60 * 1000,
          request.signal,
        );
        gapClipPaths.set(gap.startFrame, path);
      }
      const args = buildAssemblyArgs(request, temporaryPath, gapClipPaths);
      const spawned = await spawnCapture(ffmpegPath, args, {
        timeoutMs: request.timeoutMs ?? 10 * 60 * 1000,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      logs = spawned.logs;
      const file = await stat(temporaryPath);
      if (!file.isFile() || file.size === 0)
        throw new MediaEngineError(
          'INCOMPLETE_OUTPUT',
          'FFmpeg produced no complete output file.',
          true,
        );
      const inspected = await this.inspect(
        temporaryPath,
        {
          frames: request.timeline.durationFrames,
          policy: request.manifest.renderPolicy,
        },
        {
          ...(request.ffprobePath ? { ffprobePath: request.ffprobePath } : {}),
        },
      );
      if (inspected.status === 'failure')
        throw new MediaEngineError(
          inspected.error.code,
          inspected.error.message,
          inspected.error.retryable,
        );
      await promoteFile(temporaryPath, outputPath);
      return {
        status: 'success',
        value: {
          ...inspected.value,
          path: outputPath,
          logs,
          durationMs: Date.now() - started,
        },
      };
    } catch (error) {
      return { status: 'failure', error: toFailure(error), logs };
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      await rm(workDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

function toFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof MediaEngineError)
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  return {
    code: 'MEDIA_ERROR',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

export function createAssemblyFingerprint(input: {
  timeline: CompiledTimeline;
  manifest: ProjectManifest;
  shotArtifacts: readonly { shotId: string; sha256: string }[];
  audioAssets: readonly {
    assetId: string;
    version: string;
    contentHash: string;
  }[];
  implementationVersion?: string;
}): string {
  return canonicalJsonSha256({
    timeline: input.timeline,
    shotArtifacts: [...input.shotArtifacts].sort((a, b) =>
      compareStrings(a.shotId, b.shotId),
    ),
    transitions: input.manifest.timeline.transitions,
    composition: input.manifest.shots.map((shot) => ({
      shotId: shot.id,
      composition: shot.composition,
    })),
    audioAssets: [...input.audioAssets].sort((a, b) =>
      compareStrings(`${a.assetId}@${a.version}`, `${b.assetId}@${b.version}`),
    ),
    outputProfile: {
      dimensions: input.manifest.renderPolicy.outputDimensions,
      frameRate: input.manifest.renderPolicy.frameRate,
      codec: input.manifest.renderPolicy.codec,
      container: input.manifest.renderPolicy.container,
      pixelFormat: input.manifest.renderPolicy.pixelFormat,
      colorProfile: input.manifest.renderPolicy.colorProfile,
      quality: input.manifest.renderPolicy.quality,
    },
    implementationVersion:
      input.implementationVersion ?? ASSEMBLY_IMPLEMENTATION_VERSION,
  });
}
