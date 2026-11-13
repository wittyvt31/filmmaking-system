import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  AssetReference,
  Output,
  ProjectSummary,
  Run,
  Validation,
} from '@filmmaking/web-api/types';
import { JsonEditor } from './editor.js';
import { api, RequestError } from './api.js';
import { AssetStudio } from './asset-studio.js';

const projectPath = (id: string) => 'projects/' + id;
const time = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const active = (run: Run) =>
  run.status === 'queued' || run.status === 'running';

function Studio() {
  const [workspace, setWorkspace] = useState<'production' | 'assets'>(
    'production',
  );
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [catalogs, setCatalogs] = useState<string[]>([]);
  const [project, setProject] = useState<ProjectSummary>();
  const [assets, setAssets] = useState<AssetReference[]>([]);
  const [revision, setRevision] = useState('');
  const [saved, setSaved] = useState('');
  const [text, setText] = useState('');
  const [validation, setValidation] = useState<Validation>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState('');
  const [detail, setDetail] = useState<{ run: Run; outputs: Output[] }>();
  const [preview, setPreview] = useState('');
  const [dialog, setDialog] = useState<'new' | 'duplicate'>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const dirty = text !== saved;

  function report(cause: unknown) {
    setError(cause instanceof Error ? cause.message : String(cause));
    if (cause instanceof RequestError && cause.issues)
      setValidation({ issues: cause.issues });
  }

  async function perform(work: () => Promise<void>) {
    setPending(true);
    setError('');
    try {
      await work();
    } catch (cause) {
      report(cause);
    } finally {
      setPending(false);
    }
  }

  async function loadRevision(target: ProjectSummary, id: string) {
    const result = await api<{ text: string }>(
      projectPath(target.id) + '/revisions/' + id,
    );
    setRevision(id);
    setText(result.text);
    setSaved(result.text);
    setValidation(undefined);
  }

  async function open(id: string) {
    const result = await api<{
      project: ProjectSummary;
      assets: AssetReference[];
    }>(projectPath(id));
    await loadRevision(result.project, result.project.revisions[0]!.id);
    setProject(result.project);
    setAssets(result.assets);
    setRuns([]);
    setSelectedRun('');
    setDetail(undefined);
    setPreview('');
  }

  useEffect(() => {
    const controller = new AbortController();
    void api<{ projects: ProjectSummary[]; catalogs: string[] }>(
      'projects',
      undefined,
      controller.signal,
    )
      .then((result) => {
        setProjects(result.projects);
        setCatalogs(result.catalogs);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) report(cause);
      });
    return () => controller.abort();
  }, []);

  const projectId = project?.id;
  useEffect(() => {
    if (!projectId || workspace !== 'production') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const [history, result] = await Promise.all([
          api<Run[]>(
            projectPath(projectId!) + '/runs',
            undefined,
            controller.signal,
          ),
          selectedRun
            ? api<{ run: Run; outputs: Output[] }>(
                'runs/' + selectedRun,
                undefined,
                controller.signal,
              )
            : undefined,
        ]);
        if (!controller.signal.aborted) {
          setRuns(history);
          setDetail(result);
          setPollError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setPollError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void refresh(), 1500);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [projectId, selectedRun, workspace]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function replace(next: ProjectSummary) {
    setProjects((current) =>
      [...current.filter((item) => item.id !== next.id), next].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    );
  }

  function leave() {
    return !dirty || window.confirm('Discard unsaved manifest changes?');
  }

  async function submitProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!leave()) return;
    await perform(async () => {
      const next =
        dialog === 'duplicate' && project
          ? await api<ProjectSummary>(projectPath(project.id) + '/duplicate', {
              name: form.get('name'),
              revisionId: revision,
            })
          : await api<ProjectSummary>('projects', {
              name: form.get('name'),
              catalog: form.get('catalog'),
            });
      replace(next);
      setDialog(undefined);
      await open(next.id);
    });
  }

  function change(value: string) {
    setText(value);
    setValidation(undefined);
  }

  async function runRevision(id: string, revisionId: string) {
    const run = await api<Run>(projectPath(id) + '/runs', { revisionId });
    setRuns((current) => [
      run,
      ...current.filter((item) => item.id !== run.id),
    ]);
    setSelectedRun(run.id);
    setDetail(undefined);
    setPreview('');
  }
  const currentOutput =
    detail?.outputs.find((item) => item.url === preview) ??
    detail?.outputs.find((item) => item.kind === 'video') ??
    detail?.outputs.find((item) => item.kind === 'image');
  const revisionNumber = (id: string) =>
    project
      ? project.revisions.length -
        project.revisions.findIndex((item) => item.id === id)
      : 0;

  return (
    <>
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden>
            F
          </span>
          Filmie <span className="muted">Studio</span>
        </div>
        <nav className="workspace-switch" aria-label="Workspaces">
          <button
            aria-pressed={workspace === 'production'}
            onClick={() => setWorkspace('production')}
          >
            Production
          </button>
          <button
            aria-pressed={workspace === 'assets'}
            onClick={() => setWorkspace('assets')}
          >
            Asset Studio
          </button>
        </nav>
        <span className="local">Local workspace</span>
      </header>
      {error && (
        <div className="banner" role="alert">
          {error}
          <button onClick={() => setError('')}>Dismiss</button>
        </div>
      )}
      <main className={workspace === 'assets' ? 'asset-main' : undefined}>
        {workspace === 'assets' ? (
          <AssetStudio
            projects={projects}
            onAttached={(id) => {
              if (project?.id !== id) return;
              void api<{ project: ProjectSummary; assets: AssetReference[] }>(
                projectPath(id),
              )
                .then((result) => setAssets(result.assets))
                .catch(report);
            }}
          />
        ) : (
          <>
            <aside className="sidebar">
              <div className="section-heading">
                <h2>Projects</h2>
                <button
                  disabled={pending || !catalogs.length}
                  onClick={() => setDialog('new')}
                >
                  + New
                </button>
              </div>
              {!projects.length && (
                <p className="muted">
                  Create a project from a prepared catalog.
                </p>
              )}
              <nav aria-label="Projects">
                {projects.map((item) => (
                  <button
                    key={item.id}
                    disabled={pending}
                    aria-current={project?.id === item.id ? 'page' : undefined}
                    onClick={() => {
                      if (project?.id !== item.id && leave())
                        void perform(() => open(item.id));
                    }}
                  >
                    <strong>{item.name}</strong>
                    <small>
                      {item.catalog} · {item.revisions.length} revisions
                    </small>
                  </button>
                ))}
              </nav>
              {project && (
                <details className="assets">
                  <summary>Asset references ({assets.length})</summary>
                  <ul>
                    {assets.map((asset) => (
                      <li key={asset.assetId + '@' + asset.version}>
                        <code>{asset.assetId}</code>
                        <small>
                          {asset.version} · {asset.type}
                        </small>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </aside>
            {project ? (
              <>
                <section className="workspace">
                  <div className="workspace-head">
                    <div>
                      <h1>{project.name}</h1>
                      <p className="muted">
                        manifest.json {dirty && '· Unsaved changes'}
                      </p>
                    </div>
                    <button
                      disabled={pending}
                      onClick={() => setDialog('duplicate')}
                    >
                      Duplicate revision
                    </button>
                  </div>
                  <div className="toolbar">
                    <label>
                      <span className="sr-only">Revision history</span>
                      <select
                        value={revision}
                        disabled={pending}
                        onChange={(event) => {
                          const id = event.target.value;
                          if (leave())
                            void perform(() => loadRevision(project, id));
                        }}
                      >
                        {project.revisions.map((item) => (
                          <option value={item.id} key={item.id}>
                            r{revisionNumber(item.id)} · {time(item.createdAt)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      disabled={pending}
                      onClick={() => {
                        try {
                          change(
                            JSON.stringify(JSON.parse(text), null, 2) + '\n',
                          );
                        } catch (cause) {
                          report(cause);
                        }
                      }}
                    >
                      Format
                    </button>
                    <button
                      disabled={pending}
                      onClick={() =>
                        void perform(async () =>
                          setValidation(
                            await api<Validation>(
                              projectPath(project.id) + '/validate',
                              { text },
                            ),
                          ),
                        )
                      }
                    >
                      Validate
                    </button>
                    <button
                      disabled={pending || !dirty}
                      onClick={() =>
                        void perform(async () => {
                          const next = await api<ProjectSummary>(
                            projectPath(project.id) + '/revisions',
                            { text, baseRevisionId: project.revisions[0]!.id },
                          );
                          setProject(next);
                          replace(next);
                          setRevision(next.revisions[0]!.id);
                          setSaved(text);
                        })
                      }
                    >
                      Save revision
                    </button>
                    <button
                      className="primary run"
                      disabled={pending || dirty}
                      title={
                        dirty ? 'Save a revision before running' : undefined
                      }
                      onClick={() =>
                        void perform(() => runRevision(project.id, revision))
                      }
                    >
                      Run revision
                    </button>
                  </div>
                  <JsonEditor
                    value={text}
                    onChange={change}
                    invalid={!!validation?.issues.length}
                    readOnly={pending}
                  />
                  {validation && (
                    <section className="validation" aria-live="polite">
                      {validation.issues.length ? (
                        <>
                          <strong>
                            {validation.issues.length} validation issues
                          </strong>
                          <ul>
                            {validation.issues.map((issue, index) => (
                              <li key={index}>
                                <code>{issue.path}</code> {issue.message}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        <strong className="success">
                          Valid · {validation.shots} shots · {validation.frames}{' '}
                          frames
                        </strong>
                      )}
                    </section>
                  )}
                </section>
                <aside className="activity">
                  <div className="section-heading">
                    <h2>Production runs</h2>
                  </div>
                  {pollError && <p role="alert">{pollError}</p>}
                  {!runs.length && (
                    <p className="muted">
                      Run a saved revision to see its progress and outputs.
                    </p>
                  )}
                  <div className="history">
                    {runs.map((run) => (
                      <button
                        key={run.id}
                        aria-pressed={run.id === selectedRun}
                        onClick={() => {
                          setSelectedRun(run.id);
                          setDetail(undefined);
                          setPreview('');
                        }}
                      >
                        <span>
                          r{revisionNumber(run.revisionId)} ·{' '}
                          {time(run.createdAt)}
                        </span>
                        <small className={'status ' + run.status}>
                          {run.status}
                        </small>
                      </button>
                    ))}
                  </div>
                  {detail && (
                    <div className="run-detail">
                      <p
                        className={'status ' + detail.run.status}
                        role="status"
                      >
                        {detail.run.status}
                        {active(detail.run) &&
                          ' · ' +
                            (detail.run.logs.at(-1) ??
                              'Waiting for production')}
                      </p>
                      {detail.run.error && (
                        <p role="alert" className="failure">
                          {detail.run.error}
                        </p>
                      )}
                      {!active(detail.run) && (
                        <button
                          className="rerun"
                          disabled={pending}
                          onClick={() =>
                            void perform(() =>
                              runRevision(project.id, detail.run.revisionId),
                            )
                          }
                        >
                          Rerun r{revisionNumber(detail.run.revisionId)}
                        </button>
                      )}
                      {detail.run.progress && (
                        <label className="shot-progress">
                          {detail.run.progress.completed} /{' '}
                          {detail.run.progress.total} shots prepared
                          <progress
                            value={detail.run.progress.completed}
                            max={detail.run.progress.total}
                          />
                        </label>
                      )}
                      {detail.run.cacheHits && (
                        <p className="muted">
                          Cache · {detail.run.cacheHits.shots} shots
                          {detail.run.cacheHits.assembly &&
                            ' · assembly reused'}
                        </p>
                      )}
                      <details open>
                        <summary>Logs ({detail.run.logs.length})</summary>
                        <pre className="logs">
                          {detail.run.logs.join('\n') ||
                            'Waiting for pipeline logs…'}
                        </pre>
                      </details>
                      {detail.outputs.length > 0 && (
                        <section className="outputs">
                          <h3>Outputs</h3>
                          {currentOutput?.kind === 'video' && (
                            <video
                              key={currentOutput.url}
                              src={currentOutput.url}
                              controls
                              preload="metadata"
                            />
                          )}
                          {currentOutput?.kind === 'image' && (
                            <img
                              src={currentOutput.url}
                              alt={currentOutput.name}
                            />
                          )}
                          <ul>
                            {detail.outputs.map((item) => (
                              <li key={item.url}>
                                {item.kind !== 'file' && (
                                  <button
                                    onClick={() => setPreview(item.url)}
                                    aria-pressed={
                                      currentOutput?.url === item.url
                                    }
                                  >
                                    Preview
                                  </button>
                                )}
                                <a href={item.url} download title={item.name}>
                                  {item.name.split('/').at(-1)}
                                </a>
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                    </div>
                  )}
                </aside>
              </>
            ) : (
              <section className="empty">
                <h1>Open a production project</h1>
                <p className="muted">
                  Start with a prepared manifest and its versioned assets.
                </p>
                <button
                  className="primary"
                  disabled={!catalogs.length || pending}
                  onClick={() => setDialog('new')}
                >
                  Create project
                </button>
              </section>
            )}
          </>
        )}
      </main>
      {dialog && (
        <div className="overlay">
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-dialog"
          >
            <h2 id="project-dialog">
              {dialog === 'new' ? 'Create project' : 'Duplicate saved revision'}
            </h2>
            <form onSubmit={(event) => void submitProject(event)}>
              <label>
                Project name
                <input
                  name="name"
                  required
                  maxLength={120}
                  autoFocus
                  defaultValue={
                    dialog === 'duplicate' ? project?.name + ' copy' : ''
                  }
                />
              </label>
              {dialog === 'new' && (
                <label>
                  Prepared catalog
                  <select
                    name="catalog"
                    defaultValue={
                      catalogs.includes('3d-production')
                        ? '3d-production'
                        : catalogs[0]
                    }
                  >
                    {catalogs.map((item) => (
                      <option key={item}>{item}</option>
                    ))}
                  </select>
                </label>
              )}
              <div className="dialog-actions">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => setDialog(undefined)}
                >
                  Cancel
                </button>
                <button className="primary" disabled={pending}>
                  {dialog === 'new' ? 'Create project' : 'Duplicate'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Studio />);
