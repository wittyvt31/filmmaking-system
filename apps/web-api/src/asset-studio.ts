import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { AssetRegistry, type AssetVersion } from '@filmmaking/assets';
import { ProceduralAssetDefinitionSchema } from '@filmmaking/contracts';
import {
  buildProceduralAsset,
  proceduralAssetDescriptor,
  renderAssetPreview,
} from '@filmmaking/engine-blender';
import { ApiError, WorkspaceStore, atomicWrite } from './store.js';
import type {
  AssetStudioAsset,
  AssetStudioBuildResult,
  AssetStudioValidation,
} from './types.js';

const identifierHash = (assetId: string, version: string) =>
  createHash('sha256')
    .update(JSON.stringify([assetId, version]))
    .digest('hex');

function issue(error: { path: PropertyKey[]; message: string }) {
  return {
    path: error.path.map(String).join('.') || '$',
    message: error.message,
  };
}

export class AssetStudioService {
  private building = false;
  private readonly root: string;
  private readonly registryPath: string;

  constructor(
    dataDirectory: string,
    private readonly catalogDirectory: string,
    private readonly store: WorkspaceStore,
  ) {
    this.root = resolve(dataDirectory, 'asset-studio');
    this.registryPath = join(this.root, 'assets.json');
    mkdirSync(this.root, { recursive: true });
  }

  template(): unknown {
    return JSON.parse(
      readFileSync(
        join(this.catalogDirectory, 'asset-lab', 'crane.definition.json'),
        'utf8',
      ),
    ) as unknown;
  }

