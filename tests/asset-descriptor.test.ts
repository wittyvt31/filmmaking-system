import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssetDescriptorSchema,
  ProceduralAssetDefinitionSchema,
} from '@filmmaking/contracts';
import {
  AssetVersionSchema,
  AssetRegistry,
  inspectGlbBytes,
  normalizeGlbFile,
  resolveAssetSemanticHandles,
  validateAssetDescriptor,
} from '@filmmaking/assets';
import {
  assetFactoryFormat,
  convertAssetToGlb,
} from '../engines/blender/src/asset-factory.js';
import { publishAsset } from '../engines/blender/src/asset-publisher.js';
import { proceduralAssetDescriptor } from '../engines/blender/src/procedural-assets.js';
import {
  createArticulatedKinematicsEvaluator,
  evaluateArticulatedKinematics,
} from '@filmmaking/scene';
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

it('resolves indexed semantic handles and capability mappings deterministically', () => {
  const report = inspectGlbBytes(
    glb({
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Root', mesh: 0 }, { name: 'Socket' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    }),
    {
      schemaVersion: 1,
      handles: [
        {
          id: 'hero.attach',
          kind: 'attachment-socket',
          target: { nodeIndex: 1, path: 'nodes[1]' },
          space: 'local',
        },
      ],
      capabilities: {
        verified: ['attachment'],
        requirements: ['attachment'],
        mappings: [{ capability: 'attachment', handle: 'hero.attach' }],
      },
      provenance: { source: 'test' },
    },
  );
  expect(report.descriptorValidation?.status).toBe('valid');
  expect(report.descriptorValidation?.resolvedHandles).toEqual([
    {
      id: 'hero.attach',
      kind: 'attachment-socket',
      nodeIndex: 1,
      space: 'local',
    },
  ]);
});

it('rejects semantic handles that use ambiguous name targets during publishing', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'filmie-asset-publish-'));
  try {
    const inputPath = join(temporary, 'input.glb');
    await writeFile(
      inputPath,
      glb({
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'Root', mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      }),
    );
    const result = await publishAsset({
      inputPath,
      descriptor: {
        schemaVersion: 1,
        assetId: 'legacy.semantic',
        assetVersion: '1.0.0',
        handles: [
          { id: 'pivot', kind: 'pivot', target: 'Root', space: 'local' },
        ],
        capabilities: {
          verified: ['pivot'],
          requirements: ['pivot'],
          mappings: [{ capability: 'pivot', handle: 'pivot' }],
        },
        provenance: { source: 'test' },
      },
      registryPath: join(temporary, 'assets.json'),
      license: { name: 'test', restrictions: [] },
    });
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((item) => item.code)).toContain(
      'NON_DETERMINISTIC_HANDLE_TARGET',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it('evaluates deterministic hierarchical articulated kinematics', () => {
  const descriptor = {
    schemaVersion: 1,
    handles: [
      { id: 'root', kind: 'node', target: { nodeIndex: 0 } },
      { id: 'arm', kind: 'node', target: { nodeIndex: 1 } },
      { id: 'tip', kind: 'node', target: { nodeIndex: 2 } },
    ],
    articulation: {
      joints: [
        {
          id: 'base',
          type: 'revolute',
          parent: 'root',
          child: 'arm',
          axis: [0, 0, 1],
          limits: { lower: -Math.PI, upper: Math.PI },
          defaultValue: Math.PI / 2,
        },
        {
          id: 'slide',
          type: 'prismatic',
          parent: 'arm',
          child: 'tip',
          axis: [1, 0, 0],
          limits: { lower: 0, upper: 3 },
          defaultValue: 2,
        },
      ],
    },
    provenance: { source: 'test' },
  };
  const first = evaluateArticulatedKinematics(descriptor);
  const second = evaluateArticulatedKinematics(descriptor);
  expect(first).toEqual(second);
  expect(first.jointStates).toEqual({ base: Math.PI / 2, slide: 2 });
  expect(first.nodeTransforms[2]?.position[1]).toBeCloseTo(2);

  const prepared = createArticulatedKinematicsEvaluator(descriptor);
  const poses = [
    { base: 0, slide: 0 },
    { base: Math.PI / 2, slide: 2 },
    { base: -Math.PI / 4, slide: 3 },
    { base: 0, slide: 0 },
  ];
  for (const controls of poses)
    expect(prepared(controls)).toEqual(
      evaluateArticulatedKinematics(descriptor, controls),
    );
  // A reusable evaluator cannot retain the previous frame's joint state.
  expect(prepared(poses[0])).toEqual(prepared(poses[3]));

  const baseTransforms = {
    0: {
      position: [3, 0, 0] as [number, number, number],
      rotation: [1, 0, 0, 0] as [number, number, number, number],
    },
  };
  expect(
    createArticulatedKinematicsEvaluator(descriptor, baseTransforms)(poses[1]),
  ).toEqual(
    evaluateArticulatedKinematics(descriptor, poses[1], baseTransforms),
  );
  expect(() => prepared({ unknown: 1 })).toThrow(
    'Unknown articulated runtime control "unknown"',
  );
  expect(() => prepared({ base: Number.NaN })).toThrow(
    'Invalid articulated runtime control "base"',
  );
});

it('includes a deterministic articulated asset-lab fixture ready for GLB export', async () => {
  const input = JSON.parse(
    await readFile(
      join('examples', 'asset-lab', 'crane.definition.json'),
      'utf8',
    ),
  );
  const definition = ProceduralAssetDefinitionSchema.parse(input);
  const descriptor = proceduralAssetDescriptor(definition);
  expect(definition.parts).toHaveLength(6);
  expect(definition.joints).toHaveLength(3);
  expect(descriptor.capabilities.verified).toContain('articulation');
  const zero = evaluateArticulatedKinematics(descriptor);
  const pose = evaluateArticulatedKinematics(descriptor, {
    'turret.yaw': 0.5,
    'boom.pitch': 0.3,
    'hook.lower': 0.45,
  });
  const boom = descriptor.handles.find((handle) => handle.id === 'part.boom');
  expect(boom?.target).toEqual({ nodeIndex: 1 });
  expect(pose.jointStates).toEqual({
    'boom-pitch': 0.3,
    'hook-slide': 0.45,
    'turret-yaw': 0.5,
  });
  expect(pose.nodeTransforms[1]).not.toEqual(zero.nodeTransforms[1]);
  expect(pose.nodeTransforms[5]).not.toEqual(zero.nodeTransforms[5]);
});

it('builds deterministic procedural descriptors with articulated mappings', () => {
  const definition = {
    schemaVersion: 1 as const,
    assetId: 'procedural-crane',
    assetVersion: '1.0.0',
    kind: 'articulated-assembly' as const,
    materials: [
      {
        id: 'paint',
        color: [0.2, 0.3, 0.4] as [number, number, number],
        metallic: 0.5,
        roughness: 0.4,
      },
    ],
    meshes: [
      {
        id: 'base-mesh',
        materialId: 'paint',
        shape: {
          kind: 'box' as const,
          dimensions: [1, 1, 1] as [number, number, number],
        },
      },
      {
        id: 'arm-mesh',
        materialId: 'paint',
        shape: {
          kind: 'box' as const,
          dimensions: [0.2, 2, 0.2] as [number, number, number],
        },
      },
    ],
    parts: [
      {
        id: 'arm',
        meshId: 'arm-mesh',
        parentId: 'base',
        transform: {
          position: { x: 0, y: 1, z: 0 },
          rotationDegrees: { x: 0, y: 0, z: 0 },
          scale: 1,
        },
      },
      {
        id: 'base',
        meshId: 'base-mesh',
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotationDegrees: { x: 0, y: 0, z: 0 },
          scale: 1,
        },
      },
    ],
    handles: [
      { id: 'arm.control', kind: 'control-target' as const, partId: 'arm' },
    ],
    joints: [
      {
        id: 'boom',
        type: 'revolute' as const,
        parentPartId: 'base',
        childPartId: 'arm',
        axis: [0, 0, 1] as [number, number, number],
        controlId: 'arm.control',
      },
    ],
    provenance: { source: 'test' },
  };
  expect(ProceduralAssetDefinitionSchema.parse(definition).parts[0]?.id).toBe(
    'arm',
  );
  const first = proceduralAssetDescriptor(definition);
  const second = proceduralAssetDescriptor({
    ...definition,
    parts: [...definition.parts].reverse(),
  });
  expect(first).toEqual(second);
  expect(
    first.handles.find((handle) => handle.id === 'part.arm')?.target,
  ).toEqual({
    nodeIndex: 1,
  });
  expect(first.articulation.joints[0]?.child).toBe('part.arm');
  expect(first.restTransforms?.['1']?.position).toEqual([0, 1, 0]);
  const exported = proceduralAssetDescriptor(
    definition,
    new Map([
      ['arm', 7],
      ['base', 3],
    ]),
  );
  expect(
    exported.handles.find((handle) => handle.id === 'part.arm')?.target,
  ).toEqual({ nodeIndex: 7 });
  expect(exported.restTransforms?.['7']?.position).toEqual([0, 1, 0]);
  expect(() =>
    proceduralAssetDescriptor(definition, new Map([['arm', 7]])),
  ).toThrow('Missing exported GLB node mapping for part "base"');
  expect(() => proceduralAssetDescriptor(definition, new Map())).toThrow(
    'Missing exported GLB node mapping for part "arm"',
  );
});

it('rejects invalid procedural hierarchies and articulated scale', () => {
  const result = ProceduralAssetDefinitionSchema.safeParse({
    schemaVersion: 1,
    assetId: 'invalid-prop',
    assetVersion: '1.0.0',
    kind: 'articulated-assembly',
    materials: [{ id: 'paint', color: [0, 0, 0], metallic: 0, roughness: 0.5 }],
    meshes: [
      {
        id: 'mesh',
        materialId: 'paint',
        shape: { kind: 'box', dimensions: [1, 1, 1] },
      },
    ],
    parts: [
      {
        id: 'base',
        meshId: 'mesh',
        parentId: 'arm',
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotationDegrees: { x: 0, y: 0, z: 0 },
          scale: 2,
        },
      },
      {
        id: 'arm',
        meshId: 'mesh',
        parentId: 'base',
        transform: {
          position: { x: 0, y: 0, z: 0 },
          rotationDegrees: { x: 0, y: 0, z: 0 },
          scale: 1,
        },
      },
    ],
    joints: [
      {
        id: 'joint',
        type: 'revolute',
        parentPartId: 'base',
        childPartId: 'arm',
        axis: [0, 0, 1],
      },
    ],
    provenance: { source: 'test' },
  });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.error.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        'Part hierarchy contains a cycle',
        'Articulated procedural parts must use unit scale so rest transforms remain physical',
      ]),
    );
});

