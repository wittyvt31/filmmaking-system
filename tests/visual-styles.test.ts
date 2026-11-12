import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { AssetRegistry } from '@filmmaking/assets';
import { parseProjectManifest, ShotSceneSchema } from '@filmmaking/contracts';
import { prepareProductionPlan } from '@filmmaking/planner';
import { compileScene } from '@filmmaking/scene';

const project = resolve('examples/visual-styles');
const load = async (file: string) =>
  JSON.parse(await readFile(resolve(project, file), 'utf8'));

it('changes the visual fingerprint without changing geometry, animation, or camera', async () => {
  const manifest = parseProjectManifest(await load('manifest.json'));
  const shot = manifest.shots[0]!;
  const base = compileScene(shot, manifest.video.frameRate);
  const profiles = manifest.shots.map((variant) =>
    compileScene(
      {
        ...shot,
        scene: variant.scene!,
      },
      manifest.video.frameRate,
    ),
  );
  expect(profiles.map((p) => p.style.shading)).toEqual([
    'physical',
    'stylized',
    'cel',
    'charcoal',
  ]);
  expect(new Set(profiles.map((p) => p.sha256)).size).toBe(4);
  for (const variant of profiles) {
    expect(variant.world?.sha256).toBe(base.world?.sha256);
    expect(variant.characters).toEqual(base.characters);
    expect(variant.cameraKeyframes).toEqual(base.cameraKeyframes);
  }
});

it('resolves pinned visual dependencies per shot and rejects incompatible engines and assets', async () => {
  const input = await load('manifest.json');
  const assets = await load('assets.json');
  const registry = new AssetRegistry(assets);
  const plan = await prepareProductionPlan(input, registry, project);
  expect(plan.assets).toHaveLength(1);
  for (const job of plan.renderPlan.jobs.filter(
    (j) => j.kind === 'render-shot',
  )) {
    expect(job.inputAssets).toEqual([
      { assetId: 'texture.study-weave', version: '1.0.0' },
    ]);
  }
  const incompatible = structuredClone(input);
  incompatible.renderPolicy.renderer.config.engine = 'CYCLES';
  await expect(
    prepareProductionPlan(incompatible, registry, project),
  ).rejects.toThrow(/cel shading requires Blender EEVEE/i);
  const wrongType = new AssetRegistry(
    assets.map((asset: { type: string }) => ({ ...asset, type: 'model' })),
  );
  await expect(
    prepareProductionPlan(input, wrongType, project),
  ).rejects.toThrow(/must be an image/i);
  const invalid = structuredClone(input.shots[0].scene);
  invalid.visualSettings.celBands = 4;
  expect(ShotSceneSchema.safeParse(invalid).success).toBe(false);
  delete invalid.visualSettings.celBands;
  invalid.world.materials[0].opacity = 2;
  expect(ShotSceneSchema.safeParse(invalid).success).toBe(false);
});
