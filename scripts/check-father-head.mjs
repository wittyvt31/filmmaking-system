import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AssetRegistry } from '../packages/assets/dist/index.js';
import { prepareProductionPlan } from '../packages/planner/dist/index.js';
import {
  defaultBlenderExecutable,
  runBlenderProcess,
} from '../engines/blender/dist/index.js';

const project = resolve('examples/reference-shot/father-visible');
const outputDirectory = resolve(process.argv[2] ?? 'renders/m4/head-check');
await mkdir(outputDirectory, { recursive: true });
const manifest = JSON.parse(
  await readFile(join(project, 'head-check.manifest.json'), 'utf8'),
);
const registry = new AssetRegistry(
  JSON.parse(await readFile(join(project, 'assets.json'), 'utf8')),
);
const plan = await prepareProductionPlan(manifest, registry, project);
const shot = plan.manifest.shots[0];
const scene = plan.compiledScenes[shot.id];
const asset = (reference) => {
  const resolved = plan.assets.find(
    ({ assetId, version }) =>
      reference.assetId === assetId && reference.version === version,
  );
  if (!resolved)
    throw new Error(`Missing diagnostic asset ${reference.assetId}`);
  return resolved;
};
const specPath = join(outputDirectory, 'spec.json');
await writeFile(
  specPath,
  JSON.stringify({
    ...scene,
    ...plan.manifest.video.resolution,
    outputDirectory,
    randomSeed: 0,
    style: { ...scene.style, boilFps: 12 },
    environment: asset(scene.environment),
    layers: scene.layers.map((layer) => ({
      ...layer,
      asset: asset(layer.asset),
    })),
    characters: scene.characters.map((character) => ({
      ...character,
      artwork: asset(character.artwork),
      rig: asset(character.rig),
    })),
    renderConfig: {
      engine: 'BLENDER_EEVEE',
      samples: plan.manifest.renderPolicy.renderer.config.samples,
      shadows: 'high',
      textures: 'high',
      compositing: false,
    },
  }),
);
const result = await runBlenderProcess(
  process.env.FILMIE_BLENDER ?? defaultBlenderExecutable(),
  [
    '--background',
    '--factory-startup',
    '--python-exit-code',
    '1',
    '--python',
    resolve('scripts/check-father-head.py'),
    '--',
    specPath,
  ],
  { timeoutMs: 240_000 },
);
const report = {
  exitCode: result.code,
  signal: result.signal,
  timedOut: result.timedOut,
  ...(result.code === 0
    ? {}
    : {
        failure: (result.stderr || result.stdout)
          .trim()
          .split(/\r?\n/)
          .slice(-8),
      }),
};
await writeFile(
  join(outputDirectory, 'process.json'),
  JSON.stringify(report, null, 2),
);
if (result.code !== 0) process.exitCode = 1;
