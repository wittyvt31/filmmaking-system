import { readFile, writeFile } from 'node:fs/promises';

/**
 * Annotate each existing glTF node with its actual GLB index.
 * The Blender glTF importer rehydrates node extras as object properties.
 * Bone nodes are annotated too, but are deliberately not exposed as object
 * control handles: Blender imports bones inside an armature, not as objects.
 *
 * Preserves every non-JSON chunk byte-for-byte and never mutates the source.
 */
export async function stampGlbObjectIndices(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  if (inputPath === outputPath)
    throw new TypeError('An indexed GLB must be written to a new file.');
  const original = await readFile(inputPath);
  if (original.length < 20) throw new TypeError('GLB is truncated.');
  if (original.toString('ascii', 0, 4) !== 'glTF')
    throw new TypeError('Input is not GLB.');
  if (
    original.readUInt32LE(4) !== 2 ||
    original.readUInt32LE(8) !== original.length
  )
    throw new TypeError('Invalid GLB version or length.');
  const length = original.readUInt32LE(12);
  if (
    original.readUInt32LE(16) !== 0x4e4f534a ||
    length < 2 ||
    20 + length > original.length
  )
    throw new TypeError('GLB must begin with a JSON chunk.');
  const document = JSON.parse(
    original.toString('utf8', 20, 20 + length),
  ) as Record<string, unknown>;
  if (!Array.isArray(document['nodes']))
    throw new TypeError('GLB contains no node array.');
  for (const [index, raw] of document['nodes'].entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new TypeError('GLB contains a non-object node.');
    const node = raw as Record<string, unknown>;
    const extras = node['extras'];
    if (
      extras !== undefined &&
      (!extras || typeof extras !== 'object' || Array.isArray(extras))
    )
      throw new TypeError('GLB node extras must be an object.');
    node['extras'] = {
      ...(extras as Record<string, unknown> | undefined),
      filmie_glb_node_index: index,
    };
  }
  const encoded = Buffer.from(JSON.stringify(document), 'utf8');
  const padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(padded);
  const remaining = original.subarray(20 + length);
  const output = Buffer.alloc(20 + padded.length + remaining.length);
  original.copy(output, 0, 0, 20);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12);
  padded.copy(output, 20);
  remaining.copy(output, 20 + padded.length);
  await writeFile(outputPath, output, { flag: 'wx' });
}
