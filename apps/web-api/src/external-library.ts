import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  AssetRegistry,
  inspectGlbFile,
  type AssetVersion,
  type GlbAssetInspection,
} from '@filmmaking/assets';
import {
  AssetDescriptorSchema,
  AssetVersionReferenceSchema,
  FilmieHumanoid,
  ProjectManifestSchema,
  SceneTransformSchema,
  StableIdSchema,
  validateRigJointMap,
} from '@filmmaking/contracts';
import { publishAsset, renderAssetPreview } from '@filmmaking/engine-blender';
import { ApiError, WorkspaceStore, atomicWrite } from './store.js';
import { AssetStudioService } from './asset-studio.js';

const nonEmpty = z.string().trim().min(1).max(256);
const shortId = StableIdSchema;
const universeSchema = z.object({
  id: shortId,
  name: nonEmpty,
  visualStyle: nonEmpty,
  description: z.string().max(2000).default(''),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).max(12).default([]),
  shadingNotes: z.string().max(2000).default(''),
}).strict();
const licenseSchema = z.object({
  name: nonEmpty,
  url: z.url().optional(),
  restrictions: z.array(nonEmpty).max(24).default([]),
}).strict();
const importSchema = z.object({
  filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.glb$/),
  assetId: shortId,
  version: AssetVersionReferenceSchema.shape.version,
  category: z.enum(['character', 'environment', 'prop', 'vehicle']),
  universeId: shortId,
  themes: z.array(shortId).max(12).default([]),
  familyId: shortId.optional(),
  sourceProvider: nonEmpty,
  sourceUrl: z.url().optional(),
  license: licenseSchema,
  rigJointMap: z.record(shortId, nonEmpty).optional(),
  preview: z.boolean().default(false),
}).strict();
const worldInstance = z.object({
  id: shortId,
  assetId: shortId,
  version: AssetVersionReferenceSchema.shape.version,
  transform: SceneTransformSchema,
  role: shortId.optional(),
}).strict();
const worldSchema = z.object({
  id: shortId,
  version: AssetVersionReferenceSchema.shape.version,
  name: nonEmpty,
  universeId: shortId,
  theme: shortId,
  instances: z.array(worldInstance).min(1).max(250),
}).strict().superRefine((world, ctx) => {
  const ids = world.instances.map((instance) => instance.id);
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({ code: 'custom', path: ['instances'], message: 'World instance IDs must be unique.' });
});
type Universe = z.infer<typeof universeSchema>;
type ImportRequest = z.infer<typeof importSchema>;
export type WorldPackage = z.infer<typeof worldSchema>;

const defaultUniverse: Universe = {
  id: 'cinematic-horror',
  name: 'Cinematic Horror',
  visualStyle: 'semi-realistic',
  description: 'A restrained psychological-horror universe. Keep believable proportions, cool exterior lighting and warm practical interior lights.',
  palette: ['#162332', '#304052', '#b7a18c', '#b2c5d6'],
  shadingNotes: 'Plausible skin shading, restrained saturation, consistent texture scale and soft shadows.',
};
const sourceFile = (root: string, filename: string) => join(root, 'inbox', filename);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const summary = (error: unknown) => error instanceof Error ? error.message : String(error);

function check<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new ApiError(422, result.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('\n'));
  return result.data;
}

function normalize(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}
const aliases: Record<string, string[]> = {
  pelvis: ['hips', 'hip', 'root', 'mixamorighips'],
  spine: ['spine', 'spine1', 'mixamorigspine'],
  chest: ['chest', 'spine2', 'upperchest', 'mixamorigspine2'],
  neck: ['neck', 'mixamorigneck'],
  head: ['head', 'mixamorighead'],
};
for (const [side, label] of [['L', 'Left'], ['R', 'Right']] as const) {
  aliases['upper_arm.' + side] = [label + 'Arm', 'upperarm' + side, 'mixamorig' + label + 'Arm'];
  aliases['forearm.' + side] = [label + 'ForeArm', 'lowerarm' + side, 'forearm' + side, 'mixamorig' + label + 'ForeArm'];
  aliases['hand.' + side] = [label + 'Hand', 'hand' + side, 'mixamorig' + label + 'Hand'];
  aliases['thigh.' + side] = [label + 'UpLeg', 'thigh' + side, 'upperleg' + side, 'mixamorig' + label + 'UpLeg'];
  aliases['shin.' + side] = [label + 'Leg', 'shin' + side, 'lowerleg' + side, 'mixamorig' + label + 'Leg'];
  aliases['foot.' + side] = [label + 'Foot', 'foot' + side, 'mixamorig' + label + 'Foot'];
}

