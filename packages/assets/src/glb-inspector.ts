import { readFile } from 'node:fs/promises';
import {
  AssetDescriptorSchema,
  type AssetDescriptor,
} from '@filmmaking/contracts';

type JsonRecord = Record<string, unknown> & {
  asset?: unknown;
  version?: unknown;
  generator?: unknown;
  minVersion?: unknown;
  extras?: unknown;
  extensions?: unknown;
  name?: unknown;
  children?: unknown;
  mesh?: unknown;
  skin?: unknown;
  camera?: unknown;
  translation?: unknown;
  rotation?: unknown;
  scale?: unknown;
  matrix?: unknown;
  nodes?: unknown;
  scenes?: unknown;
  scene?: unknown;
  meshes?: unknown;
  primitives?: unknown;
  attributes?: unknown;
  indices?: unknown;
  material?: unknown;
  targets?: unknown;
  materials?: unknown;
  alphaMode?: unknown;
  doubleSided?: unknown;
  pbrMetallicRoughness?: unknown;
  baseColorFactor?: unknown;
  baseColorTexture?: unknown;
  metallicFactor?: unknown;
  roughnessFactor?: unknown;
  normalTexture?: unknown;
  emissiveTexture?: unknown;
  textures?: unknown;
  sampler?: unknown;
  source?: unknown;
  images?: unknown;
  uri?: unknown;
  mimeType?: unknown;
  bufferView?: unknown;
  animations?: unknown;
  channels?: unknown;
  target?: unknown;
  path?: unknown;
  samplers?: unknown;
  input?: unknown;
  output?: unknown;
  interpolation?: unknown;
  skins?: unknown;
  joints?: unknown;
  skeleton?: unknown;
  inverseBindMatrices?: unknown;
  mode?: unknown;
  index?: unknown;
  node?: unknown;
};

export interface GlbAssetInspection {
  format: 'glb';
  version: 2;
  byteLength: number;
  jsonChunkLength: number;
  binaryChunkLength: number;
  asset: {
    generator?: string | undefined;
    version?: string | undefined;
    minVersion?: string | undefined;
    extras?: unknown;
    extensions?: string[] | undefined;
  };
  scenes: { index: number; name?: string | undefined; nodes: number[] }[];
  nodes: {
    index: number;
    name?: string | undefined;
    children: number[];
    mesh?: number | undefined;
    skin?: number | undefined;
    camera?: number | undefined;
    translation?: number[] | undefined;
    rotation?: number[] | undefined;
    scale?: number[] | undefined;
    matrix?: number[] | undefined;
    extras?: unknown;
    extensions?: string[] | undefined;
  }[];
  meshes: {
    index: number;
    name?: string | undefined;
    primitives: {
      mode?: number | undefined;
      attributes: Record<string, number>;
      indices?: number | undefined;
      material?: number | undefined;
      targets?: Record<string, number>[] | undefined;
    }[];
  }[];
  materials: {
    index: number;
    name?: string | undefined;
    alphaMode?: string | undefined;
    doubleSided?: boolean | undefined;
    baseColorFactor?: number[] | undefined;
    baseColorTexture?: number | undefined;
    metallicFactor?: number | undefined;
    roughnessFactor?: number | undefined;
    normalTexture?: number | undefined;
    emissiveTexture?: number | undefined;
    extras?: unknown;
    extensions?: string[] | undefined;
  }[];
  textures: {
    index: number;
    name?: string | undefined;
    sampler?: number | undefined;
    source?: number | undefined;
  }[];
  images: {
    index: number;
    name?: string | undefined;
    uri?: string | undefined;
    mimeType?: string | undefined;
    bufferView?: number | undefined;
  }[];
  animations: {
    index: number;
    name?: string | undefined;
    channels: {
      sampler: number;
      node?: number | undefined;
      path?: string | undefined;
    }[];
    samplers: {
      input: number;
      output: number;
      interpolation?: string | undefined;
    }[];
  }[];
  skeletons: {
    index: number;
    name?: string | undefined;
    joints: number[];
    skeleton?: number | undefined;
    inverseBindMatrices?: number | undefined;
  }[];
  metadata: {
    extensions: string[];
    extras?: unknown;
  };
  capabilities: {
    verified: string[];
    unknown: string[];
    unsupported: string[];
  };
  animationCompatibility: {
    status: 'verified' | 'unknown' | 'unsupported';
    verified: string[];
    unknown: string[];
    unsupported: string[];
  };
  structuralDiagnostics: GlbDiagnostic[];
  descriptorValidation?: DescriptorValidation;
  descriptor?: AssetDescriptor;
}

