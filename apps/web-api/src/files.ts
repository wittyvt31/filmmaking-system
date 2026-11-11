import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from './store.js';
import type { Output } from './types.js';

const outputTypes = new Map([
  ['.mp4', 'video/mp4'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.json', 'application/json'],
  ['.log', 'text/plain'],
  ['.txt', 'text/plain'],
  ['.md', 'text/plain'],
  ['.blend', 'application/octet-stream'],
]);

async function entries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function listOutputs(
  root: string,
  runId: string,
): Promise<Output[]> {
  const files: Output[] = [];
  async function walk(directory: string) {
    const children = await entries(directory);
    const frames = children
      .filter((entry) => entry.isFile() && /^frame_\d+\.png$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const samples = new Set([
      frames[0],
      frames[Math.floor(frames.length / 2)],
      frames.at(-1),
    ]);
    for (const entry of children) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      if (!entry.isFile()) continue;
      const type = outputTypes.get(extname(entry.name));
      if (
        !type ||
        (/^frame_\d+\.png$/.test(entry.name) && !samples.has(entry.name))
      )
        continue;
      const name = relative(root, path).split(sep).join('/');
      files.push({
        name,
        url:
          '/api/runs/' +
          runId +
          '/files/' +
          name.split('/').map(encodeURIComponent).join('/'),
        kind: type.startsWith('image/')
          ? 'image'
          : type.startsWith('video/')
            ? 'video'
            : 'file',
      });
    }
  }
  await walk(root);
  return files.sort((a, b) =>
    a.name === 'master.mp4'
      ? -1
      : b.name === 'master.mp4'
        ? 1
        : a.name.localeCompare(b.name),
  );
}

export async function sendOutput(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  parts: string[],
): Promise<void> {
  if (
    !parts.length ||
    parts.some(
      (part) =>
        !part ||
        part === '.' ||
        part === '..' ||
        /[\\/:]/.test(part) ||
        part.includes('\0'),
    )
  )
    throw new ApiError(404, 'Output not found.');
  const type = outputTypes.get(extname(parts.at(-1)!));
  if (!type) throw new ApiError(404, 'Output not found.');
  const path = await realpath(join(root, ...parts)).catch(() => {
    throw new ApiError(404, 'Output not found.');
  });
  const inside = relative(await realpath(root), path);
  if (
    !inside ||
    inside === '..' ||
    inside.startsWith('..' + sep) ||
    isAbsolute(inside)
  )
    throw new ApiError(404, 'Output not found.');
  await sendFile(request, response, path, type);
}

export async function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
  type: string,
): Promise<void> {
  const info = await stat(path).catch(() => {
    throw new ApiError(404, 'File not found.');
  });
  if (!info.isFile()) throw new ApiError(404, 'File not found.');
  const headers: Record<string, string | number> = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Content-Length': info.size,
  };
  const range = request.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    const start = match?.[1]
      ? Number(match[1])
      : Math.max(0, info.size - Number(match?.[2]));
    const end =
      match?.[1] && match[2]
        ? Math.min(Number(match[2]), info.size - 1)
        : info.size - 1;
    if (!match || !Number.isSafeInteger(start) || start < 0 || start > end) {
      response
        .writeHead(416, { 'Content-Range': 'bytes */' + info.size })
        .end();
      return;
    }
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + info.size;
    headers['Content-Length'] = end - start + 1;
    response.writeHead(206, headers);
    await pipeline(createReadStream(path, { start, end }), response);
    return;
  }
  response.writeHead(200, headers);
  await pipeline(createReadStream(path), response);
}
