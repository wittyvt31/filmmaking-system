import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { ProjectSummary, Revision, Run } from './types.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function checkedId(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new ApiError(404, 'Record not found.');
  return id;
}

export function atomicWrite(path: string, value: string): void {
  const temp = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, value, { flag: 'wx' });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function read<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new ApiError(404, 'Record not found.');
    throw error;
  }
}

export class WorkspaceStore {
  constructor(readonly root: string) {
    mkdirSync(join(root, 'projects'), { recursive: true });
    mkdirSync(join(root, 'runs'), { recursive: true });
  }

  private projectDirectory(id: string) {
    return join(this.root, 'projects', checkedId(id));
  }

  projects(): ProjectSummary[] {
    return readdirSync(join(this.root, 'projects'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) =>
        read<ProjectSummary>(join(this.root, 'projects', entry.name)),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  project(id: string): ProjectSummary {
    return read(this.projectDirectory(id) + '.json');
  }

  registryPath(id: string): string {
    return join(this.projectDirectory(id), 'assets.json');
  }

  create(
    name: string,
    catalog: string,
    registry: string,
    text: string,
  ): ProjectSummary {
    const project: ProjectSummary = {
      id: randomUUID(),
      name,
      catalog,
      revisions: [],
    };
    mkdirSync(this.projectDirectory(project.id));
    atomicWrite(this.registryPath(project.id), registry);
    return this.save(project, text);
  }

  save(project: ProjectSummary, text: string): ProjectSummary {
    const revision: Revision = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    atomicWrite(
      join(this.projectDirectory(project.id), revision.id + '.json'),
      text,
    );
    const next = { ...project, revisions: [revision, ...project.revisions] };
    atomicWrite(
      this.projectDirectory(project.id) + '.json',
      JSON.stringify(next),
    );
    return next;
  }

  revisionPath(project: ProjectSummary, id: string): string {
    if (!project.revisions.some((revision) => revision.id === id))
      throw new ApiError(404, 'Revision not found in this project.');
    return join(this.projectDirectory(project.id), checkedId(id) + '.json');
  }

  putRun(run: Run): void {
    atomicWrite(
      join(this.root, 'runs', checkedId(run.id) + '.json'),
      JSON.stringify(run),
    );
  }
  run(id: string): Run {
    return read(join(this.root, 'runs', checkedId(id) + '.json'));
  }

  runs(): Run[] {
    return readdirSync(join(this.root, 'runs'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => read<Run>(join(this.root, 'runs', name)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
