import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AssetRegistry } from '../packages/assets/dist/index.js';
import { prepareProductionPlan } from '../packages/planner/dist/index.js';
import { RemotionRendererAdapter } from '../engines/remotion/dist/index.js';

const projectDirectory = resolve('examples');
const manifest = JSON.parse(
  await readFile(resolve(projectDirectory, 'sample-project.json'), 'utf8'),
);
const assetDefinitions = [
  {
    assetId: 'sample.background',
    version: '1.0.0',
    fileName: 'sample-background.svg',
    metadata: { role: 'background' },
  },
  {
    assetId: 'sample.character',
    version: '1.0.0',
    fileName: 'sample-character.svg',
    metadata: { role: 'character' },
  },
];
const assets = await Promise.all(
  assetDefinitions.map(async (definition) => {
    const localPath = resolve(projectDirectory, 'assets', definition.fileName);
    const contentHash = createHash('sha256')
      .update(await readFile(localPath))
      .digest('hex');
    return {
      assetId: definition.assetId,
      version: definition.version,
      type: 'graphic',
      sourceUri: pathToFileURL(localPath).href,
      contentHash,
      metadata: definition.metadata,
      license: {
        name: 'Original sample artwork',
        restrictions: ['sample use'],
      },
      provenance: { source: 'filmmaking-system example fixture' },
    };
  }),
);
const prepared = await prepareProductionPlan(
  manifest,
  new AssetRegistry(assets),
  projectDirectory,
);
const renderer = new RemotionRendererAdapter();
const failures = [];

for (const job of prepared.renderPlan.jobs.filter(
  (candidate) => candidate.kind === 'render-shot',
)) {
  const shot = prepared.manifest.shots.find(
    (candidate) => candidate.id === job.shotId,
  );
  if (!shot) throw new Error(`Planned shot not found: ${job.shotId}`);
  const shotAssets = job.inputAssets.map((reference) => {
    const asset = prepared.assets.find(
      (candidate) =>
        candidate.assetId === reference.assetId &&
        candidate.version === reference.version,
    );
    if (!asset)
      throw new Error(
        `Resolved asset not found: ${reference.assetId}@${reference.version}`,
      );
    return asset;
  });
  const result = await renderer.renderShot({
    jobId: job.id,
    shot,
    assets: shotAssets,
    settings: prepared.manifest.renderPolicy,
    artifact: {
      type: 'video/mp4',
      outputPath: resolve('renders/sample-project', `${shot.id}.mp4`),
    },
    randomSeed: 0,
    cacheDirectory: resolve('.cache/remotion'),
  });
  if (result.status === 'failure')
    failures.push(`${shot.id}: ${result.error.message}`);
  else
    process.stdout.write(
      `${shot.id}: ${result.cacheHit ? 'cache hit' : 'rendered'} (${result.receipt.outputPaths[0]})\n`,
    );
}

if (failures.length) throw new Error(failures.join('\n'));
