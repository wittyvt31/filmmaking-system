import { readFile } from 'node:fs/promises';
import {
  compareStrings,
  canonicalJsonSha256,
  MotionClipLibrarySchema,
  parseProjectManifest,
  visualAssetReferences,
  type AssetVersionReference,
  type ProjectManifest,
  type RenderPolicy,
} from '@filmmaking/contracts';
import {
  AssetRegistry,
  resolveAssetFiles,
  modelImportFormat,
  type ResolvedAsset,
} from '@filmmaking/assets';
import { compileTimeline, type CompiledTimeline } from '@filmmaking/timeline';
import {
  compileScene,
  SCENE_COMPILER_VERSION,
  type CompiledScene,
} from '@filmmaking/scene';

export interface RenderJob {
  id: string;
  kind: 'render-shot';
  shotId: string;
  durationFrames: number;
  renderer: RenderPolicy['renderer'];
  inputAssets: AssetVersionReference[];
  output: RenderArtifact;
  dependsOn: string[];
}

export interface AssemblyJob {
  id: string;
  kind: 'assemble-project';
  renderer: { id: 'ffmpeg' };
  inputAssets: AssetVersionReference[];
  output: RenderArtifact;
  dependsOn: string[];
}

export interface RenderArtifact {
  uri: string;
  mediaType: 'video/mp4' | 'video/quicktime' | 'video/webm';
  role: 'intermediate-shot' | 'final-project';
}

export interface RenderPlan {
  projectId: string;
  projectVersion: string;
  manifestSha256: string;
  timelineSha256: string;
  sceneCompilerVersion: string;
  sceneHashes: Record<string, string>;
  renderPolicy: RenderPolicy;
  shotsToRender: string[];
  jobs: (RenderJob | AssemblyJob)[];
  expectedArtifacts: RenderArtifact[];
  sha256: string;
}

export interface PreparedProductionPlan {
  manifest: ProjectManifest;
  assets: ResolvedAsset[];
  timeline: CompiledTimeline;
  compiledScenes: Record<string, CompiledScene>;
  renderPlan: RenderPlan;
}

function referenceKey(reference: AssetVersionReference): string {
  return `${reference.assetId}\u0000${reference.version}`;
}

function outputFormat(policy: RenderPolicy): {
  extension: string;
  mediaType: RenderArtifact['mediaType'];
} {
  switch (policy.container) {
    case 'mp4':
      return { extension: 'mp4', mediaType: 'video/mp4' };
    case 'mov':
      return { extension: 'mov', mediaType: 'video/quicktime' };
    case 'webm':
      return { extension: 'webm', mediaType: 'video/webm' };
  }
}

function uniqueAssetReferences(
  manifest: ProjectManifest,
): AssetVersionReference[] {
  const references = new Map<string, AssetVersionReference>();
  for (const shot of manifest.shots) {
    for (const reference of shot.requiredAssets)
      references.set(referenceKey(reference), reference);
    for (const reference of visualAssetReferences(shot.scene))
      references.set(referenceKey(reference), reference);
    for (const cue of shot.audioCues ?? [])
      references.set(referenceKey(cue.asset), cue.asset);
    for (const reference of shot.scene?.motionLibraries ?? [])
      references.set(referenceKey(reference), reference);
  }
  return [...references.values()].sort(
    (left, right) =>
      compareStrings(left.assetId, right.assetId) ||
      compareStrings(left.version, right.version),
  );
}

function sceneModelReferences(shot: ProjectManifest['shots'][number]) {
  const scene = shot.scene;
  if (!scene) return [];
  return [
    ...(scene.environment ? [scene.environment] : []),
    ...scene.props.map((prop) => prop.asset),
    ...(scene.world?.entities.flatMap((entity) =>
      entity.geometry.kind === 'asset' ? [entity.geometry.asset] : [],
    ) ?? []),
    ...scene.characters
      .map((c) =>
        'source' in c
          ? c.source.kind === 'imported'
            ? c.source.asset
            : undefined
          : c.asset,
      )
      .filter((asset): asset is AssetVersionReference => asset !== undefined),
  ];
}

function audioAssetReferences(
  manifest: ProjectManifest,
): AssetVersionReference[] {
  const references = new Map<string, AssetVersionReference>();
  for (const shot of manifest.shots) {
    for (const cue of shot.audioCues ?? [])
      references.set(referenceKey(cue.asset), cue.asset);
  }
  return [...references.values()].sort(
    (left, right) =>
      compareStrings(left.assetId, right.assetId) ||
      compareStrings(left.version, right.version),
  );
}

