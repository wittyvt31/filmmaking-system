import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AssetRegistry } from '@filmmaking/assets';
import { prepareProductionPlan } from '@filmmaking/planner';
import type {
  ProjectManifest,
  RenderShotRequest,
  RendererAssetInput,
} from '@filmmaking/contracts';
import { RemotionRendererAdapter } from '@filmmaking/engine-remotion';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectDirectory = resolve('examples');
const outputDirectory = resolve('renders/test-project');
const cacheDirectory = resolve('.cache/remotion-tests');
const sampleManifest = JSON.parse(
  await readFile(resolve(projectDirectory, 'sample-project.json'), 'utf8'),
) as ProjectManifest;
let temporaryDirectory: string;
let registry: AssetRegistry;
let resolvedAssets: RendererAssetInput[];

async function assetRecord(
  assetId: string,
  fileName: string,
  localPath: string,
  version = '1.0.0',
) {
  const contentHash = createHash('sha256')
    .update(await readFile(localPath))
    .digest('hex');
  return {
    assetId,
    version,
    type: 'graphic',
    sourceUri: pathToFileURL(localPath).href,
    contentHash,
    metadata: { fileName },
    license: { name: 'Original sample artwork', restrictions: ['sample use'] },
    provenance: { source: 'renderer test fixture' },
  };
}

function requestFor(
  shotId: string,
  assets = resolvedAssets,
): RenderShotRequest {
  const shot = sampleManifest.shots.find(
    (candidate) => candidate.id === shotId,
  );
  if (!shot) throw new Error(`Unknown test shot: ${shotId}`);
  const selectedAssets = assets.filter((asset) =>
    shot.requiredAssets.some(
      (reference) =>
        reference.assetId === asset.assetId &&
        reference.version === asset.version,
    ),
  );
  return {
    jobId: `test:${shot.id}`,
    shot,
    assets: selectedAssets,
    settings: sampleManifest.renderPolicy,
    artifact: {
      type: 'video/mp4',
      outputPath: join(outputDirectory, `${shot.id}.mp4`),
    },
    randomSeed: 7,
    cacheDirectory,
    timeoutMs: 300_000,
  };
}

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'remotion-engine-test-'));
  const backgroundPath = join(temporaryDirectory, 'sample-background.svg');
  const characterPath = join(temporaryDirectory, 'sample-character.svg');
  await copyFile(
    resolve(projectDirectory, 'assets/sample-background.svg'),
    backgroundPath,
  );
  await copyFile(
    resolve(projectDirectory, 'assets/sample-character.svg'),
    characterPath,
  );
  const versions = [
    await assetRecord(
      'sample.background',
      'sample-background.svg',
      backgroundPath,
    ),
    await assetRecord(
      'sample.character',
      'sample-character.svg',
      characterPath,
    ),
  ];
  registry = new AssetRegistry(versions);
  const prepared = await prepareProductionPlan(
    sampleManifest,
    registry,
    temporaryDirectory,
  );
  resolvedAssets = prepared.assets;
});

afterAll(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true });
  await rm(outputDirectory, { recursive: true, force: true });
  await rm(cacheDirectory, { recursive: true, force: true });
});

