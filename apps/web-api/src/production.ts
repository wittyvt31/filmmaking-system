import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AssetRegistry } from '@filmmaking/assets';
import { ProjectManifestSchema } from '@filmmaking/contracts';
import { prepareProductionPlan } from '@filmmaking/planner';
import { executeProduction } from '@filmmaking/orchestrator';
import { BlenderRendererAdapter } from '@filmmaking/engine-blender';
import { FfmpegMediaEngine } from '@filmmaking/media';
import { ApiError, WorkspaceStore } from './store.js';
import type { ProjectSummary, Run, Validation } from './types.js';

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export class ProductionService {
  private active = false;

  constructor(
    readonly store: WorkspaceStore,
    readonly catalogRoot: string,
    readonly outputRoot: string,
    readonly cacheDirectory: string,
  ) {}

  recoverInterruptedRuns(): void {
    for (const run of this.store.runs()) {
      if (run.status === 'running' || run.status === 'queued')
        this.store.putRun({
          ...run,
          status: 'interrupted',
          finishedAt: new Date().toISOString(),
          error:
            'The web server stopped before this run finished. Rerun the saved revision to reuse verified cached work.',
        });
    }
  }

  catalogs(): string[] {
    return readdirSync(this.catalogRoot, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name),
      )
      .map((entry) => entry.name)
      .filter((name) => {
        try {
          this.readCatalog(name);
          return true;
        } catch {
          return false;
        }
      });
  }

  private catalogPath(name: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(name))
      throw new ApiError(404, 'Unknown asset catalog.');
    return join(this.catalogRoot, name);
  }

  private readCatalog(name: string) {
    const directory = this.catalogPath(name);
    return {
      text: readFileSync(join(directory, 'manifest.json'), 'utf8'),
      registry: readFileSync(join(directory, 'assets.json'), 'utf8'),
    };
  }

  create(name: string, catalog: string): ProjectSummary {
    if (!this.catalogs().includes(catalog))
      throw new ApiError(404, 'Unknown asset catalog.');
    const { text, registry } = this.readCatalog(catalog);
    return this.store.create(name, catalog, registry, text);
  }

  duplicate(
    project: ProjectSummary,
    revisionId: string,
    name: string,
  ): ProjectSummary {
    return this.store.create(
      name,
      project.catalog,
      readFileSync(this.store.registryPath(project.id), 'utf8'),
      this.text(project, revisionId),
    );
  }

  text(project: ProjectSummary, revisionId: string): string {
    return readFileSync(this.store.revisionPath(project, revisionId), 'utf8');
  }

  registry(project: ProjectSummary): AssetRegistry {
    return new AssetRegistry(
      JSON.parse(
        readFileSync(this.store.registryPath(project.id), 'utf8'),
      ) as unknown[],
    );
  }

  async validate(project: ProjectSummary, text: string): Promise<Validation> {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      return { issues: [{ path: '$', message: message(error) }] };
    }
    const parsed = ProjectManifestSchema.safeParse(data);
    if (!parsed.success)
      return {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.') || '$',
          message: issue.message,
        })),
      };
    const issues = parsed.data.shots.flatMap((shot, index) =>
      shot.scene
        ? []
        : [
            {
              path: 'shots.' + index + '.scene',
              message: 'Blender requires a structured scene for each shot.',
            },
          ],
    );
    if (issues.length) return { issues };
    try {
      const plan = await prepareProductionPlan(
        parsed.data,
        this.registry(project),
        this.catalogPath(project.catalog),
      );
      return {
        issues: [],
        shots: plan.manifest.shots.length,
        frames: plan.timeline.durationFrames,
      };
    } catch (error) {
      return { issues: [{ path: '$', message: message(error) }] };
    }
  }

  enqueue(project: ProjectSummary, revisionId: string): Run {
    this.store.revisionPath(project, revisionId);
    const run: Run = {
      id: randomUUID(),
      projectId: project.id,
      revisionId,
      status: 'queued',
      createdAt: new Date().toISOString(),
      logs: [],
    };
    this.store.putRun(run);
    void this.drain().catch((error) =>
      console.error('Could not persist production run state:', error),
    );
    return run;
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      for (;;) {
        const run = this.store
          .runs()
          .reverse()
          .find((item) => item.status === 'queued');
        if (!run) break;
        await this.execute(run);
      }
    } finally {
      this.active = false;
    }
  }

  private async execute(run: Run): Promise<void> {
    run.status = 'running';
    this.store.putRun(run);
    try {
      const project = this.store.project(run.projectId);
      const revisionPath = this.store.revisionPath(project, run.revisionId);
      const result = await executeProduction({
        projectDirectory: dirname(revisionPath),
        assetBaseDirectory: this.catalogPath(project.catalog),
        manifestFileName: basename(revisionPath),
        outputDirectory: join(this.outputRoot, run.id),
        cacheDirectory: this.cacheDirectory,
        renderer: new BlenderRendererAdapter(),
        media: new FfmpegMediaEngine(),
        onShotProgress: (completed, total) => {
          run.progress = { completed, total };
          this.store.putRun(run);
        },
        onLog: (line) => {
          run.logs.push(line);
          this.store.putRun(run);
        },
      });
      run.status = 'succeeded';
      run.cacheHits = result.cacheHits;
    } catch (error) {
      run.status = 'failed';
      run.error = message(error);
    } finally {
      run.finishedAt = new Date().toISOString();
      this.store.putRun(run);
    }
  }
}