export function inspectCharacterCompatibility(inspection: GlbAssetInspection) {
  const joints = new Set(inspection.skeletons.flatMap((skeleton) => skeleton.joints));
  const available = inspection.nodes.filter((node) => joints.has(node.index) && node.name);
  const proposed: Record<string, string> = {};
  const used = new Set<number>();
  const missing: string[] = [];
  for (const item of FilmieHumanoid.joints) {
    const preferred = [item.id, ...(aliases[item.id] ?? [])].map(normalize);
    const matches = available.filter((node) => !used.has(node.index) && preferred.includes(normalize(node.name!)));
    if (matches.length === 1) {
      proposed[item.id] = matches[0]!.name!;
      used.add(matches[0]!.index);
    } else missing.push(item.id);
  }
  const morphTargetCount = inspection.meshes.reduce(
    (sum, mesh) => sum + Math.max(0, ...mesh.primitives.map((primitive) => primitive.targets?.length ?? 0)),
    0,
  );
  const issues: string[] = [];
  if (inspection.skeletons.length !== 1)
    issues.push('Humanoid animation requires exactly one mapped skeleton; this model has ' + inspection.skeletons.length + '.');
  if (missing.length) issues.push('Unmapped Filmie joints: ' + missing.join(', '));
  if (morphTargetCount === 0)
    issues.push('No facial morph targets were found; expression animation is not verified.');
  return {
    status: inspection.skeletons.length === 1 && !missing.length
      ? 'mapping-candidate' as const : 'needs-mapping' as const,
    skeletonCount: inspection.skeletons.length,
    boneCount: available.length,
    boneNames: available.map((node) => node.name!),
    suggestedJointMap: proposed,
    missingJoints: missing,
    facial: morphTargetCount ? 'morph-targets-present-unmapped' : 'no-morph-targets',
    morphTargetCount,
    issues,
  };
}

export class ExternalLibraryService {
  private readonly root: string;
  private readonly registryPath: string;
  private readonly universesPath: string;
  private readonly worldsRoot: string;
  private publishing = false;

  constructor(
    dataRoot: string,
    private readonly store: WorkspaceStore,
    private readonly studio: AssetStudioService,
  ) {
    this.root = resolve(dataRoot, 'asset-studio');
    this.registryPath = join(this.root, 'assets.json');
    this.universesPath = join(this.root, 'universes.json');
    this.worldsRoot = join(this.root, 'worlds');
    mkdirSync(join(this.root, 'inbox'), { recursive: true });
    mkdirSync(this.worldsRoot, { recursive: true });
  }

  config() {
    return {
      inboxDirectory: join(this.root, 'inbox'),
      acceptedFormats: ['.glb'],
      maxBytes: 500_000_000,
    };
  }

  universes(): Universe[] {
    if (!existsSync(this.universesPath)) return [defaultUniverse];
    return check(z.array(universeSchema), JSON.parse(readFileSync(this.universesPath, 'utf8')));
  }

  saveUniverse(input: unknown): Universe {
    const universe = check(universeSchema, input);
    const list = this.universes();
    const existing = list.find((item) => item.id === universe.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(universe))
      throw new ApiError(409, 'A visual universe with this ID already exists; create a new versioned identifier.');
    if (!existing) atomicWrite(this.universesPath, JSON.stringify([...list, universe], null, 2) + '\n');
    return universe;
  }

  private registry() {
    return new AssetRegistry(
      existsSync(this.registryPath)
        ? JSON.parse(readFileSync(this.registryPath, 'utf8')) as unknown[] : [],
    );
  }

  private asset(assetId: string, version: string): AssetVersion {
    const found = this.registry().list().find((asset) => asset.assetId === assetId && asset.version === version);
    if (!found) throw new ApiError(404, 'Published asset version not found.');
    return found;
  }

  list(options: { universeId?: string; theme?: string } = {}) {
    return this.registry().list().filter((asset) => {
      const item = asset.metadata['filmieLibrary'] as Record<string, unknown> | undefined;
      if (options.universeId && item?.['universeId'] !== options.universeId) return false;
      if (options.theme && !Array.isArray(item?.['themes'])) return false;
      if (options.theme && !(item?.['themes'] as unknown[]).includes(options.theme)) return false;
      return true;
    }).map((asset) => ({
      assetId: asset.assetId,
      version: asset.version,
      contentHash: asset.contentHash,
      category: ((asset.metadata['filmieLibrary'] as Record<string, unknown> | undefined)?.['category'] ?? 'prop') as string,
      library: asset.metadata['filmieLibrary'] ?? {},
      rigCompatibility: asset.metadata['rigCompatibility'] ?? null,
      glbUrl: '/api/asset-studio/files/artifacts/' + asset.contentHash + '.glb',
    }));
  }

