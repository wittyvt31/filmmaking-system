import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const workspacePackages = [
  'contracts',
  'assets',
  'timeline',
  'planner',
  'scene',
  'cache',
  'orchestrator',
  'media',
];

async function readPackageJson(path: string): Promise<Record<string, unknown>> {
  const content = await readFile(resolve(root, path, 'package.json'), 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
}

describe('workspace architecture', () => {
  it('declares the production package boundaries', async () => {
    const manifests = await Promise.all(
      workspacePackages.map((name) => readPackageJson(`packages/${name}`)),
    );
    expect(manifests.map((manifest) => manifest.name)).toEqual(
      workspacePackages.map((name) => `@filmmaking/${name}`),
    );
  });

  it('directs domain dependencies toward contracts', async () => {
    const allowedDependencies: Record<string, string[]> = {
      contracts: [],
      assets: ['contracts'],
      timeline: ['contracts'],
      planner: ['contracts', 'assets', 'scene', 'timeline'],
      scene: ['contracts'],
      cache: ['contracts', 'assets'],
      media: ['contracts', 'assets', 'timeline'],
      orchestrator: ['contracts', 'planner', 'cache', 'media', 'assets'],
    };
    for (const [name, allowed] of Object.entries(allowedDependencies)) {
      const manifest = await readPackageJson(`packages/${name}`);
      const dependencies = manifest.dependencies as Record<string, string>;
      const internal = Object.keys(dependencies).filter((dependency) =>
        dependency.startsWith('@filmmaking/'),
      );
      expect(internal.sort()).toEqual(
        allowed.map((dependency) => `@filmmaking/${dependency}`).sort(),
      );
      expect(
        internal.every((dependency) =>
          dependencies[dependency]?.startsWith('workspace:'),
        ),
      ).toBe(true);
    }
  });

  it('keeps Blender at the edge and out of orchestration', async () => {
    const [blender, orchestrator, cli] = await Promise.all([
      readPackageJson('engines/blender'),
      readPackageJson('packages/orchestrator'),
      readPackageJson('apps/cli'),
    ]);
    const blenderDependencies = Object.keys(
      blender.dependencies as Record<string, string>,
    ).filter((dependency) => dependency.startsWith('@filmmaking/'));
    const orchestratorDependencies = Object.keys(
      orchestrator.dependencies as Record<string, string>,
    );
    const cliDependencies = Object.keys(
      cli.dependencies as Record<string, string>,
    ).filter((dependency) => dependency.startsWith('@filmmaking/'));

    expect(blenderDependencies.sort()).toEqual(
      [
        '@filmmaking/assets',
        '@filmmaking/cache',
        '@filmmaking/contracts',
        '@filmmaking/scene',
      ].sort(),
    );
    expect(orchestratorDependencies).not.toContain(
      '@filmmaking/engine-blender',
    );
    expect(cliDependencies.sort()).toEqual(
      [
        '@filmmaking/assets',
        '@filmmaking/contracts',
        '@filmmaking/engine-blender',
        '@filmmaking/media',
        '@filmmaking/orchestrator',
      ].sort(),
    );
  });
});
