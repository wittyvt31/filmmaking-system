import { createHash } from 'node:crypto';
import { AssetDescriptorSchema } from '@filmmaking/contracts';
import {
  AssetVersionSchema,
  inspectGlbBytes,
  validateAssetDescriptor,
} from '@filmmaking/assets';
import { expect, it } from 'vitest';

function glb(json: Record<string, unknown>): Uint8Array {
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(encoded.length / 4) * 4;
  const bytes = new Uint8Array(12 + 8 + jsonLength);
  bytes.set(encoded, 20);
  for (let index = encoded.length + 20; index < jsonLength + 20; index += 1)
    bytes[index] = 0x20;
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  return bytes;
}

it('validates versioned authored descriptor data and preserves legacy assets', () => {
  const descriptor = AssetDescriptorSchema.parse({
    schemaVersion: 1,
    handles: [{ id: 'hand.socket', kind: 'socket', target: 'Hand' }],
    capabilities: { verified: ['skeletal-animation'] },
    articulation: {
      joints: [
        { id: 'elbow', type: 'hinge', parent: 'upper_arm', child: 'forearm' },
      ],
    },
    colliders: [{ id: 'body', shape: 'capsule', node: 'Body' }],
    sockets: [
      {
        id: 'hand.socket',
        node: 'Hand',
        position: [0, 0, 0],
        rotation: [1, 0, 0, 0],
      },
    ],
    materials: [{ id: 'skin', semantic: 'character-skin' }],
    rig: { skeletons: 1, bones: 2, rootNodes: ['Root'] },
    provenance: { source: 'artist-authored' },
  });
  expect(descriptor.schemaVersion).toBe(1);
  expect(
    AssetVersionSchema.parse({
      assetId: 'legacy.model',
      version: '1.0.0',
      type: 'model',
      sourceUri: 'models/legacy.blend',
      contentHash: createHash('sha256').update('legacy').digest('hex'),
      metadata: {},
      license: { name: 'test', restrictions: [] },
      provenance: { source: 'fixture' },
    }).descriptor,
  ).toBeUndefined();
});

it('reports verified GLB structure without inferring semantic mappings', () => {
  const report = inspectGlbBytes(
    glb({
      asset: {
        version: '2.0',
        generator: 'test',
        extras: { source: 'fixture' },
      },
      scene: 0,
      scenes: [{ name: 'Main', nodes: [0] }],
      nodes: [
        {
          name: 'Root',
          children: [1],
          translation: [1, 2, 3],
          mesh: 0,
          skin: 0,
        },
        { name: 'Bone' },
      ],
      meshes: [
        {
          name: 'Body',
          primitives: [{ attributes: { POSITION: 0 }, material: 0 }],
        },
      ],
      materials: [
        {
          name: 'BodyMaterial',
          pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] },
        },
      ],
      textures: [{ source: 0 }],
      images: [{ mimeType: 'image/png', uri: 'body.png' }],
      skins: [{ name: 'Rig', joints: [0, 1], skeleton: 0 }],
      animations: [
        {
          name: 'Idle',
          channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
          samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }],
        },
      ],
    }),
  );
  expect(report.nodes[0]).toMatchObject({
    name: 'Root',
    translation: [1, 2, 3],
    mesh: 0,
    skin: 0,
  });
  expect(report.meshes[0]?.primitives[0]?.attributes).toEqual({ POSITION: 0 });
  expect(report.materials[0]?.baseColorFactor).toEqual([1, 0, 0, 1]);
  expect(report.skeletons[0]?.joints).toEqual([0, 1]);
  expect(report.animations[0]?.channels[0]).toEqual({
    sampler: 0,
    node: 1,
    path: 'rotation',
  });
  expect(report.capabilities.verified).toContain('node.transforms');
  expect(report.capabilities.unknown).toContain('semantic.handle-mapping');
});