  async inspect(filenameInput: unknown) {
    const filename = check(importSchema.shape.filename, filenameInput);
    const path = sourceFile(this.root, filename);
    let stat;
    try { stat = lstatSync(path); } catch { throw new ApiError(404, 'Staged GLB not found in the Filmie inbox.'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 500_000_000)
      throw new ApiError(422, 'Staged file must be a regular GLB smaller than 500 MB.');
    try {
      const report = await inspectGlbFile(path);
      if (report.structuralDiagnostics.some((issue) => issue.severity === 'error'))
        throw new ApiError(422, 'Invalid GLB structure: ' + report.structuralDiagnostics.map((issue) => issue.message).join('; '));
      if (!report.meshes.length || report.meshes.every((mesh) => !mesh.primitives.length))
        throw new ApiError(422, 'Staged GLB contains no meshes.');
      return {
        meshCount: report.meshes.length,
        nodeCount: report.nodes.length,
        materialCount: report.materials.length,
        animationCount: report.animations.length,
        character: inspectCharacterCompatibility(report),
        inspection: report,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(422, 'Could not inspect staged GLB: ' + summary(error));
    }
  }

  async publish(input: unknown) {
    const request = check(importSchema, input);
    if (!this.universes().some((world) => world.id === request.universeId))
      throw new ApiError(422, 'Create the visual universe before publishing this asset.');
    if (this.publishing) throw new ApiError(409, 'Another external asset is being published.');
    this.publishing = true;
    try {
      const report = await this.inspect(request.filename);
      const inspection = report.inspection;
      let compatibility = report.character;
      if (request.category === 'character' && request.rigJointMap) {
        const mapped = check(z.record(shortId, nonEmpty), request.rigJointMap);
        const jointNames = new Set(inspection.skeletons.flatMap((skeleton) =>
          skeleton.joints.map((index) => inspection.nodes[index]?.name).filter((value): value is string => !!value),
        ));
        if (!validateRigJointMap({ profile: 'FilmieHumanoid', version: 1 }, mapped) ||
            Object.values(mapped).some((name) => !jointNames.has(name)))
          throw new ApiError(422, 'Rig map must cover every FilmieHumanoid joint with a unique exported skeleton bone.');
        compatibility = { ...compatibility, status: 'mapping-candidate', missingJoints: [], suggestedJointMap: mapped,
          issues: compatibility.issues.filter((issue) => !issue.startsWith('Unmapped Filmie joints:')) };
      }
      const nameByIndex = new Map(inspection.nodes.map((node) => [node.index, node.name ?? '']));
      const jointNodes = new Set(inspection.skeletons.flatMap((skeleton) => skeleton.joints));
      const descriptor = AssetDescriptorSchema.parse({
        schemaVersion: 1,
        assetId: request.assetId,
        assetVersion: request.version,
        handles: inspection.nodes.map((node) => ({
          id: 'node.' + node.index,
          kind: jointNodes.has(node.index) ? 'bone' : 'node',
          target: { nodeIndex: node.index },
          space: 'local',
          ...(node.name ? { role: node.name } : {}),
        })),
        capabilities: {
          verified: ['geometry'],
          unsupported: [],
          unknown: request.category === 'character' ? ['character-animation', 'facial-animation'] : [],
          assetClass: request.category,
          requirements: [],
          mappings: [],
        },
        rig: {
          skeletons: inspection.skeletons.length,
          bones: jointNodes.size,
          rootNodes: inspection.skeletons.map((skeleton) =>
            nameByIndex.get(skeleton.skeleton ?? skeleton.joints[0]!) ?? '',
          ).filter(Boolean),
        },
        provenance: { source: request.sourceProvider, importer: 'filmie-blender-bridge', notes: [] },
      });
      const metadata: Record<string, unknown> = {
        filmieLibrary: {
          category: request.category,
          universeId: request.universeId,
          themes: request.themes,
          ...(request.familyId ? { familyId: request.familyId } : {}),
          sourceProvider: request.sourceProvider,
          ...(request.sourceUrl ? { sourceUrl: request.sourceUrl } : {}),
        },
        rigCompatibility: request.category === 'character' ? compatibility : { status: 'not-character' },
        ...(request.category === 'character' && request.rigJointMap
          ? {
              rigProfile: 'FilmieHumanoid',
              rigVersion: 1,
              rigJointMap: compatibility.suggestedJointMap,
            }
          : {}),
      };
      const result = await publishAsset({
        inputPath: sourceFile(this.root, request.filename),
        descriptor,
        registryPath: this.registryPath,
        artifactDirectory: join(this.root, 'artifacts'),
        reportDirectory: join(this.root, 'reports'),
        metadata,
        license: request.license,
      });
      if (result.status === 'rejected')
        throw new ApiError(422, result.message + ': ' + result.diagnostics.map((diagnostic) => diagnostic.message).join('; '));
      const asset = this.asset(request.assetId, request.version);
      if (asset.contentHash !== result.conversionSha256)
        throw new ApiError(409, 'The published version has different content.');
      const output = {
        status: result.status,
        assetId: asset.assetId,
        version: asset.version,
        contentHash: asset.contentHash,
        compatibility,
        warnings: result.warnings,
        losses: result.losses,
        glbUrl: '/api/asset-studio/files/artifacts/' + asset.contentHash + '.glb',
      };
      if (request.preview && result.artifactPath) {
        const previewPath = join(this.root, 'previews', digest(JSON.stringify([asset.assetId, asset.version])) + '.png');
        const preview = await renderAssetPreview({
          inputPath: result.artifactPath,
          outputPath: previewPath,
          assetId: asset.assetId,
          version: asset.version,
          descriptor: asset.descriptor,
          timeoutMs: 120_000,
        });
        return { ...output, preview };
      }
      return output;
    } finally {
      this.publishing = false;
    }
  }

  worlds(): WorldPackage[] {
    return readdirSync(this.worldsRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => check(worldSchema, JSON.parse(readFileSync(join(this.worldsRoot, entry.name), 'utf8'))))
      .sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
  }

  getWorld(id: string, version: string): WorldPackage {
    check(shortId, id);
    check(AssetVersionReferenceSchema.shape.version, version);
    const path = join(this.worldsRoot, digest(JSON.stringify([id, version])) + '.json');
    if (!existsSync(path)) throw new ApiError(404, 'World version not found.');
    return check(worldSchema, JSON.parse(readFileSync(path, 'utf8')));
  }

  saveWorld(input: unknown): WorldPackage {
    const world = check(worldSchema, input);
    if (!this.universes().some((universe) => universe.id === world.universeId))
      throw new ApiError(422, 'Unknown visual universe.');
    for (const instance of world.instances) {
      const asset = this.asset(instance.assetId, instance.version);
      const library = asset.metadata['filmieLibrary'] as Record<string, unknown> | undefined;
      if (library?.['universeId'] && library['universeId'] !== world.universeId)
        throw new ApiError(422, 'Asset ' + instance.assetId + ' belongs to a different visual universe.');
    }
    const path = join(this.worldsRoot, digest(JSON.stringify([world.id, world.version])) + '.json');
    if (existsSync(path)) {
      const existing = this.getWorld(world.id, world.version);
      if (JSON.stringify(existing) !== JSON.stringify(world))
        throw new ApiError(409, 'World versions are immutable. Increment the version to save changes.');
      return existing;
    }
    atomicWrite(path, JSON.stringify(world, null, 2) + '\n');
    return world;
  }

  applyWorld(projectId: string, worldId: string, version: string) {
    const world = this.getWorld(worldId, version);
    const project = this.store.project(projectId);
    const current = JSON.parse(readFileSync(this.store.revisionPath(project, project.revisions[0]!.id), 'utf8')) as {
      shots?: { id?: string; scene?: { world?: { entities?: unknown[] } } }[];
    };
    if (!Array.isArray(current.shots) || !current.shots.length)
      throw new ApiError(422, 'A production project must contain shots with world scenes.');
    const entities = world.instances.map((instance) => ({
      id: instance.id,
      transform: instance.transform,
      geometry: {
        kind: 'asset' as const,
        asset: { assetId: instance.assetId, version: instance.version },
      },
    }));
    for (const shot of current.shots) {
      if (!shot.scene?.world || !Array.isArray(shot.scene.world.entities))
        throw new ApiError(422, 'All shots must contain a world before assembly.');
      const used = new Set(shot.scene.world.entities.map((item) =>
        typeof item === 'object' && item !== null && 'id' in item ? (item as { id: unknown }).id : undefined,
      ));
      if (entities.some((entity) => used.has(entity.id)))
        throw new ApiError(409, 'World instance ID collides with an existing scene entity. Rename the world instance.');
      shot.scene.world.entities.push(...entities);
    }
    const manifest = ProjectManifestSchema.safeParse(current);
    if (!manifest.success)
      throw new ApiError(422, 'World cannot be assembled into this production: ' + manifest.error.issues.map((issue) => issue.message).join('; '));
    // All validation happens before mutating the project's registry or revision.
    const unique = [...new Map(world.instances.map((instance) =>
      [instance.assetId + '@' + instance.version, instance],
    )).values()];
    for (const item of unique) this.studio.attach(projectId, item.assetId, item.version);
    const updated = this.store.save(project, JSON.stringify(manifest.data, null, 2) + '\n');
    return {
      worldId, version, projectId,
      instanceCount: world.instances.length,
      revisionId: updated.revisions[0]!.id,
    };
  }
}
