import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AssetDescriptorSchema,
  ProceduralAssetDefinitionSchema,
  canonicalJsonSha256,
  type AssetDescriptor,
  type ProceduralAssetDefinition,
} from '@filmmaking/contracts';
import { inspectGlbFile } from '@filmmaking/assets';
import { publishAsset, type AssetPublishReport } from './asset-publisher.js';
import { defaultBlenderExecutable, runBlenderProcess } from './index.js';

const WORKER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'worker',
  'procedural_asset.py',
);
const PROCEDURAL_BUILDER_VERSION = '2';

function sortedDefinition(
  definition: ProceduralAssetDefinition,
): ProceduralAssetDefinition {
  return {
    ...definition,
    materials: [...definition.materials].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    meshes: [...definition.meshes].sort((a, b) => a.id.localeCompare(b.id)),
    parts: [...definition.parts].sort((a, b) => a.id.localeCompare(b.id)),
    handles: [...definition.handles].sort((a, b) => a.id.localeCompare(b.id)),
    joints: [...definition.joints].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function assetClass(
  kind: ProceduralAssetDefinition['kind'],
): 'vehicle' | 'prop' | 'environment' {
  if (kind === 'modular-environment' || kind === 'architectural-structure')
    return 'environment';
  return kind === 'articulated-assembly' ? 'vehicle' : 'prop';
}

type Quaternion = [number, number, number, number];
type Vector = [number, number, number];

function eulerQuaternion(rotation: {
  x: number;
  y: number;
  z: number;
}): Quaternion {
  const x = (rotation.x * Math.PI) / 360;
  const y = (rotation.y * Math.PI) / 360;
  const z = (rotation.z * Math.PI) / 360;
  return [
    Math.cos(x) * Math.cos(y) * Math.cos(z) +
      Math.sin(x) * Math.sin(y) * Math.sin(z),
    Math.sin(x) * Math.cos(y) * Math.cos(z) -
      Math.cos(x) * Math.sin(y) * Math.sin(z),
    Math.cos(x) * Math.sin(y) * Math.cos(z) +
      Math.sin(x) * Math.cos(y) * Math.sin(z),
    Math.cos(x) * Math.cos(y) * Math.sin(z) -
      Math.sin(x) * Math.sin(y) * Math.cos(z),
  ];
}

function multiplyQuaternion(a: Quaternion, b: Quaternion): Quaternion {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

function rotateVector(q: Quaternion, value: Vector): Vector {
  const [w, x, y, z] = q;
  const t: Vector = [
    2 * (y * value[2] - z * value[1]),
    2 * (z * value[0] - x * value[2]),
    2 * (x * value[1] - y * value[0]),
  ];
  return [
    value[0] + w * t[0] + y * t[2] - z * t[1],
    value[1] + w * t[1] + z * t[0] - x * t[2],
    value[2] + w * t[2] + x * t[1] - y * t[0],
  ];
}

export function proceduralAssetDescriptor(
  input: unknown,
  exportedNodeIndices?: ReadonlyMap<string, number>,
): AssetDescriptor {
  const definition = ProceduralAssetDefinitionSchema.parse(input);
  const orderedParts = [...definition.parts].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const nodeIndex = new Map(
    orderedParts.map((part, index) => [part.id, index + 1]),
  );
  const resolvedNodeIndex = (partId: string): number => {
    const index = exportedNodeIndices
      ? exportedNodeIndices.get(partId)
      : nodeIndex.get(partId);
    if (index === undefined)
      throw new Error(`Missing exported GLB node mapping for part "${partId}"`);
    return index;
  };
  const partHandles = orderedParts.map((part) => ({
    id: `part.${part.id}`,
    kind: 'node' as const,
    target: { nodeIndex: resolvedNodeIndex(part.id) },
    space: 'local' as const,
  }));
  const authoredHandles = definition.handles.map((handle) => ({
    id: handle.id,
    kind: handle.kind,
    target: { nodeIndex: resolvedNodeIndex(handle.partId) },
    space: handle.space,
    ...(handle.role ? { role: handle.role } : {}),
  }));
  const handles = [...partHandles, ...authoredHandles];
  const handleIds = new Set(handles.map((handle) => handle.id));
  const joints = definition.joints.map((joint) => ({
    id: joint.id,
    type: joint.type,
    parent: `part.${joint.parentPartId}`,
    child: `part.${joint.childPartId}`,
    ...(joint.pivotPartId ? { pivot: `part.${joint.pivotPartId}` } : {}),
    ...(joint.axis ? { axis: joint.axis } : {}),
    ...(joint.limits ? { limits: joint.limits } : {}),
    defaultValue: joint.defaultValue,
    ...(joint.controlId ? { control: joint.controlId } : {}),
  }));
  const controls = definition.joints
    .filter((joint) => joint.controlId)
    .map((joint) => ({
      id: joint.controlId!,
      handle: handleIds.has(joint.controlId!)
        ? joint.controlId!
        : `part.${joint.childPartId}`,
      channel:
        joint.type === 'prismatic'
          ? ('position' as const)
          : ('rotation' as const),
      joints: [joint.id],
      defaultValue: joint.defaultValue,
    }));
  const partId = (id: string) => (nodeIndex.has(id) ? `part.${id}` : id);
  const partById = new Map(orderedParts.map((part) => [part.id, part]));
  const restTransforms: Record<
    string,
    { position: Vector; rotation: Quaternion }
  > = {};
  const visit = (
    partIdValue: string,
  ): { position: Vector; rotation: Quaternion } => {
    const part = partById.get(partIdValue)!;
    const localRotation = eulerQuaternion(part.transform.rotationDegrees);
    const localPosition: Vector = [
      part.transform.position.x,
      part.transform.position.y,
      part.transform.position.z,
    ];
    const parent = part.parentId ? visit(part.parentId) : undefined;
    const transform = parent
      ? {
          position: (() => {
            const offset = rotateVector(parent.rotation, localPosition);
            return [
              parent.position[0] + offset[0],
              parent.position[1] + offset[1],
              parent.position[2] + offset[2],
            ] as Vector;
          })(),
          rotation: multiplyQuaternion(parent.rotation, localRotation),
        }
      : { position: localPosition, rotation: localRotation };
    restTransforms[String(resolvedNodeIndex(partIdValue))] = transform;
    return transform;
  };
  for (const part of orderedParts) visit(part.id);
  return AssetDescriptorSchema.parse({
    schemaVersion: 1,
    assetId: definition.assetId,
    assetVersion: definition.assetVersion,
    handles,
    capabilities: {
      ...definition.capabilities,
      assetClass:
        definition.capabilities.assetClass ?? assetClass(definition.kind),
      verified: [
        ...new Set([
          'procedural-geometry',
          ...(definition.joints.length ? ['articulation'] : []),
          ...definition.capabilities.verified,
        ]),
      ],
    },
    articulation: { joints, controls },
    restTransforms,
    colliders: definition.colliders.map((collider) => ({
      ...collider,
      node: partId(collider.node),
    })),
    sockets: definition.sockets.map((socket) => ({
      ...socket,
      node: partId(socket.node),
    })),
    materials: definition.materials.map((material) => ({
      id: material.id,
      name: material.id,
    })),
    provenance: definition.provenance,
  });
}

function exportedNodeIndices(
  definition: ProceduralAssetDefinition,
  inspection: Awaited<ReturnType<typeof inspectGlbFile>>,
): Map<string, number> {
  const expected = new Set(definition.parts.map((part) => part.id));
  const mapping = new Map<string, number>();
  const roots = inspection.nodes.filter(
    (node) =>
      node.extras &&
      typeof node.extras === 'object' &&
      !Array.isArray(node.extras) &&
      (node.extras as Record<string, unknown>)['filmieProceduralRoot'] === true,
  );
  if (roots.length !== 1)
    throw new Error(
      `Expected exactly one procedural GLB root marker, found ${roots.length}`,
    );
  for (const node of inspection.nodes) {
    const extras =
      node.extras &&
      typeof node.extras === 'object' &&
      !Array.isArray(node.extras)
        ? (node.extras as Record<string, unknown>)
        : {};
    const partId =
      typeof extras['filmieProceduralPartId'] === 'string'
        ? extras['filmieProceduralPartId']
        : typeof extras['filmie_procedural_part_id'] === 'string'
          ? extras['filmie_procedural_part_id']
          : undefined;
    if (!partId) continue;
    if (!expected.has(partId))
      throw new Error(
        `Exported GLB contains unknown procedural part "${partId}"`,
      );
    if (mapping.has(partId))
      throw new Error(
        `Exported GLB contains duplicate procedural part "${partId}"`,
      );
    mapping.set(partId, node.index);
  }
  if (mapping.size !== expected.size)
    throw new Error(
      `Exported GLB is missing procedural part mappings (${mapping.size}/${expected.size})`,
    );
  // A procedural artifact contains only its authored root and parts. Factory
  // startup objects, stray geometry and duplicate scenes must never be
  // published as part of the immutable model.
  const authoredNodes = new Set([roots[0]!.index, ...mapping.values()]);
  const unexpected = inspection.nodes.filter(
    (node) => !authoredNodes.has(node.index),
  );
  if (unexpected.length)
    throw new Error(
      `Exported GLB contains ${unexpected.length} unexpected node(s): ${unexpected.map((node) => node.name ?? String(node.index)).join(', ')}`,
    );
  if (
    inspection.scenes.length !== 1 ||
    inspection.scenes[0]!.nodes.length !== 1 ||
    inspection.scenes[0]!.nodes[0] !== roots[0]!.index
  )
    throw new Error(
      'Exported GLB must contain exactly one scene with the marked procedural root.',
    );
  for (const [partId, index] of mapping) {
    if (inspection.nodes[index]?.mesh === undefined)
      throw new Error(`Exported procedural part "${partId}" has no geometry.`);
  }
  const childrenByNode = new Map(
    inspection.nodes.map((node) => [node.index, new Set(node.children)]),
  );
  for (const part of definition.parts) {
    const parentIndex = part.parentId
      ? mapping.get(part.parentId)
      : roots[0]!.index;
    const childIndex = mapping.get(part.id);
    if (parentIndex === undefined || childIndex === undefined)
      throw new Error(`Exported GLB hierarchy cannot resolve "${part.id}"`);
    if (!childrenByNode.get(parentIndex)?.has(childIndex))
      throw new Error(
        `Exported GLB hierarchy does not preserve parent "${part.parentId ?? '<root>'}" for "${part.id}"`,
      );
  }
  return mapping;
}

function rejected(registryPath: string, message: string): AssetPublishReport {
  return {
    status: 'rejected',
    registryPath,
    diagnostics: [
      {
        severity: 'error',
        code: 'PROCEDURAL_BUILD_FAILED',
        path: 'definition',
        message,
      },
    ],
    warnings: [],
    losses: [],
    message,
  };
}

export async function buildProceduralAsset(options: {
  definition: unknown;
  registryPath: string;
  artifactDirectory?: string;
  reportDirectory?: string;
  cacheDirectory?: string;
  blenderPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  license: { name: string; url?: string; restrictions: string[] };
  metadata?: Record<string, unknown>;
}): Promise<AssetPublishReport & { definitionSha256?: string }> {
  const parsed = ProceduralAssetDefinitionSchema.safeParse(options.definition);
  if (!parsed.success)
    return {
      ...rejected(options.registryPath, parsed.error.message),
    };
  const definition = sortedDefinition(parsed.data);
  const definitionSha256 = canonicalJsonSha256(definition);
  const cacheKey = canonicalJsonSha256({
    builderVersion: PROCEDURAL_BUILDER_VERSION,
    definition,
  });
  const cacheDirectory = resolve(
    options.cacheDirectory ??
      resolve(dirname(resolve(options.registryPath)), '.procedural'),
  );
  const outputPath = resolve(cacheDirectory, `${cacheKey}.glb`);
  await mkdir(cacheDirectory, { recursive: true });
  try {
    await readFile(outputPath);
  } catch {
    const specDirectory = resolve(cacheDirectory, `${cacheKey}.work`);
    const specPath = resolve(specDirectory, 'spec.json');
    let ownsBuild = false;
    try {
      await mkdir(specDirectory);
      ownsBuild = true;
      await writeFile(
        specPath,
        JSON.stringify({ definition, definitionSha256, outputPath }),
        { flag: 'wx' },
      );
      const process = await runBlenderProcess(
        options.blenderPath ?? defaultBlenderExecutable(),
        [
          '--background',
          '--factory-startup',
          '--python-exit-code',
          '1',
          '--python',
          WORKER_PATH,
          '--',
          specPath,
        ],
        {
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      if (process.code !== 0)
        return {
          ...rejected(
            options.registryPath,
            process.stderr.trim() ||
              `Blender exited with code ${process.code ?? 'unknown'}.`,
          ),
          definitionSha256,
        };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      for (let attempt = 0; attempt < 600; attempt += 1) {
        try {
          await readFile(outputPath);
          break;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        if (attempt === 599)
          return {
            ...rejected(
              options.registryPath,
              'Timed out waiting for another procedural build to complete.',
            ),
            definitionSha256,
          };
      }
    } finally {
      if (ownsBuild) await rm(specDirectory, { recursive: true, force: true });
    }
  }
  let descriptor: AssetDescriptor;
  try {
    const inspection = await inspectGlbFile(outputPath);
    descriptor = proceduralAssetDescriptor(
      definition,
      exportedNodeIndices(definition, inspection),
    );
  } catch (error) {
    return {
      ...rejected(
        options.registryPath,
        error instanceof Error ? error.message : String(error),
      ),
      definitionSha256,
    };
  }
  const result = await publishAsset({
    inputPath: outputPath,
    registryPath: options.registryPath,
    descriptor,
    ...(options.artifactDirectory
      ? { artifactDirectory: options.artifactDirectory }
      : {}),
    ...(options.reportDirectory
      ? { reportDirectory: options.reportDirectory }
      : {}),
    ...(options.blenderPath ? { blenderPath: options.blenderPath } : {}),
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    license: options.license,
    metadata: {
      ...(options.metadata ?? {}),
      proceduralDefinitionSha256: definitionSha256,
      proceduralBuilderVersion: PROCEDURAL_BUILDER_VERSION,
      proceduralKind: definition.kind,
    },
  });
  return { ...result, definitionSha256 };
}

const PREVIEW_WORKER_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'worker',
  'asset_preview.py',
);

export interface ProceduralAssetPreviewReport {
  status: 'rendered' | 'rejected';
  outputPath: string;
  sha256?: string;
  byteLength?: number;
  message?: string;
}

/**
 * Import the actual published GLB in a fresh Blender process, validate semantic
 * node bindings, and produce a lightweight visual inspection image.
 */
export async function renderAssetPreview(options: {
  inputPath: string;
  outputPath: string;
  assetId: string;
  version: string;
  descriptor: unknown;
  blenderPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<ProceduralAssetPreviewReport> {
  const outputPath = resolve(options.outputPath);
  const inputPath = resolve(options.inputPath);
  const reject = (message: string): ProceduralAssetPreviewReport => ({
    status: 'rejected',
    outputPath,
    message,
  });
  const parsed = AssetDescriptorSchema.safeParse(options.descriptor);
  if (!parsed.success)
    return reject(`Invalid preview descriptor: ${parsed.error.message}`);
  const descriptor = parsed.data;
  await mkdir(dirname(outputPath), { recursive: true });
  const specPath = resolve(
    dirname(outputPath),
    `.filmie-preview-${randomUUID()}.json`,
  );
  try {
    await writeFile(
      specPath,
      JSON.stringify({
        inputPath,
        outputPath,
        assetId: options.assetId,
        version: options.version,
        descriptor,
      }),
      { flag: 'wx' },
    );
    // Do not accept a stale image from a previous attempt.
    await rm(outputPath, { force: true });
    const process = await runBlenderProcess(
      options.blenderPath ?? defaultBlenderExecutable(),
      [
        '--background',
        '--factory-startup',
        '--python-exit-code',
        '1',
        '--python',
        PREVIEW_WORKER_PATH,
        '--',
        specPath,
      ],
      {
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (process.code !== 0)
      return reject(
        process.timedOut
          ? 'Blender asset preview timed out.'
          : process.interrupted
            ? 'Blender asset preview was interrupted.'
            : process.stderr.trim() ||
              process.stdout.trim() ||
              `Blender preview exited with code ${process.code ?? 'unknown'}.`,
      );
    const png = await readFile(outputPath);
    if (
      png.length < 8 ||
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      return reject('Blender preview did not produce a valid PNG.');
    return {
      status: 'rendered',
      outputPath,
      byteLength: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
    };
  } catch (error) {
    return reject(error instanceof Error ? error.message : String(error));
  } finally {
    await rm(specPath, { force: true });
  }
}