it('validates authored references separately from runtime animation support', () => {
  const report = inspectGlbBytes(
    glb({
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Root', children: [1], mesh: 0 }, { name: 'Bone' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ name: 'BodyMaterial' }],
      skins: [{ joints: [0, 1], skeleton: 0 }],
      animations: [
        {
          channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
          samplers: [{ input: 0, output: 1 }],
        },
      ],
    }),
  );
  const descriptor = {
    schemaVersion: 1 as const,
    handles: [
      { id: 'root', kind: 'node' as const, target: 'Root' },
      { id: 'bone', kind: 'bone' as const, target: 'Bone' },
    ],
    articulation: {
      joints: [
        {
          id: 'joint',
          type: 'hinge' as const,
          parent: 'Root',
          child: 'Bone',
          axis: [1, 0, 0] as [number, number, number],
        },
      ],
    },
    colliders: [{ id: 'body', shape: 'mesh' as const, node: 'Root' }],
    sockets: [
      {
        id: 'socket',
        node: 'Root',
        position: [0, 0, 0] as [number, number, number],
        rotation: [1, 0, 0, 0] as [number, number, number, number],
      },
    ],
    materials: [{ id: 'body', name: 'BodyMaterial', semantic: 'body' }],
    rig: { skeletons: 1, bones: 2, rootNodes: ['Root'] },
    provenance: { source: 'authored' },
  };
  const validation = validateAssetDescriptor(report, descriptor);
  expect(validation.status).toBe('valid');
  expect(validation.diagnostics).toEqual([]);
  expect(report.animationCompatibility.status).toBe('unknown');
  expect(report.animationCompatibility.verified).toContain(
    'animation.target-nodes',
  );
});

it('reports missing, ambiguous, invalid, and unsupported descriptor mappings', () => {
  const report = inspectGlbBytes(
    glb({
      nodes: [
        { name: 'Duplicate', children: [4] },
        { name: 'Duplicate' },
        { name: 'MeshNode', mesh: 0 },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ name: 'Known' }],
      skins: [{ joints: [0, 1] }],
      animations: [
        {
          channels: [{ sampler: 0, target: { node: 99, path: 'matrix' } }],
          samplers: [{ input: 0, output: 1 }],
        },
      ],
    }),
  );
  const descriptor = {
    schemaVersion: 1 as const,
    handles: [
      { id: 'duplicate', kind: 'node' as const, target: 'Duplicate' },
      { id: 'duplicate', kind: 'node' as const, target: 'Missing' },
    ],
    articulation: {
      joints: [
        {
          id: 'bad',
          type: 'hinge' as const,
          parent: 'Missing',
          child: 'Duplicate',
          axis: [0, 0, 0] as [number, number, number],
          limits: { lower: 2, upper: 1 },
        },
        {
          id: 'fixed',
          type: 'fixed' as const,
          parent: 'Duplicate',
          child: 'MeshNode',
          axis: [1, 0, 0] as [number, number, number],
        },
      ],
    },
    colliders: [
      { id: 'box', shape: 'box' as const, node: 'Missing' },
      { id: 'mesh', shape: 'mesh' as const, node: 'Duplicate' },
    ],
    sockets: [
      {
        id: 'bad-socket',
        node: 'Missing',
        position: [0, 0, 0] as [number, number, number],
        rotation: [0, 0, 0, 0] as [number, number, number, number],
      },
    ],
    materials: [
      { id: 'missing', name: 'Missing' },
      { id: 'known', name: 'Known', semantic: 'known' },
    ],
    rig: { skeletons: 2, bones: 4, rootNodes: ['Missing'] },
    provenance: { source: 'invalid-fixture' },
  };
  const validation = validateAssetDescriptor(report, descriptor);
  const codes = validation.diagnostics.map((item) => item.code);
  expect(validation.status).toBe('invalid');
  expect(codes).toEqual(
    expect.arrayContaining([
      'DUPLICATE_HANDLE_ID',
      'AMBIGUOUS_NODE_REFERENCE',
      'MISSING_NODE_REFERENCE',
      'INVALID_JOINT_AXIS',
      'INVALID_JOINT_LIMITS',
      'UNSUPPORTED_FIXED_JOINT_CONSTRAINT',
      'INVALID_COLLIDER_GEOMETRY',
      'INVALID_SOCKET_ROTATION',
      'MISSING_MATERIAL_REFERENCE',
      'SKELETON_COUNT_MISMATCH',
      'BONE_COUNT_MISMATCH',
    ]),
  );
  expect(report.structuralDiagnostics.map((item) => item.code)).toEqual(
    expect.arrayContaining([
      'INVALID_NODE_CHILD_REFERENCE',
      'INVALID_ANIMATION_NODE_REFERENCE',
      'UNSUPPORTED_ANIMATION_PATH',
    ]),
  );
  expect(report.animationCompatibility.status).toBe('unsupported');
});