export interface GlbDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  path: string;
  message: string;
}

export interface DescriptorValidation {
  status: 'valid' | 'invalid';
  diagnostics: GlbDiagnostic[];
  verifiedReferences: string[];
  unknownCapabilities: string[];
  unsupportedCapabilities: string[];
}

export class GlbInspectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlbInspectionError';
  }
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberArray(value: unknown): number[] | undefined {
  return Array.isArray(value) &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
    ? (value as number[])
    : undefined;
}

function extensions(value: unknown): string[] {
  return Object.keys(record(value).extensions ?? {}).sort();
}

function parseGlb(bytes: Uint8Array): {
  json: JsonRecord;
  byteLength: number;
  jsonChunkLength: number;
  binaryChunkLength: number;
} {
  if (bytes.byteLength < 20)
    throw new GlbInspectionError('GLB header is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67)
    throw new GlbInspectionError('Invalid GLB magic.');
  if (view.getUint32(4, true) !== 2)
    throw new GlbInspectionError('Only GLB version 2 is supported.');
  const byteLength = view.getUint32(8, true);
  if (byteLength !== bytes.byteLength)
    throw new GlbInspectionError('GLB byte length does not match its header.');
  let offset = 12;
  let json: JsonRecord | undefined;
  let jsonChunkLength = 0;
  let binaryChunkLength = 0;
  while (offset + 8 <= byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + length > byteLength)
      throw new GlbInspectionError(
        'GLB chunk exceeds the declared file length.',
      );
    const chunk = bytes.subarray(offset, offset + length);
    if (type === 0x4e4f534a) {
      if (json)
        throw new GlbInspectionError('GLB contains multiple JSON chunks.');
      jsonChunkLength = length;
      try {
        json = record(JSON.parse(new TextDecoder().decode(chunk)));
      } catch {
        throw new GlbInspectionError('GLB JSON chunk is invalid.');
      }
    } else if (type === 0x004e4942) {
      binaryChunkLength += length;
    }
    offset += length;
  }
  if (!json) throw new GlbInspectionError('GLB does not contain a JSON chunk.');
  return { json, byteLength, jsonChunkLength, binaryChunkLength };
}

function diagnostic(
  severity: GlbDiagnostic['severity'],
  code: string,
  path: string,
  message: string,
): GlbDiagnostic {
  return { severity, code, path, message };
}

function resolveNamed(
  target: string,
  entries: readonly { index: number; name?: string | undefined }[],
): { index?: number; ambiguous: boolean } {
  const matches = entries.filter((entry) => entry.name === target);
  return {
    ...(matches.length === 1 ? { index: matches[0]!.index } : {}),
    ambiguous: matches.length > 1,
  };
}