describe('Remotion renderer integration', () => {
  it('renders a PNG sequence without the video compositor', async () => {
    for (const shotId of [
      'shot.establishing',
      'shot.character-detail',
      'shot.closing-landscape',
    ]) {
      const request = requestFor(shotId);
      const result = await new RemotionRendererAdapter().renderShot({
        ...request,
        artifact: {
          type: 'image-sequence/png',
          outputDirectory: join(
            outputDirectory,
            `compositor-diagnostic-${shotId}`,
          ),
        },
      });
      expect(
        result.status,
        result.status === 'failure'
          ? `${shotId}: ${result.error.message}`
          : undefined,
      ).toBe('success');
      if (result.status === 'success')
        expect(result.receipt.outputPaths).toHaveLength(30);
    }
  }, 120_000);

  it('rejects structured Blender scene instructions instead of silently ignoring them', async () => {
    const shot = structuredClone(sampleManifest.shots[0]);
    if (!shot) throw new Error('Expected a sample shot.');
    shot.scene = {
      stylePreset: 'charcoal_horror',
      environment: { assetId: 'sample.background', version: '1.0.0' },
      camera: {
        type: 'push-in',
        startFrame: 0,
        durationFrames: 30,
        fromDistance: 8,
        toDistance: 6,
        target: { x: 0, y: 0, z: 0 },
      },
    };
    const request = requestFor(shot.id);
    request.shot = shot;
    request.artifact = {
      type: 'video/mp4',
      outputPath: join(temporaryDirectory, 'unsupported.mp4'),
    };
    const result = await new RemotionRendererAdapter().renderShot(request);
    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.error.code).toBe('UNSUPPORTED_SETTINGS');
      expect(result.error.message).toContain('structured Blender scenes');
    }
  });

  it('renders one shot and three distinct shots to validated 30-frame MP4 artifacts', async () => {
    const renderer = new RemotionRendererAdapter();
    const shotIds = [
      'shot.establishing',
      'shot.character-detail',
      'shot.closing-landscape',
    ];
    const results = [];
    for (const shotId of shotIds)
      results.push(await renderer.renderShot(requestFor(shotId)));

    for (const result of results) {
      expect(
        result.status,
        result.status === 'failure'
          ? `${result.receipt?.shotId ?? 'unknown shot'}: ${result.error.message}\n${result.receipt?.logs.join('\n') ?? ''}`
          : undefined,
      ).toBe('success');
      if (result.status !== 'success') continue;
      expect(result.receipt.status).toBe('success');
      expect(result.receipt.artifactType).toBe('video/mp4');
      expect(result.receipt.outputChecksums[0]?.bytes).toBeGreaterThan(0);
      const path = result.receipt.outputPaths[0];
      expect(path).toBeTruthy();
      const inspection = await renderer.inspectArtifact({
        artifactType: 'video/mp4',
        path: path ?? '',
        expectedFrameCount: 30,
        expectedWidth: 1920,
        expectedHeight: 1080,
        expectedFrameRate: { numerator: 30, denominator: 1 },
        expectedCodec: 'h264',
        expectedPixelFormat: 'yuv420p',
        expectedColorProfile: 'bt709',
      });
      expect(inspection.status).toBe('success');
    }
  }, 900_000);

  it('reuses unchanged shot artifacts and invalidates only shots using a changed asset version', async () => {
    const renderer = new RemotionRendererAdapter();
    const shotIds = [
      'shot.establishing',
      'shot.character-detail',
      'shot.closing-landscape',
    ];
    const cachedResults = [];
    for (const shotId of shotIds)
      cachedResults.push(await renderer.renderShot(requestFor(shotId)));
    expect(
      cachedResults.every(
        (result) => result.status === 'success' && result.cacheHit,
      ),
    ).toBe(true);

    const newCharacterPath = join(
      temporaryDirectory,
      'sample-character-v2.svg',
    );
    const previousCharacterPath = resolve(
      projectDirectory,
      'assets/sample-character.svg',
    );
    await writeFile(
      newCharacterPath,
      `${await readFile(previousCharacterPath, 'utf8')}\n<!-- updated asset version -->\n`,
    );
    const replacement = await assetRecord(
      'sample.character',
      'sample-character-v2.svg',
      newCharacterPath,
      '1.0.1',
    );
    registry.register(replacement);
    const changedAsset: RendererAssetInput = {
      ...replacement,
      localPath: newCharacterPath,
    };
    const original = sampleManifest.shots[0];
    if (!original) throw new Error('Expected sample establishing shot');
    const changedShot = structuredClone(original);
    changedShot.requiredAssets = changedShot.requiredAssets.map((asset) =>
      asset.assetId === 'sample.character'
        ? { ...asset, version: '1.0.1' }
        : asset,
    );
    changedShot.visualElements = changedShot.visualElements?.map((element) =>
      element.asset.assetId === 'sample.character'
        ? { ...element, asset: { ...element.asset, version: '1.0.1' } }
        : element,
    );
    const changedRequest = requestFor('shot.establishing', [
      ...resolvedAssets.filter((asset) => asset.assetId !== 'sample.character'),
      changedAsset,
    ]);
    changedRequest.shot = changedShot;
    changedRequest.assets = [
      ...resolvedAssets.filter((asset) => asset.assetId !== 'sample.character'),
      changedAsset,
    ];
    const changedResult = await renderer.renderShot(changedRequest);
    expect(changedResult.status).toBe('success');
    if (changedResult.status === 'success')
      expect(changedResult.cacheHit).toBe(false);

    const unaffectedResult = await renderer.renderShot(
      requestFor('shot.closing-landscape'),
    );
    expect(unaffectedResult.status).toBe('success');
    if (unaffectedResult.status === 'success')
      expect(unaffectedResult.cacheHit).toBe(true);

    const instructionRequest = requestFor('shot.establishing');
    instructionRequest.shot = {
      ...instructionRequest.shot,
      visualDescription: `${instructionRequest.shot.visualDescription} Keep the foreground darker.`,
    };
    const instructionResult = await renderer.renderShot(instructionRequest);
    expect(instructionResult.status).toBe('success');
    if (instructionResult.status === 'success')
      expect(instructionResult.cacheHit).toBe(false);

    renderer.identity.version = `${renderer.identity.version}-qa-version-change`;
    const versionResult = await renderer.renderShot(
      requestFor('shot.establishing'),
    );
    expect(versionResult.status).toBe('success');
    if (versionResult.status === 'success')
      expect(versionResult.cacheHit).toBe(false);
  }, 600_000);

  it('writes a failure receipt and never reports a missing-asset render as successful', async () => {
    const renderer = new RemotionRendererAdapter();
    const request = requestFor('shot.establishing', []);
    const receiptPath = join(temporaryDirectory, 'failure.receipt.json');
    const result = await renderer.renderShot({ ...request, receiptPath });
    expect(result.status).toBe('failure');
    if (result.status === 'failure')
      expect(result.receipt.status).toBe('failure');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      status: string;
      error?: { code: string };
    };
    expect(receipt.status).toBe('failure');
    expect(receipt.error?.code).toBe('MISSING_ASSET');
  });

  it('returns a discriminated failure for an unsupported runtime artifact type', async () => {
    const renderer = new RemotionRendererAdapter();
    const outputPath = join(temporaryDirectory, 'unsupported-artifact.bin');
    const receiptPath = join(temporaryDirectory, 'unsupported.receipt.json');
    const request = {
      ...requestFor('shot.establishing'),
      artifact: { type: 'unsupported', outputPath },
      receiptPath,
    } as unknown as RenderShotRequest;

    const result = await renderer.renderShot(request);

    expect(result.status).toBe('failure');
    if (result.status === 'failure')
      expect(result.error.code).toBe('INVALID_INSTRUCTIONS');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as {
      status: string;
    };
    expect(receipt.status).toBe('failure');
    await expect(readFile(outputPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
