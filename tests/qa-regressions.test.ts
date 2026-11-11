import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ArtifactCache } from '@filmmaking/cache';
import { parseProjectManifest } from '@filmmaking/contracts';
import { compileTimeline } from '@filmmaking/timeline';
import { FfmpegMediaEngine } from '@filmmaking/media';
import { cleanProductionFiles } from '@filmmaking/orchestrator';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('QA regression coverage', () => {
  it('repairs a corrupt cache entry for the same fingerprint', async () => {
    const root = await temporaryDirectory('filmmaking-cache-repair-');
    const source = join(root, 'source.mp4');
    const output = join(root, 'restored.mp4');
    const cache = new ArtifactCache(join(root, 'cache'));
    const fingerprint = 'a'.repeat(64);
    await writeFile(source, 'original artifact');
    await cache.store(fingerprint, 'video/mp4', source);

    const metadata = JSON.parse(
      await readFile(join(root, 'cache', fingerprint, 'metadata.json'), 'utf8'),
    ) as { payloadName: string };
    await writeFile(
      join(root, 'cache', fingerprint, metadata.payloadName),
      'corrupt',
    );
    await writeFile(output, 'partial existing output');
    expect(await cache.restore(fingerprint, 'video/mp4', output)).toBeNull();

    await cache.store(fingerprint, 'video/mp4', source);
    const restored = await cache.restore(fingerprint, 'video/mp4', output);
    expect(restored).not.toBeNull();
    expect(await readFile(output, 'utf8')).toBe('original artifact');
  });

  it('rejects cache payload traversal metadata', async () => {
    const root = await temporaryDirectory('filmmaking-cache-traversal-');
    const entry = join(root, 'cache', 'b'.repeat(64));
    await mkdir(entry, { recursive: true });
    await writeFile(
      join(entry, 'metadata.json'),
      JSON.stringify({
        version: 1,
        fingerprint: 'b'.repeat(64),
        artifactType: 'video/mp4',
        isDirectory: false,
        payloadName: '..\\outside.mp4',
        files: [{ relativePath: '', sha256: 'c'.repeat(64), bytes: 1 }],
      }),
    );
    const outside = join(root, 'outside.mp4');
    await writeFile(outside, 'do not read as cache');

    const restored = await new ArtifactCache(join(root, 'cache')).restore(
      'b'.repeat(64),
      'video/mp4',
      join(root, 'result.mp4'),
    );
    expect(restored).toBeNull();
    expect(await readFile(outside, 'utf8')).toBe('do not read as cache');
  });

  it('does not let cleaning one project delete an unowned shared master', async () => {
    const root = await temporaryDirectory('filmmaking-clean-ownership-');
    const output = join(root, 'output');
    const cache = join(root, 'cache');
    const master = join(output, 'master.mp4');
    await mkdir(output, { recursive: true });
    await writeFile(master, 'valid other project output');

    await cleanProductionFiles(output, cache, 'project.one');

    expect(await readFile(master, 'utf8')).toBe('valid other project output');
  });

  it('removes the master only when its project receipt owns that exact path', async () => {
    const root = await temporaryDirectory('filmmaking-clean-owned-');
    const output = join(root, 'output');
    const cache = join(root, 'cache');
    const projectId = 'project.one';
    const safeId = Buffer.from(projectId, 'utf8').toString('base64url');
    const production = join(output, 'production', safeId);
    const master = join(output, 'master.mp4');
    await mkdir(production, { recursive: true });
    await writeFile(master, 'owned output');
    await writeFile(
      join(production, 'production.receipt.json'),
      JSON.stringify({ projectId, masterPath: master }),
    );

    await cleanProductionFiles(output, cache, projectId);

    await expect(readFile(master)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an already-aborted media operation without spawning FFmpeg', async () => {
    const root = await temporaryDirectory('filmmaking-aborted-media-');
    const manifest = parseProjectManifest(
      JSON.parse(
        await readFile(resolve('examples/3d-production/manifest.json'), 'utf8'),
      ),
    );
    const controller = new AbortController();
    controller.abort();
    const engine = new FfmpegMediaEngine({
      ffmpegPath: join(root, 'ffmpeg-does-not-exist.exe'),
    });

    const result = await engine.assemble({
      manifest,
      timeline: compileTimeline(manifest),
      shotArtifacts: Object.fromEntries(
        manifest.shots.map((shot) => [shot.id, join(root, `${shot.id}.mp4`)]),
      ),
      assets: [],
      outputPath: join(root, 'master.mp4'),
      signal: controller.signal,
    });

    expect(result.status).toBe('failure');
    if (result.status === 'failure')
      expect(result.error.code).toBe('INTERRUPTED');
    await expect(readFile(join(root, 'master.mp4'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves an existing master and cleans partial files when FFmpeg is unavailable', async () => {
    const root = await temporaryDirectory('filmmaking-ffmpeg-failure-');
    const manifest = parseProjectManifest(
      JSON.parse(
        await readFile(resolve('examples/3d-production/manifest.json'), 'utf8'),
      ),
    );
    const outputPath = join(root, 'master.mp4');
    await writeFile(outputPath, 'previous valid master');
    const result = await new FfmpegMediaEngine({
      ffmpegPath: join(root, 'ffmpeg-does-not-exist.exe'),
    }).assemble({
      manifest,
      timeline: compileTimeline(manifest),
      shotArtifacts: Object.fromEntries(
        manifest.shots.map((shot) => [shot.id, join(root, `${shot.id}.mp4`)]),
      ),
      assets: [],
      outputPath,
    });

    expect(result.status).toBe('failure');
    if (result.status === 'failure')
      expect(result.error.code).toBe('EXECUTABLE_NOT_FOUND');
    expect(await readFile(outputPath, 'utf8')).toBe('previous valid master');
    expect(
      (await readdir(root)).some((entry) => entry.endsWith('.partial.mp4')),
    ).toBe(false);
  });

  it('rejects unreadable output media through FFprobe', async () => {
    const root = await temporaryDirectory('filmmaking-invalid-media-');
    const path = join(root, 'corrupted.mp4');
    await writeFile(path, 'not an MP4 file');
    const manifest = parseProjectManifest(
      JSON.parse(
        await readFile(resolve('examples/3d-production/manifest.json'), 'utf8'),
      ),
    );
    const media = new FfmpegMediaEngine({
      ffprobePath: process.env['FILMIE_FFPROBE'] ?? 'ffprobe',
    });

    const result = await media.inspect(path, {
      frames: manifest.timeline.durationFrames,
      policy: manifest.renderPolicy,
    });

    expect(result.status).toBe('failure');
  });
});