it('rejects undeclared articulated runtime controls', () => {
  expect(() =>
    evaluateArticulatedKinematics(
      {
        schemaVersion: 1,
        handles: [
          { id: 'root', kind: 'node', target: { nodeIndex: 0 } },
          { id: 'child', kind: 'node', target: { nodeIndex: 1 } },
        ],
        articulation: {
          joints: [
            {
              id: 'hinge',
              type: 'revolute',
              parent: 'root',
              child: 'child',
              axis: [0, 0, 1],
            },
          ],
        },
        provenance: { source: 'test' },
      },
      { unknown: 1 },
    ),
  ).toThrow('Unknown articulated runtime control "unknown"');
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

it('normalizes self-contained GLBs without changing the source and is stable', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'filmie-glb-normalize-'));
  try {
    const inputPath = join(temporary, 'input.glb');
    const outputPath = join(temporary, 'normalized.glb');
    const repeatedPath = join(temporary, 'repeated.glb');
    const source = glb({
      asset: { version: '2.0' },
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Root', translation: [0, 0, 0] }],
      buffers: [{ byteLength: 0 }],
    });
    await writeFile(inputPath, source);
    const first = await normalizeGlbFile(inputPath, outputPath);
    expect(first.status).toBe('normalized');
    expect(first.outputSha256).toBeDefined();
    expect(first.after?.nodes).toEqual(first.before?.nodes);
    expect(await readFile(inputPath)).toEqual(Buffer.from(source));

    const second = await normalizeGlbFile(outputPath, repeatedPath);
    expect(second.status).toBe('normalized');
    expect(second.outputSha256).toBe(first.outputSha256);
    expect(second.after?.nodes).toEqual(first.after?.nodes);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it('rejects external resources before writing a normalized output', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'filmie-glb-reject-'));
  try {
    const inputPath = join(temporary, 'input.glb');
    const outputPath = join(temporary, 'normalized.glb');
    await writeFile(
      inputPath,
      glb({
        buffers: [{ uri: 'outside.bin', byteLength: 4 }],
        images: [{ uri: 'outside.png' }],
      }),
    );
    const result = await normalizeGlbFile(inputPath, outputPath);
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((item) => item.code)).toContain(
      'EXTERNAL_RESOURCE',
    );
    await expect(readFile(outputPath)).rejects.toThrow();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it('rejects ambiguous node transforms instead of rewriting them', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'filmie-glb-transform-'));
  try {
    const inputPath = join(temporary, 'input.glb');
    const outputPath = join(temporary, 'normalized.glb');
    await writeFile(
      inputPath,
      glb({
        nodes: [
          {
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        ],
      }),
    );
    const result = await normalizeGlbFile(inputPath, outputPath);
    expect(result.status).toBe('rejected');
    expect(result.diagnostics.map((item) => item.code)).toContain(
      'AMBIGUOUS_NODE_TRANSFORM',
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it('converts GLB through the existing canonicalization path and detects formats', async () => {
  expect(assetFactoryFormat('character.gltf')).toBe('gltf');
  expect(assetFactoryFormat('character.fbx')).toBe('fbx');
  expect(assetFactoryFormat('character.obj')).toBe('obj');
  expect(assetFactoryFormat('character.blend')).toBe('blend');
  expect(assetFactoryFormat('character.usd')).toBeUndefined();
  const temporary = await mkdtemp(join(tmpdir(), 'filmie-asset-factory-'));
  try {
    const inputPath = join(temporary, 'input.glb');
    const outputPath = join(temporary, 'output.glb');
    await writeFile(
      inputPath,
      glb({ scenes: [{ nodes: [0] }], nodes: [{ name: 'Root' }] }),
    );
    const result = await convertAssetToGlb({
      inputPath,
      outputPath,
    });
    expect(result.status).toBe('converted');
    expect(result.sourceFormat).toBe('glb');
    expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.after?.nodes[0]?.name).toBe('Root');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it('publishes deterministic content-addressed assets and reuses registry entries', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'filmie-asset-publish-'));
  try {
    const inputPath = join(temporary, 'input.glb');
    const registryPath = join(temporary, 'assets.json');
    const descriptor = {
      schemaVersion: 1,
      assetId: 'published.model',
      assetVersion: '1.0.0',
      provenance: { source: 'focused-test' },
    };
    await writeFile(
      inputPath,
      glb({
        scenes: [{ nodes: [0] }],
        nodes: [{ name: 'Root', mesh: 0 }],
        meshes: [
          { name: 'Body', primitives: [{ attributes: { POSITION: 0 } }] },
        ],
      }),
    );
    const publishOptions = {
      inputPath,
      descriptor,
      registryPath,
      license: { name: 'test', restrictions: [] },
    };
    const first = await publishAsset(publishOptions);
    const second = await publishAsset(publishOptions);
    expect(first.status).toBe('published');
    expect(second.status).toBe('reused');
    expect(first.artifactPath).toBe(second.artifactPath);
    const registry = new AssetRegistry(
      JSON.parse(await readFile(registryPath, 'utf8')),
    );
    const asset = registry.resolve({
      assetId: 'published.model',
      version: '1.0.0',
    });
    expect(asset.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(asset.descriptor?.assetId).toBe('published.model');
    expect(resolveAssetSemanticHandles(asset)).toEqual([]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

it('rejects publishing descriptors without immutable identity', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'filmie-asset-publish-'));
  try {
    const inputPath = join(temporary, 'input.glb');
    await writeFile(inputPath, glb({ nodes: [], meshes: [] }));
    const result = await publishAsset({
      inputPath,
      descriptor: {
        schemaVersion: 1,
        provenance: { source: 'focused-test' },
      },
      registryPath: join(temporary, 'assets.json'),
      license: { name: 'test', restrictions: [] },
    });
    expect(result.status).toBe('rejected');
    expect(result.diagnostics[0]?.code).toBe('IDENTITY_MISSING');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
