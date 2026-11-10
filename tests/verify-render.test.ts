import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function makeVideo(
  directory: string,
  source: string,
  label: string,
  audio?: string,
) {
  const output = join(directory, `${label}.mp4`);
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      source,
      ...(audio ? ['-f', 'lavfi', '-i', audio, '-c:a', 'aac'] : []),
      '-t',
      '0.1',
      '-r',
      '30',
      '-pix_fmt',
      'yuv420p',
      '-y',
      output,
    ],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(0);
  return output;
}

function verify(video: string, manifest: string, extra: string[] = []) {
  return spawnSync(
    process.execPath,
    [
      resolve('scripts/verify-render.mjs'),
      video,
      '--manifest',
      manifest,
      ...extra,
    ],
    { encoding: 'utf8' },
  );
}

describe('render visual verification', () => {
  it('requires audible audio of the timeline duration when cues are authored', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filmie-verify-audio-'));
    temporary.push(directory);
    const manifest = join(directory, 'manifest.json');
    await writeFile(
      manifest,
      JSON.stringify({
        timeline: { durationFrames: 3 },
        video: { frameRate: { numerator: 30, denominator: 1 } },
        shots: [{ audioCues: [{ id: 'room-tone' }] }],
      }),
    );
    const source = 'testsrc2=s=320x180:r=30';
    for (const [name, audio, failure] of [
      ['missing', undefined, 'Missing audio stream'],
      ['silent', 'anullsrc=r=48000', 'Audio RMS is below'],
      [
        'short',
        'sine=frequency=440:sample_rate=48000:duration=0.03',
        'Audio duration differs',
      ],
      ['audible', 'sine=frequency=440:sample_rate=48000', undefined],
    ] as const) {
      const result = verify(
        makeVideo(directory, source, name, audio),
        manifest,
      );
      if (failure) {
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain(failure);
      } else expect(result.status, result.stderr || result.stdout).toBe(0);
    }
  }, 30_000);
  it('rejects uniform gray output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filmie-verify-gray-'));
    temporary.push(directory);
    const manifest = join(directory, 'manifest.json');
    await writeFile(
      manifest,
      JSON.stringify({
        timeline: { durationFrames: 3 },
        video: { frameRate: { numerator: 30, denominator: 1 } },
      }),
    );
    const result = verify(
      makeVideo(directory, 'color=c=gray:s=320x180', 'gray'),
      manifest,
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('near-uniform frames');
  });

  it('rejects static output when motion is expected but allows intentional static imagery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'filmie-verify-static-'));
    temporary.push(directory);
    const video = makeVideo(
      directory,
      'color=c=black:s=320x180,drawbox=x=20:y=20:w=100:h=100:color=white:t=fill',
      'static',
    );
    const manifest = join(directory, 'manifest.json');
    await writeFile(
      manifest,
      JSON.stringify({
        timeline: { durationFrames: 3 },
        video: { frameRate: { numerator: 30, denominator: 1 } },
      }),
    );
    const moving = verify(video, manifest, [
      '--expect-motion',
      '--identical-ratio',
      '0.1',
    ]);
    expect(moving.status).not.toBe(0);
    const staticAllowed = verify(video, manifest, ['--static-ok']);
    expect(staticAllowed.status).toBe(0);
  }, 30_000);

  it('accepts cumulative image change when adjacent-frame motion is below its configured threshold', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'filmie-verify-cumulative-'),
    );
    temporary.push(directory);
    const manifest = join(directory, 'manifest.json');
    await writeFile(
      manifest,
      JSON.stringify({
        timeline: { durationFrames: 3 },
        video: { frameRate: { numerator: 30, denominator: 1 } },
      }),
    );
    const result = verify(
      makeVideo(directory, 'testsrc2=s=320x180:r=30', 'moving'),
      manifest,
      [
        '--expect-motion',
        '--motion-difference',
        '1',
        '--net-motion-difference',
        '0.005',
      ],
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as { netFrameDifference: number };
    expect(report.netFrameDifference).toBeGreaterThan(0.005);
  }, 30_000);
});
