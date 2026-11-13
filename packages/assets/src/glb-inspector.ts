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
  descriptor?: AssetDescriptor;
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
  return {
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
      verified,
      unknown: descriptor
        ? unknown.filter(
            (item) => !descriptor.capabilities.verified.includes(item),
          )
        : unknown,
      unsupported: [],
    },
    ...(descriptor ? { descriptor } : {}),
  };
}

export async function inspectGlbFile(
  path: string,
  descriptorInput?: unknown,
): Promise<GlbAssetInspection> {
  return inspectGlbBytes(await readFile(path), descriptorInput);
}
