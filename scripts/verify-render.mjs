#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 36;
const args = process.argv.slice(2);
const inputArgument = args.shift();
if (!inputArgument) {
  process.stderr.write(
    'Usage: node scripts/verify-render.mjs <mp4-or-frame-directory> [--manifest <manifest.json>] [--ffmpeg <path>] [--ffprobe <path>]\n',
  );
  process.exit(2);
}
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value) throw new Error(`Missing value for ${name}`);
  args.splice(index, 2);
  return value;
}
const manifestOption = option('--manifest');
const ffmpeg = option('--ffmpeg', process.env.FILMIE_FFMPEG ?? 'ffmpeg');
const ffprobe = option('--ffprobe', process.env.FILMIE_FFPROBE ?? 'ffprobe');
const input = resolve(inputArgument);

function run(command, commandArgs, { allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (!allowFailure && code !== 0)
        reject(
          new Error(
            `${command} exited ${code ?? signal}: ${result.stderr.trim()}`,
          ),
        );
      else resolvePromise(result);
    });
  });
}
async function locateManifest() {
  if (manifestOption) return resolve(manifestOption);
  let current = input;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, 'manifest.json');
    try {
      await readFile(candidate);
      return candidate;
    } catch {}
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('Could not locate manifest.json; pass --manifest <path>.');
}
async function sourceArgs(framePattern, fps) {
  return [
    '-f',
    'image2',
    '-framerate',
    String(fps),
    '-start_number',
    '1',
    '-i',
    framePattern,
  ];
}
async function main() {
  const manifestPath = await locateManifest();
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const expectedFrames = manifest.timeline?.durationFrames;
  const fpsNum = manifest.video?.frameRate?.numerator;
  const fpsDen = manifest.video?.frameRate?.denominator;
  if (
    !Number.isSafeInteger(expectedFrames) ||
    !Number.isSafeInteger(fpsNum) ||
    !Number.isSafeInteger(fpsDen) ||
    fpsNum < 1 ||
    fpsDen < 1
  )
    throw new Error(
      'Manifest must define timeline.durationFrames and a positive rational video.frameRate.',
    );
  const fps = fpsNum / fpsDen;
  const info = await (async () => {
    const isDirectory = (await readdir(input).catch(() => null)) !== null;
    let source;
    let probeArgs;
    if (isDirectory) {
      const files = (await readdir(input))
        .filter((name) => /^frame_\d{6}\.png$/i.test(name))
        .sort();
      if (!files.length)
        throw new Error(`No frame_000001.png style sequence found in ${input}`);
      source = {
        kind: 'sequence',
        pattern: join(input, 'frame_%06d.png'),
        files,
      };
      probeArgs = [
        '-v',
        'error',
        '-f',
        'image2',
        '-framerate',
        String(fps),
        '-start_number',
        '1',
        '-i',
        source.pattern,
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,r_frame_rate,nb_read_frames',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
      ];
    } else {
      source = { kind: 'video', path: input };
      probeArgs = [
        '-v',
        'error',
        '-count_frames',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,r_frame_rate,nb_read_frames',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        input,
      ];
    }
    const probed = await run(ffprobe, probeArgs);
    const data = JSON.parse(probed.stdout.toString('utf8'));
    const stream = data.streams?.[0];
    if (!stream) throw new Error('FFprobe found no video stream.');
    const frameCount = Number(stream.nb_read_frames);
    const [rateNum, rateDen] = String(stream.r_frame_rate ?? '0/1')
      .split('/')
      .map(Number);
    return {
      source,
      frameCount,
      width: Number(stream.width),
      height: Number(stream.height),
      frameRate: rateNum / rateDen,
      durationSeconds: Number(data.format?.duration ?? frameCount / fps),
    };
  })();
  if (!Number.isSafeInteger(info.frameCount) || info.frameCount < 1)
    throw new Error('FFprobe did not return a valid decoded frame count.');
  const decoderArgs =
    info.source.kind === 'video'
      ? [
          '-v',
          'error',
          '-i',
          info.source.path,
          '-vf',
          `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:flags=area,format=gray`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'gray',
          'pipe:1',
        ]
      : [
          '-v',
          'error',
          ...(await sourceArgs(info.source.pattern, fps)),
          '-vf',
          `scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:flags=area,format=gray`,
          '-f',
          'rawvideo',
          '-pix_fmt',
          'gray',
          'pipe:1',
        ];
  const decoded = await run(ffmpeg, decoderArgs);
  const frameBytes = FRAME_WIDTH * FRAME_HEIGHT;
  if (decoded.stdout.length !== info.frameCount * frameBytes)
    throw new Error(
      `Decoded ${Math.floor(decoded.stdout.length / frameBytes)} frames; FFprobe counted ${info.frameCount}.`,
    );
  const lumas = [];
  const hashes = [];
  for (let offset = 0; offset < decoded.stdout.length; offset += frameBytes) {
    const frame = decoded.stdout.subarray(offset, offset + frameBytes);
    let sum = 0;
    for (const value of frame) sum += value;
    lumas.push(sum / frameBytes / 255);
    hashes.push(createHash('sha256').update(frame).digest('hex'));
  }
  const differences = [];
  let nearBlackFrames = 0;
  let nearWhiteFrames = 0;
  for (let index = 0; index < lumas.length; index += 1) {
    const luma = lumas[index];
    if (luma < 0.02) nearBlackFrames += 1;
    if (luma > 0.98) nearWhiteFrames += 1;
    if (index > 0) {
      const before = decoded.stdout.subarray(
        (index - 1) * frameBytes,
        index * frameBytes,
      );
      const after = decoded.stdout.subarray(
        index * frameBytes,
        (index + 1) * frameBytes,
      );
      let total = 0;
      for (let pixel = 0; pixel < frameBytes; pixel += 1)
        total += Math.abs(after[pixel] - before[pixel]);
      differences.push(total / frameBytes / 255);
    }
  }
  const sortedDifferences = [...differences].sort((a, b) => a - b);
  const meanFrameDifference =
    differences.reduce((sum, value) => sum + value, 0) /
    Math.max(1, differences.length);
  const identicalConsecutiveFrames = hashes
    .slice(1)
    .reduce((count, hash, index) => count + Number(hash === hashes[index]), 0);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'filmie-verify-'));
  const sampleIndices = Array.from({ length: 6 }, (_, index) =>
    Math.round((index * (info.frameCount - 1)) / 5),
  );
  const samplePaths = [];
  try {
    for (let index = 0; index < sampleIndices.length; index += 1) {
      const frameIndex = sampleIndices[index];
      const outputPath = join(temporaryDirectory, `sample-${index}.png`);
      const extractArgs =
        info.source.kind === 'video'
          ? [
              '-v',
              'error',
              '-i',
              info.source.path,
              '-vf',
              `select=eq(n\\,${frameIndex})`,
              '-fps_mode',
              'passthrough',
              '-frames:v',
              '1',
              '-y',
              outputPath,
            ]
          : [
              '-v',
              'error',
              ...(await sourceArgs(info.source.pattern, fps)),
              '-vf',
              `select=eq(n\\,${frameIndex})`,
              '-fps_mode',
              'passthrough',
              '-frames:v',
              '1',
              '-y',
              outputPath,
            ];
      await run(ffmpeg, extractArgs);
      samplePaths.push(outputPath);
    }
    const contactSheet =
      info.source.kind === 'video'
        ? join(dirname(input), `${basename(input, '.mp4')}.contact-sheet.png`)
        : join(input, 'contact-sheet.png');
    const filters = samplePaths
      .map(
        (_, index) =>
          `[${index}:v]scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1[v${index}]`,
      )
      .join(';');
    const layout = '0_0|640_0|1280_0|0_360|640_360|1280_360';
    const contactArgs = samplePaths.flatMap((path) => ['-i', path]);
    contactArgs.push(
      '-filter_complex',
      `${filters};[v0][v1][v2][v3][v4][v5]xstack=inputs=6:layout=${layout}:fill=black[out]`,
      '-map',
      '[out]',
      '-frames:v',
      '1',
      '-y',
      contactSheet,
    );
    await run(ffmpeg, contactArgs);
    const result = {
      input,
      manifest: manifestPath,
      frameCount: info.frameCount,
      manifestFrameCount: expectedFrames,
      frameCountMatchesManifest: info.frameCount === expectedFrames,
      durationSeconds: Number(info.durationSeconds.toFixed(6)),
      resolution: `${info.width}x${info.height}`,
      frameRate: Number(info.frameRate.toFixed(6)),
      nearBlackFrames,
      nearWhiteFrames,
      meanFrameDifference: Number(meanFrameDifference.toFixed(8)),
      minFrameDifference: Number((sortedDifferences[0] ?? 0).toFixed(8)),
      maxFrameDifference: Number((sortedDifferences.at(-1) ?? 0).toFixed(8)),
      identicalConsecutiveFrames,
      contactSheet,
      lumaSampling: `${FRAME_WIDTH}x${FRAME_HEIGHT} grayscale; exact-identity count uses the same decoded samples`,
    };
    const reportPath =
      info.source.kind === 'video'
        ? join(dirname(input), `${basename(input, '.mp4')}.verify.json`)
        : join(input, 'verify-report.json');
    await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    const blankFrames = nearBlackFrames + nearWhiteFrames;
    if (info.frameCount !== expectedFrames || blankFrames > 0)
      process.exitCode = 1;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
