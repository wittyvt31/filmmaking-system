import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  approveProductionPackage,
  loadProductionPlan,
  prepareProductionPackage,
} from '@filmmaking/orchestrator';
import { describe, expect, it } from 'vitest';

describe('approved production package lifecycle', () => {
  it('seals dependencies, requires approval, and rejects changed manifests', async () => {
    const projectDirectory = await mkdtemp(
      join(tmpdir(), 'filmie-package-test-'),
    );
    try {
      const fixture = resolve('examples/3d-production');
      await Promise.all([
        cp(
          join(fixture, 'manifest.json'),
          join(projectDirectory, 'manifest.json'),
        ),
        cp(join(fixture, 'assets.json'), join(projectDirectory, 'assets.json')),
        cp(join(fixture, 'assets'), join(projectDirectory, 'assets'), {
          recursive: true,
        }),
      ]);

      const prepared = await prepareProductionPackage({ projectDirectory });
      expect(prepared.dependencyCount).toBe(5);
      await expect(loadProductionPlan({ projectDirectory })).rejects.toThrow(
        /not approved/,
      );

      const approved = await approveProductionPackage({
        projectDirectory,
        approvedBy: 'qa-reviewer',
      });
      expect(approved.fingerprint).toBe(prepared.fingerprint);
      await expect(
        loadProductionPlan({ projectDirectory }),
      ).resolves.toMatchObject({
        prepared: {
          manifest: { projectId: 'filmie.3d-reference' },
        },
      });

      const manifestPath = join(projectDirectory, 'manifest.json');
      const manifest = JSON.parse(
        await readFile(manifestPath, 'utf8'),
      ) as Record<string, unknown>;
      const shots = manifest['shots'] as Record<string, unknown>[];
      shots[0] = { ...shots[0], visualDescription: 'Changed after approval' };
      await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
      await expect(loadProductionPlan({ projectDirectory })).rejects.toThrow(
        /stale/,
      );
    } finally {
      await rm(projectDirectory, { recursive: true, force: true });
    }
  });
});