  validate(input: unknown): AssetStudioValidation {
    const parsed = ProceduralAssetDefinitionSchema.safeParse(input);
    if (!parsed.success)
      return {
        valid: false,
        issues: parsed.error.issues.map(issue),
      };
    try {
      proceduralAssetDescriptor(parsed.data);
    } catch (error) {
      return {
        valid: false,
        issues: [
          {
            path: 'descriptor',
            message: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
    return {
      valid: true,
      issues: [],
      partCount: parsed.data.parts.length,
      meshCount: parsed.data.meshes.length,
      jointCount: parsed.data.joints.length,
    };
  }

  private registry(): AssetRegistry {
    if (!existsSync(this.registryPath)) return new AssetRegistry([]);
    return new AssetRegistry(
      JSON.parse(readFileSync(this.registryPath, 'utf8')) as unknown[],
    );
  }

  private find(assetId: string, version: string): AssetVersion {
    const asset = this.registry()
      .list()
      .find((entry) => entry.assetId === assetId && entry.version === version);
    if (!asset) throw new ApiError(404, 'Published asset not found.');
    return asset;
  }

  private previewFile(assetId: string, version: string): string {
    return join(
      this.root,
      'previews',
      identifierHash(assetId, version) + '.png',
    );
  }

  private definitionFile(assetId: string, version: string): string {
    return join(
      this.root,
      'definitions',
      identifierHash(assetId, version) + '.json',
    );
  }

  private toSummary(asset: AssetVersion): AssetStudioAsset {
    const prefix = '/api/asset-studio/files/';
    const preview = this.previewFile(asset.assetId, asset.version);
    return {
      assetId: asset.assetId,
      version: asset.version,
      contentHash: asset.contentHash,
      glbUrl: prefix + 'artifacts/' + asset.contentHash + '.glb',
      ...(existsSync(preview)
        ? {
            previewUrl:
              prefix +
              'previews/' +
              identifierHash(asset.assetId, asset.version) +
              '.png',
          }
        : {}),
      partCount:
        asset.descriptor?.handles.filter((handle) =>
          handle.id.startsWith('part.'),
        ).length ?? 0,
      jointCount: asset.descriptor?.articulation.joints.length ?? 0,
    };
  }

  list(): AssetStudioAsset[] {
    return this.registry()
      .list()
      .filter((asset) => asset.type === 'model')
      .map((asset) => this.toSummary(asset))
      .sort(
        (a, b) =>
          a.assetId.localeCompare(b.assetId) ||
          a.version.localeCompare(b.version),
      );
  }

  definition(assetId: string, version: string): unknown {
    this.find(assetId, version);
    try {
      return JSON.parse(
        readFileSync(this.definitionFile(assetId, version), 'utf8'),
      ) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new ApiError(404, 'Authored definition is unavailable.');
      throw error;
    }
  }

  /** Serialize registry publication to prevent concurrent lost updates. */
  async build(input: unknown): Promise<AssetStudioBuildResult> {
    const validation = this.validate(input);
    if (!validation.valid)
      throw new ApiError(
        422,
        validation.issues
          .map((entry) => entry.path + ': ' + entry.message)
          .join('\n'),
      );
    if (this.building)
      throw new ApiError(
        409,
        'Another asset is being generated. Retry when it finishes.',
      );
    this.building = true;
    try {
      const definition = ProceduralAssetDefinitionSchema.parse(input);
      const result = await buildProceduralAsset({
        definition,
        registryPath: this.registryPath,
        artifactDirectory: join(this.root, 'artifacts'),
        reportDirectory: join(this.root, 'reports'),
        cacheDirectory: join(this.root, 'cache'),
        timeoutMs: 180_000,
        license: {
          name: 'Created with Filmie Asset Studio',
          restrictions: [],
        },
      });
      if (result.status === 'rejected')
        throw new ApiError(
          422,
          result.diagnostics.map((entry) => entry.message).join('\n') ||
            result.message ||
            'Asset generation failed.',
        );
      const asset = this.find(definition.assetId, definition.assetVersion);
      const definitionPath = this.definitionFile(
        definition.assetId,
        definition.assetVersion,
      );
      await mkdir(dirname(definitionPath), { recursive: true });
      // Immutable publication succeeded; the corresponding authored
      // definition is now safe to retain for reopening and editing.
      await writeFile(
        definitionPath,
        JSON.stringify(definition, null, 2) + '\n',
      );
      const preview = await renderAssetPreview({
        inputPath: result.artifactPath!,
        outputPath: this.previewFile(
          definition.assetId,
          definition.assetVersion,
        ),
        assetId: asset.assetId,
        version: asset.version,
        descriptor: asset.descriptor,
        timeoutMs: 120_000,
      });
      return {
        status: result.status,
        asset: this.toSummary(asset),
        preview: {
          status: preview.status,
          ...(preview.message ? { message: preview.message } : {}),
        },
      };
    } finally {
      this.building = false;
    }
  }

  attach(
    projectId: string,
    assetId: string,
    version: string,
  ): { assetId: string; version: string; projectId: string } {
    const project = this.store.project(projectId);
    const source = this.find(assetId, version);
    const registryPath = this.store.registryPath(project.id);
    const entries = JSON.parse(
      readFileSync(registryPath, 'utf8'),
    ) as unknown[];
    const registry = new AssetRegistry(entries);
    const existing = registry
      .list()
      .find((asset) => asset.assetId === assetId && asset.version === version);
    if (existing) {
      if (existing.contentHash !== source.contentHash)
        throw new ApiError(
          409,
          'Project already has this asset version with different content.',
        );
      return { assetId, version, projectId };
    }
    // Production currently resolves project registry URIs relative to its
    // selected source catalog, so the attached URI must use that base.
    const artifact = resolve(this.root, source.sourceUri);
    const catalogBase = join(this.catalogDirectory, project.catalog);
    const attached: AssetVersion = {
      ...source,
      sourceUri: relative(catalogBase, artifact).replaceAll('\\', '/'),
    };
    const next = new AssetRegistry([...registry.list(), attached]).list();
    atomicWrite(registryPath, JSON.stringify(next, null, 2) + '\n');
    return { assetId, version, projectId };
  }

  file(kind: string, filename: string): { path: string; type: string } {
    if (kind === 'artifacts') {
      const match = /^([a-f0-9]{64})\.glb$/.exec(filename);
      if (
        !match ||
        !this.registry()
          .list()
          .some((asset) => asset.contentHash === match[1])
      )
        throw new ApiError(404, 'Asset file not found.');
      return {
        path: join(this.root, 'artifacts', filename),
        type: 'model/gltf-binary',
      };
    }
    if (kind === 'previews') {
      if (!/^[a-f0-9]{64}\.png$/.test(filename))
        throw new ApiError(404, 'Preview not found.');
      if (
        !this.registry()
          .list()
          .some(
            (asset) =>
              identifierHash(asset.assetId, asset.version) + '.png' ===
              filename,
          )
      )
        throw new ApiError(404, 'Preview not found.');
      return {
        path: join(this.root, 'previews', filename),
        type: 'image/png',
      };
    }
    throw new ApiError(404, 'Unknown asset file type.');
  }
}
