import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const workspacePackages = [
  'contracts',
  'manifest',
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

describe('workspace foundation', () => {
  it('declares all requested package boundaries', async () => {
    const manifests = await Promise.all(
      workspacePackages.map((name) => readPackageJson(`packages/${name}`)),
    );

    expect(manifests.map((manifest) => manifest.name)).toEqual(
      workspacePackages.map((name) => `@filmmaking/${name}`),
    );
  });

  it('keeps package dependencies within the approved direction', async () => {
    const allowedDependencies: Record<string, string[]> = {
      contracts: [],
      manifest: ['contracts'],
      assets: ['contracts'],
      timeline: ['contracts', 'manifest'],
      planner: ['contracts', 'manifest', 'assets', 'scene', 'timeline'],
      scene: ['contracts'],
      cache: ['contracts', 'assets'],
      media: ['contracts', 'assets', 'timeline'],
      orchestrator: ['contracts', 'planner', 'cache', 'media', 'assets'],
    };

    for (const [name, allowed] of Object.entries(allowedDependencies)) {
      const manifest = await readPackageJson(`packages/${name}`);
      const dependencies = manifest.dependencies as Record<string, string>;
      const workspaceDependencies = Object.keys(dependencies).filter(
        (dependency) => dependency.startsWith('@filmmaking/'),
      );

      expect(workspaceDependencies.sort()).toEqual(
        allowed.map((dependency) => `@filmmaking/${dependency}`).sort(),
      );
      expect(
        workspaceDependencies.every((dependency) =>
          dependencies[dependency]?.startsWith('workspace:'),
        ),
      ).toBe(true);
    }
  });

  it('keeps the rendering adapter outside orchestration and the CLI at the edge', async () => {
    const [remotionEngine, blenderEngine, orchestrator, cli] =
      await Promise.all([
        readPackageJson('engines/remotion'),
        readPackageJson('engines/blender'),
        readPackageJson('packages/orchestrator'),
        readPackageJson('apps/cli'),
      ]);
    const engineDependencies = Object.keys(
      remotionEngine.dependencies as Record<string, string>,
    ).filter((dependency) => dependency.startsWith('@filmmaking/'));
    const blenderDependencies = Object.keys(
      blenderEngine.dependencies as Record<string, string>,
    ).filter((dependency) => dependency.startsWith('@filmmaking/'));
    const orchestratorDependencies = Object.keys(
      orchestrator.dependencies as Record<string, string>,
    );
    const cliDependencies = Object.keys(
      cli.dependencies as Record<string, string>,
    ).filter((dependency) => dependency.startsWith('@filmmaking/'));

    expect(engineDependencies.sort()).toEqual(
      [
        '@filmmaking/assets',
        '@filmmaking/cache',
        '@filmmaking/contracts',
      ].sort(),
    );
    expect(blenderDependencies.sort()).toEqual(
      [
        '@filmmaking/assets',
        '@filmmaking/cache',
        '@filmmaking/contracts',
        '@filmmaking/scene',
      ].sort(),
    );
    expect(orchestratorDependencies).not.toContain(
      '@filmmaking/engine-remotion',
    );
    expect(cliDependencies.sort()).toEqual(
      [
        '@filmmaking/assets',
        '@filmmaking/contracts',
        '@filmmaking/engine-blender',
        '@filmmaking/engine-remotion',
        '@filmmaking/manifest',
        '@filmmaking/media',
        '@filmmaking/orchestrator',
      ].sort(),
    );
  });
});
