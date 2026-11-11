import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import { listOutputs, sendFile, sendOutput } from './files.js';
import { ProductionService } from './production.js';
import { ApiError, WorkspaceStore } from './store.js';

function json(response: ServerResponse, data: unknown, status = 200): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new ApiError(415, 'Expected application/json.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({
    destroyOnReturn: false,
  }) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > 2_000_000) {
      request.resume();
      throw new ApiError(413, 'Request exceeds the 2 MB limit.');
    }
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'Expected a JSON object.');
  }
}

function field(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim())
    throw new ApiError(400, 'Expected ' + key + '.');
  return value;
}

function name(input: Record<string, unknown>): string {
  const value = field(input, 'name').trim();
  if (value.length > 120)
    throw new ApiError(400, 'Project names are limited to 120 characters.');
  return value;
}

export function createFilmieServer(options: {
  dataDirectory: string;
  outputDirectory: string;
  cacheDirectory: string;
  catalogsDirectory: string;
  webDirectory: string;
}) {
  const store = new WorkspaceStore(options.dataDirectory);
  const production = new ProductionService(
    store,
    options.catalogsDirectory,
    options.outputDirectory,
    options.cacheDirectory,
  );
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; frame-ancestors 'none'",
    );
    const handle = async () => {
      const host = '127.0.0.1:' + request.socket.localPort;
      if (
        request.headers.host !== host ||
        (request.headers.origin && request.headers.origin !== 'http://' + host)
      )
        throw new ApiError(403, 'Use the local Filmie address.');
      const url = new URL(request.url ?? '/', 'http://' + host);
      const method = request.method;
      if (
        method === 'GET' &&
        ['/', '/app.js', '/app.css'].includes(url.pathname)
      ) {
        const file =
          url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const type =
          file === 'index.html'
            ? 'text/html'
            : file === 'app.css'
              ? 'text/css'
              : 'text/javascript';
        await sendFile(
          request,
          response,
          join(options.webDirectory, file),
          type + '; charset=utf-8',
        );
        return;
      }
      const [, api, resource, id, action, ...rest] = url.pathname.split('/');
      if (api !== 'api') throw new ApiError(404, 'Route not found.');
      if (resource === 'projects' && !id && method === 'GET')
        return json(response, {
          projects: store.projects(),
          catalogs: production.catalogs(),
        });
      if (resource === 'projects' && !id && method === 'POST') {
        const input = await body(request);
        return json(
          response,
          production.create(name(input), field(input, 'catalog')),
          201,
        );
      }
      if (resource === 'projects' && id) {
        const project = store.project(id);
        if (method === 'GET' && !action)
          return json(response, {
            project,
            assets: production
              .registry(project)
              .list()
              .map(({ assetId, version, type }) => ({
                assetId,
                version,
                type,
              })),
          });
        if (method === 'GET' && action === 'revisions' && rest.length === 1)
          return json(response, { text: production.text(project, rest[0]!) });
        if (method === 'GET' && action === 'runs')
          return json(
            response,
            store.runs().filter((run) => run.projectId === id),
          );
        if (method === 'POST' && !rest.length && action) {
          const input = await body(request);
          if (action === 'duplicate')
            return json(
              response,
              production.duplicate(
                project,
                field(input, 'revisionId'),
                name(input),
              ),
              201,
            );
          if (action === 'validate')
            return json(
              response,
              await production.validate(project, field(input, 'text')),
            );
          if (action === 'revisions') {
            const text = field(input, 'text');
            try {
              JSON.parse(text);
            } catch {
              throw new ApiError(400, 'Fix JSON syntax before saving.');
            }
            const current = store.project(id);
            if (current.revisions[0]?.id !== field(input, 'baseRevisionId'))
              throw new ApiError(
                409,
                'The project has a newer revision. Reload it before saving.',
              );
            return json(response, store.save(current, text), 201);
          }
          if (action === 'runs') {
            const revisionId = field(input, 'revisionId');
            const validation = await production.validate(
              project,
              production.text(project, revisionId),
            );
            if (validation.issues.length)
              return json(
                response,
                { error: 'The revision failed validation.', ...validation },
                422,
              );
            return json(response, production.enqueue(project, revisionId), 202);
          }
        }
      }
      if (resource === 'runs' && id && method === 'GET') {
        const run = store.run(id);
        const root = join(options.outputDirectory, run.id);
        if (!action)
          return json(response, {
            run,
            outputs: await listOutputs(root, run.id),
          });
        if (action === 'files') {
          await sendOutput(
            request,
            response,
            root,
            rest.map(decodeURIComponent),
          );
          return;
        }
      }
      throw new ApiError(404, 'Route not found.');
    };
    void handle().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (!(error instanceof ApiError)) console.error(error);
      json(
        response,
        {
          error:
            error instanceof ApiError
              ? error.message
              : 'Local server operation failed. See the terminal for details.',
        },
        error instanceof ApiError ? error.status : 500,
      );
    });
  });
  server.once('listening', () => production.recoverInterruptedRuns());
  return server;
}