function buildRenderPlan(
  manifest: ProjectManifest,
  timeline: CompiledTimeline,
  resolvedAssets: readonly ResolvedAsset[],
  compiledScenes: Readonly<Record<string, CompiledScene>>,
): RenderPlan {
  const audioReferences = audioAssetReferences(manifest);
  const registeredAssetKeys = new Set(resolvedAssets.map(referenceKey));
  const jobs: (RenderJob | AssemblyJob)[] = [];
  const expectedArtifacts: RenderArtifact[] = [];
  const format = outputFormat(manifest.renderPolicy);

  for (const shot of manifest.shots) {
    const output: RenderArtifact = {
      uri: `renders/shots/${encodeURIComponent(shot.id)}.${format.extension}`,
      mediaType: format.mediaType,
      role: 'intermediate-shot',
    };
    expectedArtifacts.push(output);
    const references = [
      ...shot.requiredAssets,
      ...visualAssetReferences(shot.scene),
    ];
    jobs.push({
      id: `render-shot:${shot.id}`,
      kind: 'render-shot',
      shotId: shot.id,
      durationFrames: shot.durationFrames,
      renderer: manifest.renderPolicy.renderer,
      inputAssets: [
        ...new Map(
          references.map((reference) => [referenceKey(reference), reference]),
        ).values(),
      ].sort(
        (left, right) =>
          compareStrings(left.assetId, right.assetId) ||
          compareStrings(left.version, right.version),
      ),
      output,
      dependsOn: [],
    });
  }

  const finalOutput: RenderArtifact = {
    uri: `renders/${encodeURIComponent(manifest.projectId)}.${format.extension}`,
    mediaType: format.mediaType,
    role: 'final-project',
  };
  expectedArtifacts.push(finalOutput);
  jobs.push({
    id: `assemble-project:${manifest.projectId}@${manifest.version}`,
    kind: 'assemble-project',
    renderer: { id: 'ffmpeg' },
    inputAssets: audioReferences.filter((reference) =>
      registeredAssetKeys.has(referenceKey(reference)),
    ),
    output: finalOutput,
    dependsOn: jobs.map((job) => job.id),
  });

  const withoutHash = {
    projectId: manifest.projectId,
    projectVersion: manifest.version,
    manifestSha256: canonicalJsonSha256(manifest),
    timelineSha256: timeline.sha256,
    sceneCompilerVersion: SCENE_COMPILER_VERSION,
    sceneHashes: Object.fromEntries(
      Object.entries(compiledScenes)
        .sort(([left], [right]) => compareStrings(left, right))
        .map(([shotId, scene]) => [shotId, scene.sha256]),
    ),
    renderPolicy: manifest.renderPolicy,
    shotsToRender: manifest.shots.map((shot) => shot.id),
    jobs,
    expectedArtifacts,
  };
  return { ...withoutHash, sha256: canonicalJsonSha256(withoutHash) };
}

export async function prepareProductionPlan(
  manifestInput: unknown,
  assetRegistry: AssetRegistry,
  assetBaseDirectory: string,
): Promise<PreparedProductionPlan> {
  const manifest = parseProjectManifest(manifestInput);
  const references = uniqueAssetReferences(manifest);
  const assets = await resolveAssetFiles(
    references,
    assetRegistry,
    assetBaseDirectory,
  );
  const timeline = compileTimeline(manifest);
  const compiledEntries = await Promise.all(
    manifest.shots
      .filter((shot) => shot.scene !== undefined)
      .map(async (shot) => {
        for (const reference of visualAssetReferences(shot.scene)) {
          const asset = assets.find(
            (candidate) => referenceKey(candidate) === referenceKey(reference),
          );
          if (asset?.type !== 'image')
            throw new TypeError(
              `Visual asset ${reference.assetId}@${reference.version} must be an image`,
            );
        }
        if (
          shot.scene?.stylePreset === 'cel_shading' &&
          (manifest.renderPolicy.qualityProfile === 'flat' ||
            manifest.renderPolicy.renderer.config.engine !== 'BLENDER_EEVEE')
        )
          throw new TypeError('Cel shading requires Blender EEVEE');
        for (const character of shot.scene?.characters ?? []) {
          if (!('source' in character) || character.source.kind !== 'imported')
            continue;
          const reference = character.source.asset;
          const asset = assets.find(
            (candidate) => referenceKey(candidate) === referenceKey(reference),
          );
          if (
            !asset ||
            modelImportFormat(asset) !== 'blend' ||
            asset.metadata['rigProfile'] !== character.rig.profile ||
            asset.metadata['rigVersion'] !== character.rig.version
          )
            throw new Error(
              `Character "${character.id}" requires a Blender model declaring ${character.rig.profile} v${character.rig.version} in rigProfile and rigVersion metadata`,
            );
        }
        for (const reference of sceneModelReferences(shot)) {
          const asset = assets.find(
            (candidate) => referenceKey(candidate) === referenceKey(reference),
          );
          if (!asset || !modelImportFormat(asset))
            throw new Error(
              `Scene model ${reference.assetId}@${reference.version} requires a prepared Blender collection, self-contained GLB, STL or PLY`,
            );
        }
        const libraries = await Promise.all(
          (shot.scene?.motionLibraries ?? []).map(async (reference) => {
            const asset = assets.find(
              (candidate) =>
                referenceKey(candidate) === referenceKey(reference),
            );
            if (!asset)
              throw new Error(
                `Unresolved motion library ${reference.assetId}@${reference.version}`,
              );
            const parsed = MotionClipLibrarySchema.parse(
              JSON.parse(await readFile(asset.localPath, 'utf8')) as unknown,
            );
            if (
              parsed.libraryId !== reference.assetId ||
              parsed.version !== reference.version
            )
              throw new Error(
                `Motion library identity mismatch: requested ${reference.assetId}@${reference.version}, found ${parsed.libraryId}@${parsed.version}`,
              );
            return parsed;
          }),
        );
        return [
          shot.id,
          compileScene(shot, manifest.video.frameRate, libraries),
        ] as const;
      }),
  );
  const compiledScenes = Object.fromEntries(compiledEntries);
  const renderPlan = buildRenderPlan(
    manifest,
    timeline,
    assets,
    compiledScenes,
  );
  return { manifest, assets, timeline, compiledScenes, renderPlan };
}
