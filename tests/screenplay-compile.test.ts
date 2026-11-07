import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compilePreparedScreenplay } from '@filmmaking/manifest';
import { describe, expect, it } from 'vitest';

describe('prepared screenplay compiler', () => {
  it('preserves prepared shot instructions and creates an exact sequential timeline', async () => {
    const project = JSON.parse(
      await readFile(
        resolve('examples/they-have-reached-procedural/manifest.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    const screenplay = {
      schemaVersion: '1.0.0',
      projectId: project['projectId'],
      version: project['version'],
      video: project['video'],
      renderPolicy: project['renderPolicy'],
      scenes: [
        {
          id: 'scene.prepared',
          title: 'Prepared breakdown',
          shots: project['shots'],
        },
      ],
    };
    const first = compilePreparedScreenplay(screenplay);
    const second = compilePreparedScreenplay(screenplay);
    expect(first.sourceFingerprint).toBe(second.sourceFingerprint);
    expect(first.manifest.shots[0]?.visualDescription).toBe(
      (project['shots'] as Record<string, unknown>[])[0]?.['visualDescription'],
    );
    expect(first.manifest.timeline.videoTracks[0]?.clips).toEqual([
      { shotId: 'shot.father-hears-telephone', startFrame: 0 },
    ]);
    expect(first.manifest.timeline.durationFrames).toBe(90);
  });

  it('rejects unprepared or malformed creative instructions rather than repairing them', () => {
    expect(() =>
      compilePreparedScreenplay({ schemaVersion: '1.0.0', scenes: [] }),
    ).toThrow();
  });
});
