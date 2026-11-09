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

function makeVideo(directory: string, source: string, label: string) {
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
});
