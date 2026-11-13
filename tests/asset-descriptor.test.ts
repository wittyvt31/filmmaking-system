import { createHash } from 'node:crypto';
import { AssetDescriptorSchema } from '@filmmaking/contracts';
import { AssetVersionSchema, inspectGlbBytes } from '@filmmaking/assets';
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