export function validateAssetDescriptor(
  inspection: Omit<GlbAssetInspection, 'descriptorValidation' | 'descriptor'>,
  descriptorInput: unknown,
): DescriptorValidation {
  const descriptor = AssetDescriptorSchema.parse(descriptorInput);
  const diagnostics: GlbDiagnostic[] = [];
  const verifiedReferences: string[] = [];
  const nodeEntries = inspection.nodes;
  const materialEntries = inspection.materials;
  const nodeByName = (target: string, path: string) => {
    const resolved = resolveNamed(target, nodeEntries);
    if (resolved.ambiguous) {
      diagnostics.push(
        diagnostic(
          'error',
          'AMBIGUOUS_NODE_REFERENCE',
          path,
          `Node reference "${target}" matches multiple GLB nodes.`,
        ),
      );
      return undefined;
    }
    if (resolved.index === undefined) {
      diagnostics.push(
        diagnostic(
          'error',
          'MISSING_NODE_REFERENCE',
          path,
          `Node reference "${target}" was not found in the GLB.`,
        ),
      );
      return undefined;
    }
    verifiedReferences.push(path);
    return resolved.index;
  };
  const seenHandles = new Set<string>();
  const seenJoints = new Set<string>();
  const skeletonJointIndices = new Set(
    inspection.skeletons.flatMap((skeleton) => skeleton.joints),
  );

  for (const [index, handle] of descriptor.handles.entries()) {
    const path = `handles[${index}]`;
    if (seenHandles.has(handle.id))
      diagnostics.push(
        diagnostic(
          'error',
          'DUPLICATE_HANDLE_ID',
          `${path}.id`,
          `Handle id "${handle.id}" is declared more than once.`,
        ),
      );
    seenHandles.add(handle.id);
    if (handle.kind === 'material') {
      const resolved = resolveNamed(handle.target, materialEntries);
      if (resolved.ambiguous)
        diagnostics.push(
          diagnostic(
            'error',
            'AMBIGUOUS_MATERIAL_REFERENCE',
            `${path}.target`,
            `Material reference "${handle.target}" matches multiple GLB materials.`,
          ),
        );
      else if (resolved.index === undefined)
        diagnostics.push(
          diagnostic(
            'error',
            'MISSING_MATERIAL_REFERENCE',
            `${path}.target`,
            `Material reference "${handle.target}" was not found in the GLB.`,
          ),
        );
      else verifiedReferences.push(`${path}.target`);
    } else {
      const nodeIndex = nodeByName(handle.target, `${path}.target`);
      if (
        nodeIndex !== undefined &&
        handle.kind === 'bone' &&
        !skeletonJointIndices.has(nodeIndex)
      )
        diagnostics.push(
          diagnostic(
            'error',
            'NODE_NOT_SKELETON_JOINT',
            `${path}.target`,
            `Bone handle "${handle.target}" does not resolve to a skin joint.`,
          ),
        );
    }
  }

  for (const [index, joint] of descriptor.articulation.joints.entries()) {
    const path = `articulation.joints[${index}]`;
    if (seenJoints.has(joint.id))
      diagnostics.push(
        diagnostic(
          'error',
          'DUPLICATE_JOINT_ID',
          `${path}.id`,
          `Joint id "${joint.id}" is declared more than once.`,
        ),
      );
    seenJoints.add(joint.id);
    nodeByName(joint.parent, `${path}.parent`);
    nodeByName(joint.child, `${path}.child`);
    if (
      (joint.type === 'hinge' || joint.type === 'slider') &&
      (!joint.axis ||
        joint.axis.every((component) => component === 0) ||
        !joint.axis.every(Number.isFinite))
    )
      diagnostics.push(
        diagnostic(
          'error',
          'INVALID_JOINT_AXIS',
          `${path}.axis`,
          `${joint.type} joints require a finite, non-zero axis.`,
        ),
      );
    if (
      joint.limits &&
      joint.limits.lower !== undefined &&
      joint.limits.upper !== undefined &&
      joint.limits.lower > joint.limits.upper
    )
      diagnostics.push(
        diagnostic(
          'error',
          'INVALID_JOINT_LIMITS',
          `${path}.limits`,
          'Joint lower limit must not exceed the upper limit.',
        ),
      );
    if (joint.type === 'fixed' && (joint.axis || joint.limits))
      diagnostics.push(
        diagnostic(
          'warning',
          'UNSUPPORTED_FIXED_JOINT_CONSTRAINT',
          path,
          'Fixed joints do not use axis or scalar limits in the GLB descriptor.',
        ),
      );
  }

  for (const [index, socket] of descriptor.sockets.entries()) {
    nodeByName(socket.node, `sockets[${index}].node`);
    if (
      socket.rotation.length !== 4 ||
      socket.rotation.every((component) => component === 0)
    )
      diagnostics.push(
        diagnostic(
          'error',
          'INVALID_SOCKET_ROTATION',
          `sockets[${index}].rotation`,
          'Socket rotation must be a non-zero quaternion.',
        ),
      );
  }

  for (const [index, collider] of descriptor.colliders.entries()) {
    const nodeIndex = nodeByName(collider.node, `colliders[${index}].node`);
    if (nodeIndex !== undefined && collider.shape === 'mesh') {
      const node = inspection.nodes.find(
        (candidate) => candidate.index === nodeIndex,
      );
      if (node?.mesh === undefined)
        diagnostics.push(
          diagnostic(
            'error',
            'COLLIDER_MESH_MISSING',
            `colliders[${index}].node`,
            'Mesh collider target does not reference a GLB mesh node.',
          ),
        );
    }
    if (
      (collider.shape === 'box' && !collider.size) ||
      ((collider.shape === 'capsule' || collider.shape === 'cylinder') &&
        (collider.radius === undefined || collider.height === undefined)) ||
      (collider.shape === 'sphere' && collider.radius === undefined)
    )
      diagnostics.push(
        diagnostic(
          'error',
          'INVALID_COLLIDER_GEOMETRY',
          `colliders[${index}]`,
          `Collider shape "${collider.shape}" is missing required dimensions.`,
        ),
      );
  }

  for (const [index, material] of descriptor.materials.entries()) {
    if (!material.name) {
      diagnostics.push(
        diagnostic(
          'warning',
          'UNVERIFIED_MATERIAL_MAPPING',
          `materials[${index}]`,
          'Material semantic declaration has no GLB material name to verify.',
        ),
      );
      continue;
    }
    const resolved = resolveNamed(material.name, materialEntries);
    if (resolved.ambiguous)
      diagnostics.push(
        diagnostic(
          'error',
          'AMBIGUOUS_MATERIAL_REFERENCE',
          `materials[${index}].name`,
          `Material name "${material.name}" matches multiple GLB materials.`,
        ),
      );
    else if (resolved.index === undefined)
      diagnostics.push(
        diagnostic(
          'error',
          'MISSING_MATERIAL_REFERENCE',
          `materials[${index}].name`,
          `Material name "${material.name}" was not found in the GLB.`,
        ),
      );
    else verifiedReferences.push(`materials[${index}].name`);
  }

  if (descriptor.rig.skeletons !== inspection.skeletons.length)
    diagnostics.push(
      diagnostic(
        'error',
        'SKELETON_COUNT_MISMATCH',
        'rig.skeletons',
        `Descriptor declares ${descriptor.rig.skeletons} skeletons but the GLB contains ${inspection.skeletons.length}.`,
      ),
    );
  if (
    descriptor.rig.bones !== 0 &&
    descriptor.rig.bones !== skeletonJointIndices.size
  )
    diagnostics.push(
      diagnostic(
        'error',
        'BONE_COUNT_MISMATCH',
        'rig.bones',
        `Descriptor declares ${descriptor.rig.bones} bones but the GLB contains ${skeletonJointIndices.size} unique joints.`,
      ),
    );
  for (const [index, rootNode] of descriptor.rig.rootNodes.entries())
    nodeByName(rootNode, `rig.rootNodes[${index}]`);

  return {
    status: diagnostics.some((item) => item.severity === 'error')
      ? 'invalid'
      : 'valid',
    diagnostics,
    verifiedReferences,
    unknownCapabilities: [
      'runtime-animation-evaluation',
      'semantic-handle-behavior',
      'collision-geometry-equivalence',
    ],
    unsupportedCapabilities: [],
  };
}

export function inspectGlbBytes(
  bytes: Uint8Array,
  descriptorInput?: unknown,
): GlbAssetInspection {
  const parsed = parseGlb(bytes);
  const root = parsed.json;
  const asset = record(root.asset);
  const nodes = array(root.nodes).map((value, index) => {
    const node = record(value);
    return {
      index,
      ...(string(node.name) ? { name: string(node.name) } : {}),
      children: array(node.children).filter((child): child is number =>
        Number.isInteger(child),
      ),
      ...(Number.isInteger(node.mesh) ? { mesh: node.mesh as number } : {}),
      ...(Number.isInteger(node.skin) ? { skin: node.skin as number } : {}),
      ...(Number.isInteger(node.camera)
        ? { camera: node.camera as number }
        : {}),
      ...(numberArray(node.translation)
        ? { translation: numberArray(node.translation) }
        : {}),
      ...(numberArray(node.rotation)
        ? { rotation: numberArray(node.rotation) }
        : {}),
      ...(numberArray(node.scale) ? { scale: numberArray(node.scale) } : {}),
      ...(numberArray(node.matrix) ? { matrix: numberArray(node.matrix) } : {}),
      ...(node.extras !== undefined ? { extras: node.extras } : {}),
      ...(extensions(node).length ? { extensions: extensions(node) } : {}),
    };
  });
  const meshes = array(root.meshes).map((value, index) => {
    const mesh = record(value);
    return {
      index,
      ...(string(mesh.name) ? { name: string(mesh.name) } : {}),
      primitives: array(mesh.primitives).map((primitiveValue) => {
        const primitive = record(primitiveValue);
        const attributes = Object.fromEntries(
          Object.entries(record(primitive.attributes)).filter(
            (entry): entry is [string, number] => Number.isInteger(entry[1]),
          ),
        );
        return {
          ...(Number.isInteger(primitive.mode)
            ? { mode: primitive.mode as number }
            : {}),
          attributes,
          ...(Number.isInteger(primitive.indices)
            ? { indices: primitive.indices as number }
            : {}),
          ...(Number.isInteger(primitive.material)
            ? { material: primitive.material as number }
            : {}),
          ...(array(primitive.targets).length
            ? {
                targets: array(primitive.targets).map((target) =>
                  Object.fromEntries(
                    Object.entries(record(target)).filter(
                      (entry): entry is [string, number] =>
                        Number.isInteger(entry[1]),
                    ),
                  ),
                ),
              }
            : {}),
        };
      }),
    };
  });
  const materials = array(root.materials).map((value, index) => {
    const material = record(value);
    const pbr = record(material.pbrMetallicRoughness);
    const normal = record(material.normalTexture);
    const emissive = record(material.emissiveTexture);
    return {
      index,
      ...(string(material.name) ? { name: string(material.name) } : {}),
      ...(string(material.alphaMode)
        ? { alphaMode: string(material.alphaMode) }
        : {}),
      ...(typeof material.doubleSided === 'boolean'
        ? { doubleSided: material.doubleSided }
        : {}),
      ...(numberArray(pbr.baseColorFactor)
        ? { baseColorFactor: numberArray(pbr.baseColorFactor) }
        : {}),
      ...(Number.isInteger(record(pbr.baseColorTexture).index)
        ? { baseColorTexture: record(pbr.baseColorTexture).index as number }
        : {}),
      ...(typeof pbr.metallicFactor === 'number'
        ? { metallicFactor: pbr.metallicFactor }
        : {}),
      ...(typeof pbr.roughnessFactor === 'number'
        ? { roughnessFactor: pbr.roughnessFactor }
        : {}),
      ...(Number.isInteger(normal.index)
        ? { normalTexture: normal.index as number }
        : {}),
      ...(Number.isInteger(emissive.index)
        ? { emissiveTexture: emissive.index as number }
        : {}),
      ...(material.extras !== undefined ? { extras: material.extras } : {}),
      ...(extensions(material).length
        ? { extensions: extensions(material) }
        : {}),
    };
  });
  const animations = array(root.animations).map((value, index) => {
    const animation = record(value);
    return {
      index,
      ...(string(animation.name) ? { name: string(animation.name) } : {}),
      channels: array(animation.channels).map((channelValue) => {
        const channel = record(channelValue);
        const target = record(channel.target);
        return {
          sampler: Number.isInteger(channel.sampler)
            ? (channel.sampler as number)
            : -1,
          ...(Number.isInteger(target.node)
            ? { node: target.node as number }
            : {}),
          ...(string(target.path) ? { path: string(target.path) } : {}),
        };
      }),
      samplers: array(animation.samplers).map((samplerValue) => {
        const sampler = record(samplerValue);
        return {
          input: Number.isInteger(sampler.input)
            ? (sampler.input as number)
            : -1,
          output: Number.isInteger(sampler.output)
            ? (sampler.output as number)
            : -1,
          ...(string(sampler.interpolation)
            ? { interpolation: string(sampler.interpolation) }
            : {}),
        };
      }),
    };
  });
  const skeletons = array(root.skins).map((value, index) => {
    const skin = record(value);
    return {
      index,
      ...(string(skin.name) ? { name: string(skin.name) } : {}),
      joints: array(skin.joints).filter((joint): joint is number =>
        Number.isInteger(joint),
      ),
      ...(Number.isInteger(skin.skeleton)
        ? { skeleton: skin.skeleton as number }
        : {}),
      ...(Number.isInteger(skin.inverseBindMatrices)
        ? { inverseBindMatrices: skin.inverseBindMatrices as number }
        : {}),
    };
  });
  const descriptor =
    descriptorInput === undefined
      ? undefined
      : AssetDescriptorSchema.parse(descriptorInput);
  const verified = [
    'glb.container',
    'nodes',
    'node.transforms',
    'meshes',
    'materials',
    'textures',
    'animations',
    'skeletons',
  ];
  const unknown = [
    'semantic.handle-mapping',
    'capabilities',
    'articulation',
    'colliders',
    'sockets',
    'material-semantics',
  ];
  const structuralDiagnostics: GlbDiagnostic[] = [];
  const nodeCount = nodes.length;
  for (const [index, node] of nodes.entries()) {
    for (const child of node.children) {
      if (child < 0 || child >= nodeCount)
        structuralDiagnostics.push(
          diagnostic(
            'error',
            'INVALID_NODE_CHILD_REFERENCE',
            `nodes[${index}].children`,
            `Node child index ${child} is outside the GLB node array.`,
          ),
        );
    }
    if (
      node.mesh !== undefined &&
      (node.mesh < 0 || node.mesh >= meshes.length)
    )
      structuralDiagnostics.push(
        diagnostic(
          'error',
          'INVALID_NODE_MESH_REFERENCE',
          `nodes[${index}].mesh`,
          `Mesh index ${node.mesh} is outside the GLB mesh array.`,
        ),
      );
    if (
      node.skin !== undefined &&
      (node.skin < 0 || node.skin >= skeletons.length)
    )
      structuralDiagnostics.push(
        diagnostic(
          'error',
          'INVALID_NODE_SKIN_REFERENCE',
          `nodes[${index}].skin`,
          `Skin index ${node.skin} is outside the GLB skin array.`,
        ),
      );
  }
  for (const [index, mesh] of meshes.entries())
    for (const [primitiveIndex, primitive] of mesh.primitives.entries())
      if (
        primitive.material !== undefined &&
        (primitive.material < 0 || primitive.material >= materials.length)
      )
        structuralDiagnostics.push(
          diagnostic(
            'error',
            'INVALID_PRIMITIVE_MATERIAL_REFERENCE',
            `meshes[${index}].primitives[${primitiveIndex}].material`,
            `Material index ${primitive.material} is outside the GLB material array.`,
          ),
        );
  for (const [index, texture] of array(root.textures).entries()) {
    const textureRecord = record(texture);
    const source = textureRecord.source;
    if (
      Number.isInteger(source) &&
      ((source as number) < 0 ||
        (source as number) >= array(root.images).length)
    )
      structuralDiagnostics.push(
        diagnostic(
          'error',
          'INVALID_TEXTURE_IMAGE_REFERENCE',
          `textures[${index}].source`,
          `Image index ${source as number} is outside the GLB image array.`,
        ),
      );
  }
  for (const [index, skeleton] of skeletons.entries())
    for (const joint of skeleton.joints)
      if (joint < 0 || joint >= nodeCount)
        structuralDiagnostics.push(
          diagnostic(
            'error',
            'INVALID_SKELETON_JOINT_REFERENCE',
            `skins[${index}].joints`,
            `Skeleton joint index ${joint} is outside the GLB node array.`,
          ),
        );
  const supportedAnimationPaths = new Set([
    'translation',
    'rotation',
    'scale',
    'weights',
  ]);
  const animationIssues = animations.flatMap((animation) =>
    animation.channels.flatMap((channel, channelIndex) => {
      const issues: GlbDiagnostic[] = [];
      if (channel.sampler < 0 || channel.sampler >= animation.samplers.length)
        issues.push(
          diagnostic(
            'error',
            'INVALID_ANIMATION_SAMPLER_REFERENCE',
            `animations[${animation.index}].channels[${channelIndex}].sampler`,
            `Animation sampler index ${channel.sampler} is invalid.`,
          ),
        );
      if (
        channel.node !== undefined &&
        (channel.node < 0 || channel.node >= nodeCount)
      )
        issues.push(
          diagnostic(
            'error',
            'INVALID_ANIMATION_NODE_REFERENCE',
            `animations[${animation.index}].channels[${channelIndex}].target.node`,
            `Animation target node index ${channel.node} is invalid.`,
          ),
        );
      if (channel.path && !supportedAnimationPaths.has(channel.path))
        issues.push(
          diagnostic(
            'warning',
            'UNSUPPORTED_ANIMATION_PATH',
            `animations[${animation.index}].channels[${channelIndex}].target.path`,
            `Animation target path "${channel.path}" is not supported by Filmie compatibility checks.`,
          ),
        );
      return issues;
    }),
  );
  structuralDiagnostics.push(...animationIssues);
  const animationHasErrors = animationIssues.some(
    (item) => item.severity === 'error',
  );
  const animationCompatibility =
    animations.length === 0
      ? {
          status: 'unknown' as const,
          verified: [],
          unknown: ['animation-data', 'runtime-animation-evaluation'],
          unsupported: [],
        }
      : animationHasErrors
        ? {
            status: 'unsupported' as const,
            verified: [],
            unknown: ['runtime-animation-evaluation'],
            unsupported: ['invalid-animation-references'],
          }
        : {
            status: 'unknown' as const,
            verified: ['animation.target-nodes', 'animation.channels'],
            unknown: ['animation-data', 'runtime-animation-evaluation'],
            unsupported: [],
          };
  const inspection: GlbAssetInspection = {
    format: 'glb',
    version: 2,
    byteLength: parsed.byteLength,
    jsonChunkLength: parsed.jsonChunkLength,
    binaryChunkLength: parsed.binaryChunkLength,
    asset: {
      ...(string(asset.generator)
        ? { generator: string(asset.generator) }
        : {}),
      ...(string(asset.version) ? { version: string(asset.version) } : {}),
      ...(string(asset.minVersion)
        ? { minVersion: string(asset.minVersion) }
        : {}),
      ...(asset.extras !== undefined ? { extras: asset.extras } : {}),
      ...(extensions(asset).length ? { extensions: extensions(asset) } : {}),
    },
    scenes: array(root.scenes).map((value, index) => {
      const scene = record(value);
      return {
        index,
        ...(string(scene.name) ? { name: string(scene.name) } : {}),
        nodes: array(scene.nodes).filter((node): node is number =>
          Number.isInteger(node),
        ),
      };
    }),
    nodes,
    meshes,
    materials,
    textures: array(root.textures).map((value, index) => {
      const texture = record(value);
      return {
        index,
        ...(string(texture.name) ? { name: string(texture.name) } : {}),
        ...(Number.isInteger(texture.sampler)
          ? { sampler: texture.sampler as number }
          : {}),
        ...(Number.isInteger(texture.source)
          ? { source: texture.source as number }
          : {}),
      };
    }),
    images: array(root.images).map((value, index) => {
      const image = record(value);
      return {
        index,
        ...(string(image.name) ? { name: string(image.name) } : {}),
        ...(string(image.uri) ? { uri: string(image.uri) } : {}),
        ...(string(image.mimeType) ? { mimeType: string(image.mimeType) } : {}),
        ...(Number.isInteger(image.bufferView)
          ? { bufferView: image.bufferView as number }
          : {}),
      };
    }),
    animations,
    skeletons,
    metadata: {
      extensions: Object.keys(record(root.extensions)).sort(),
      ...(root.extras !== undefined ? { extras: root.extras } : {}),
    },
    capabilities: {
      verified: verified.filter((item) => item !== 'animations'),
      unknown: descriptor
        ? unknown.filter(
            (item) => !descriptor.capabilities.verified.includes(item),
          )
        : unknown,
      unsupported: [],
    },
    animationCompatibility,
    structuralDiagnostics,
    ...(descriptor ? { descriptor } : {}),
  };
  if (descriptor)
    inspection.descriptorValidation = validateAssetDescriptor(
      inspection,
      descriptor,
    );
  return inspection;
}

export async function inspectGlbFile(
  path: string,
  descriptorInput?: unknown,
): Promise<GlbAssetInspection> {
  return inspectGlbBytes(await readFile(path), descriptorInput);
}
