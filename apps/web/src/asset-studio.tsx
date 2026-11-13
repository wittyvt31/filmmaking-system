import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssetStudioAsset,
  AssetStudioBuildResult,
  AssetStudioValidation,
  ProceduralAssetDefinition,
  ProjectSummary,
} from '@filmmaking/web-api/types';
import { api } from './api.js';
import { JsonEditor } from './editor.js';
import { AssetViewport } from './asset-viewport.js';

type Part = ProceduralAssetDefinition['parts'][number];
type Mesh = ProceduralAssetDefinition['meshes'][number];
type Shape = Mesh['shape'];
type Material = ProceduralAssetDefinition['materials'][number];
type BasicShape = Extract<
  Shape['kind'],
  'box' | 'sphere' | 'cylinder' | 'cone'
>;

const axes = ['x', 'y', 'z'] as const;

function baseTransform(): Part['transform'] {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotationDegrees: { x: 0, y: 0, z: 0 },
    scale: 1,
  };
}

function newBox(): ProceduralAssetDefinition {
  return {
    schemaVersion: 1,
    assetId: 'filmie.asset.new-prop',
    assetVersion: '1.0.0',
    kind: 'mechanical-prop',
    materials: [
      {
        id: 'mat.base',
        color: [0.32, 0.62, 0.86],
        metallic: 0.15,
        roughness: 0.55,
      },
    ],
    meshes: [
      {
        id: 'mesh.body',
        materialId: 'mat.base',
        shape: { kind: 'box', dimensions: [1.5, 1, 0.8] },
      },
    ],
    parts: [{ id: 'body', meshId: 'mesh.body', transform: baseTransform() }],
    handles: [],
    joints: [],
    capabilities: {
      verified: [],
      unsupported: [],
      unknown: [],
      requirements: [],
      mappings: [],
    },
    colliders: [],
    sockets: [],
    provenance: { source: 'filmie-asset-studio', notes: [] },
  };
}

const basicShape = (kind: BasicShape): Shape => {
  switch (kind) {
    case 'box':
      return { kind, dimensions: [1, 1, 1] };
    case 'sphere':
      return { kind, radius: 0.5, segments: 24, rings: 12 };
    case 'cylinder':
      return { kind, radius: 0.5, height: 1, segments: 24 };
    case 'cone':
      return { kind, radius: 0.5, height: 1, segments: 24 };
  }
};

const toHex = (color: readonly number[]) =>
  '#' +
  color
    .map((component) =>
      Math.round(Math.max(0, Math.min(1, component)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

function fromHex(value: string): [number, number, number] {
  return [1, 3, 5].map(
    (start) => Number.parseInt(value.slice(start, start + 2), 16) / 255,
  ) as [number, number, number];
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function AssetStudio({
  projects,
  onAttached,
}: {
  projects: ProjectSummary[];
  onAttached?: (projectId: string) => void;
}) {
  const [definition, setDefinition] = useState<ProceduralAssetDefinition>();
  const [selected, setSelected] = useState('');
  const [library, setLibrary] = useState<AssetStudioAsset[]>([]);
  const [validation, setValidation] = useState<AssetStudioValidation>();
  const [result, setResult] = useState<AssetStudioBuildResult>();
  const [mode, setMode] = useState<'visual' | 'json'>('visual');
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [projectId, setProjectId] = useState('');
  const upload = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api<{ definition: ProceduralAssetDefinition }>(
        'asset-studio/template',
        undefined,
        controller.signal,
      ),
      api<{ assets: AssetStudioAsset[] }>(
        'asset-studio/assets',
        undefined,
        controller.signal,
      ),
    ])
      .then(async ([template, assets]) => {
        if (controller.signal.aborted) return;
        let initial = template.definition;
        try {
          const saved = localStorage.getItem('filmie.asset-studio.draft');
          if (saved) {
            const parsed = JSON.parse(saved) as ProceduralAssetDefinition;
            const check = await api<AssetStudioValidation>(
              'asset-studio/validate',
              { definition: parsed },
              controller.signal,
            );
            if (check.valid) initial = parsed;
          }
        } catch {
          // Browsers may disallow storage; the server template remains usable.
        }
        setDefinition(initial);
        setSelected(initial.parts[0]?.id ?? '');
        setLibrary(assets.assets);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(message(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!definition) return;
    try {
      localStorage.setItem(
        'filmie.asset-studio.draft',
        JSON.stringify(definition),
      );
    } catch {
      // The editor remains usable without local browser storage.
    }
  }, [definition]);

  const part = definition?.parts.find((item) => item.id === selected);
  const mesh = definition?.meshes.find((item) => item.id === part?.meshId);
  const material = definition?.materials.find(
    (item) => item.id === mesh?.materialId,
  );
  const validParts = useMemo(
    () => definition?.parts.map((item) => item.id) ?? [],
    [definition],
  );

  function modify(
    change: (value: ProceduralAssetDefinition) => ProceduralAssetDefinition,
  ) {
    setDefinition((current) => (current ? change(current) : current));
    setValidation(undefined);
    setResult(undefined);
    setNotice('');
  }

  function editPart(change: (value: Part) => Part) {
    modify((current) => ({
      ...current,
      parts: current.parts.map((item) =>
        item.id === selected ? change(item) : item,
      ),
    }));
  }

  function editMesh(change: (value: Mesh) => Mesh) {
    const id = mesh?.id;
    if (!id) return;
    modify((current) => ({
      ...current,
      meshes: current.meshes.map((item) =>
        item.id === id ? change(item) : item,
      ),
    }));
  }

  function editMaterial(change: (value: Material) => Material) {
    const id = material?.id;
    if (!id) return;
    modify((current) => ({
      ...current,
      materials: current.materials.map((item) =>
        item.id === id ? change(item) : item,
      ),
    }));
  }

  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  async function refreshLibrary() {
    const assets = await api<{ assets: AssetStudioAsset[] }>(
      'asset-studio/assets',
    );
    setLibrary(assets.assets);
  }

  function load(value: ProceduralAssetDefinition) {
    setDefinition(value);
    setSelected(value.parts[0]?.id ?? '');
    setMode('visual');
    setRaw('');
    setValidation(undefined);
    setResult(undefined);
    setError('');
    setNotice('');
  }

  function openJson() {
    if (!definition) return;
    setRaw(JSON.stringify(definition, null, 2) + '\n');
    setMode('json');
  }

  function applyJson() {
    try {
      const value = JSON.parse(raw) as ProceduralAssetDefinition;
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Definition must be a JSON object.');
      load(value);
    } catch (cause) {
      setError('Invalid definition JSON: ' + message(cause));
    }
  }

  function downloadDefinition() {
    if (!definition) return;
    const blob = new Blob([JSON.stringify(definition, null, 2) + '\n'], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = definition.assetId.replace(/[^a-z0-9.-]/gi, '_') + '.json';
    link.click();
    URL.revokeObjectURL(url);
  }

  function addPart() {
    if (!definition) return;
    let index = definition.parts.length + 1;
    while (definition.parts.some((value) => value.id === 'part-' + index))
      index += 1;
    const id = 'part-' + index;
    const meshId = 'mesh.' + id;
    const parentId = selected || undefined;
    modify((current) => ({
      ...current,
      meshes: [
        ...current.meshes,
        {
          id: meshId,
          materialId: current.materials[0]!.id,
          shape: basicShape('box'),
        },
      ],
      parts: [
        ...current.parts,
        {
          id,
          meshId,
          ...(parentId ? { parentId } : {}),
          transform: baseTransform(),
        },
      ],
    }));
    setSelected(id);
  }

  function removePart() {
    if (!definition || !part) return;
    const referenced =
      definition.parts.some((item) => item.parentId === part.id) ||
      definition.joints.some(
        (joint) =>
          joint.parentPartId === part.id ||
          joint.childPartId === part.id ||
          joint.pivotPartId === part.id,
      ) ||
      definition.handles.some((handle) => handle.partId === part.id) ||
      definition.sockets.some(
        (socket) =>
          socket.node === part.id || socket.node === 'part.' + part.id,
      ) ||
      definition.colliders.some(
        (collider) =>
          collider.node === part.id || collider.node === 'part.' + part.id,
      );
    if (referenced) {
      setError(
        'Remove linked children, joints and handles before deleting this part.',
      );
      return;
    }
    const meshId = part.meshId;
    modify((current) => {
      const remaining = current.parts.filter((item) => item.id !== selected);
      return {
        ...current,
        parts: remaining,
        meshes: remaining.some((item) => item.meshId === meshId)
          ? current.meshes
          : current.meshes.filter((item) => item.id !== meshId),
      };
    });
    setSelected(
      definition.parts.find((item) => item.id !== selected)?.id ?? '',
    );
  }

  async function validate() {
    if (!definition) return;
    await perform(async () => {
      const response = await api<AssetStudioValidation>(
        'asset-studio/validate',
        {
          definition,
        },
      );
      setValidation(response);
      setNotice(
        response.valid ? 'Definition is valid and ready to generate.' : '',
      );
    });
  }

  async function generate() {
    if (!definition || mode === 'json') return;
    await perform(async () => {
      const check = await api<AssetStudioValidation>('asset-studio/validate', {
        definition,
      });
      setValidation(check);
      if (!check.valid) {
        setError('Fix the listed validation issues before generating.');
        return;
      }
      const built = await api<AssetStudioBuildResult>('asset-studio/build', {
        definition,
      });
      setResult(built);
      await refreshLibrary();
      if (built.preview.status === 'rendered') {
        setNotice(
          built.status === 'reused'
            ? 'Identical asset version reused. Blender preview refreshed.'
            : 'Published GLB and generated Blender preview successfully.',
        );
      } else {
        setError(
          'GLB published, but Blender preview failed: ' +
            (built.preview.message ?? 'Unknown preview error'),
        );
      }
    });
  }

  async function attach(asset: AssetStudioAsset) {
    if (!projectId) return;
    await perform(async () => {
      await api('asset-studio/attach', {
        projectId,
        assetId: asset.assetId,
        version: asset.version,
      });
      setNotice(
        asset.assetId +
          '@' +
          asset.version +
          ' added to the project registry. Reference it in a scene manifest to use it.',
      );
      onAttached?.(projectId);
    });
  }

  if (loading)
    return (
      <section className="asset-studio-loading">
        <h1>Asset Studio</h1>
        <p>Loading procedural asset library…</p>
      </section>
    );

  return (
    <section className="asset-studio">
      <div className="asset-studio-head">
        <div>
          <p className="eyebrow">ASSET FACTORY / PROCEDURAL</p>
          <h1>Asset Studio</h1>
          <p className="muted">
            Author geometry and materials, publish a GLB, and inspect a real
            Blender render.
          </p>
        </div>
        <div className="asset-actions">
          <button disabled={busy} onClick={() => load(newBox())}>
            New box
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const response = await api<{
                  definition: ProceduralAssetDefinition;
                }>('asset-studio/template');
                load(response.definition);
              })
            }
          >
            Crane preset
          </button>
          <button disabled={busy} onClick={() => upload.current?.click()}>
            Import JSON
          </button>
          <button disabled={!definition} onClick={downloadDefinition}>
            Export JSON
          </button>
          <input
            ref={upload}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void perform(async () => {
                const parsed = JSON.parse(
                  await file.text(),
                ) as ProceduralAssetDefinition;
                const check = await api<AssetStudioValidation>(
                  'asset-studio/validate',
                  { definition: parsed },
                );
                if (!check.valid)
                  throw new Error(
                    'Imported definition is invalid:\\n' +
                      check.issues
                        .map((issue) => issue.path + ': ' + issue.message)
                        .join('\\n'),
                  );
                load(parsed);
                setNotice('Imported and validated the asset definition.');
              });
              event.currentTarget.value = '';
            }}
          />
        </div>
      </div>

      {error && (
        <div className="asset-alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="asset-notice" role="status">
          {notice}
        </div>
      )}

      {definition ? (
        <>
          <div className="asset-identity">
            <label>
              Asset ID
              <input
                value={definition.assetId}
                onChange={(event) =>
                  modify((current) => ({
                    ...current,
                    assetId: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Immutable version
              <input
                value={definition.assetVersion}
                onChange={(event) =>
                  modify((current) => ({
                    ...current,
                    assetVersion: event.target.value,
                  }))
                }
              />
            </label>
            <label>
              Asset type
              <select
                value={definition.kind}
                onChange={(event) =>
                  modify((current) => ({
                    ...current,
                    kind: event.target
                      .value as ProceduralAssetDefinition['kind'],
                  }))
                }
              >
                {[
                  'mechanical-prop',
                  'furniture',
                  'architectural-structure',
                  'modular-environment',
                  'articulated-assembly',
                ].map((kind) => (
                  <option key={kind} value={kind}>
                    {kind.replaceAll('-', ' ')}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="asset-studio-main">
            <aside className="asset-part-list">
              <div className="section-heading">
                <h2>Geometry hierarchy</h2>
                <button disabled={busy} onClick={addPart}>
                  + Part
                </button>
              </div>
              <div className="asset-parts">
                {definition.parts.map((item) => (
                  <button
                    key={item.id}
                    className={item.id === selected ? 'selected' : ''}
                    aria-pressed={item.id === selected}
                    onClick={() => setSelected(item.id)}
                  >
                    <strong>{item.id}</strong>
                    <small>
                      {item.parentId ? '↳ ' + item.parentId : 'Root'} ·{' '}
                      {item.meshId}
                    </small>
                  </button>
                ))}
              </div>
              <div className="asset-metrics">
                <span>{definition.parts.length} parts</span>
                <span>{definition.meshes.length} meshes</span>
                <span>{definition.joints.length} joints</span>
              </div>
              <details className="asset-joint-list">
                <summary>Articulation ({definition.joints.length})</summary>
                {definition.joints.map((joint) => (
                  <div key={joint.id}>
                    <strong>{joint.id}</strong>
                    <small>
                      {joint.type} · {joint.parentPartId} → {joint.childPartId}
                    </small>
                  </div>
                ))}
                <p className="muted">
                  Adjust detailed joint limits and semantic mappings in Advanced
                  JSON.
                </p>
              </details>
            </aside>

            <div className="asset-preview-panel">
              <div className="asset-view-tabs">
                <button
                  aria-pressed={mode === 'visual'}
                  onClick={() => {
                    if (mode === 'json') applyJson();
                    else setMode('visual');
                  }}
                >
                  Visual editor
                </button>
                <button aria-pressed={mode === 'json'} onClick={openJson}>
                  Advanced JSON
                </button>
              </div>
              {mode === 'visual' ? (
                <>
                  <AssetViewport
                    definition={definition}
                    selected={selected}
                    onSelect={setSelected}
                  />
                  <p className="asset-hint">
                    Live geometry preview · Blender generates the final
                    authoritative GLB. Shapes, hierarchy and material colors
                    update immediately.
                  </p>
                </>
              ) : (
                <>
                  <JsonEditor
                    value={raw}
                    onChange={setRaw}
                    invalid={!!error}
                    readOnly={busy}
                  />
                  <button
                    className="primary"
                    onClick={applyJson}
                    disabled={busy}
                  >
                    Apply JSON to scene
                  </button>
                </>
              )}

              <div className="asset-build-bar">
                <button
                  onClick={() => void validate()}
                  disabled={busy || mode === 'json'}
                >
                  Validate
                </button>
                <button
                  className="primary"
                  onClick={() => void generate()}
                  disabled={busy || mode === 'json'}
                >
                  {busy ? 'Working…' : 'Generate + publish GLB'}
                </button>
              </div>
              {validation && (
                <div className="asset-validation" aria-live="polite">
                  {validation.valid ? (
                    <strong className="success">
                      Valid · {validation.partCount} parts ·{' '}
                      {validation.jointCount} joints
                    </strong>
                  ) : (
                    <>
                      <strong>
                        {validation.issues.length} validation issue(s)
                      </strong>
                      <ul>
                        {validation.issues.map((issue, index) => (
                          <li key={index}>
                            <code>{issue.path}</code>: {issue.message}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
              {result && (
                <div className="asset-result">
                  <div className="section-heading">
                    <h2>Published output</h2>
                    <span className="success">{result.status}</span>
                  </div>
                  {result.asset.previewUrl && (
                    <img
                      src={
                        result.asset.previewUrl +
                        '?asset=' +
                        result.asset.contentHash
                      }
                      alt="Real Blender rendering of generated asset"
                    />
                  )}
                  <div className="asset-output-links">
                    <a href={result.asset.glbUrl} download>
                      Download GLB
                    </a>
                    {result.asset.previewUrl && (
                      <a href={result.asset.previewUrl} download>
                        Download PNG
                      </a>
                    )}
                    <span className="muted">
                      {result.asset.contentHash.slice(0, 16)}…
                    </span>
                  </div>
                </div>
              )}
            </div>

            <aside className="asset-properties">
              <div className="section-heading">
                <h2>Properties</h2>
              </div>
              {part && mesh ? (
                <div className="asset-property-fields">
                  <h3>{part.id}</h3>
                  <label>
                    Parent
                    <select
                      value={part.parentId ?? ''}
                      onChange={(event) =>
                        editPart((current) => ({
                          ...current,
                          ...(event.target.value
                            ? { parentId: event.target.value }
                            : { parentId: undefined }),
                        }))
                      }
                    >
                      <option value="">None (root)</option>
                      {validParts
                        .filter((id) => id !== part.id)
                        .map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                    </select>
                  </label>

                  <h3>Position (m)</h3>
                  <div className="asset-vector">
                    {axes.map((axis) => (
                      <label key={axis}>
                        {axis.toUpperCase()}
                        <input
                          type="number"
                          step="0.1"
                          value={part.transform.position[axis]}
                          onChange={(event) =>
                            editPart((current) => ({
                              ...current,
                              transform: {
                                ...current.transform,
                                position: {
                                  ...current.transform.position,
                                  [axis]: Number(event.target.value),
                                },
                              },
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>

                  <h3>Rotation (degrees)</h3>
                  <div className="asset-vector">
                    {axes.map((axis) => (
                      <label key={axis}>
                        {axis.toUpperCase()}
                        <input
                          type="number"
                          step="5"
                          value={part.transform.rotationDegrees[axis]}
                          onChange={(event) =>
                            editPart((current) => ({
                              ...current,
                              transform: {
                                ...current.transform,
                                rotationDegrees: {
                                  ...current.transform.rotationDegrees,
                                  [axis]: Number(event.target.value),
                                },
                              },
                            }))
                          }
                        />
                      </label>
                    ))}
                  </div>

                  <h3>Mesh shape</h3>
                  <label>
                    Primitive
                    <select
                      value={mesh.shape.kind}
                      onChange={(event) =>
                        editMesh((current) => ({
                          ...current,
                          shape: basicShape(event.target.value as BasicShape),
                        }))
                      }
                    >
                      {['box', 'cylinder', 'sphere', 'cone'].map((kind) => (
                        <option key={kind} value={kind}>
                          {kind}
                        </option>
                      ))}
                      {!['box', 'sphere', 'cylinder', 'cone'].includes(
                        mesh.shape.kind,
                      ) && (
                        <option value={mesh.shape.kind}>
                          {mesh.shape.kind} (advanced)
                        </option>
                      )}
                    </select>
                  </label>

                  {mesh.shape.kind === 'box' && (
                    <div className="asset-vector">
                      {axes.map((axis, index) => (
                        <label key={axis}>
                          {axis.toUpperCase()}
                          <input
                            type="number"
                            min="0.001"
                            step="0.1"
                            value={
                              mesh.shape.kind === 'box'
                                ? mesh.shape.dimensions[index]
                                : 1
                            }
                            onChange={(event) =>
                              editMesh((current) => {
                                if (current.shape.kind !== 'box')
                                  return current;
                                const dimensions = [
                                  ...current.shape.dimensions,
                                ] as [number, number, number];
                                dimensions[index] = Number(event.target.value);
                                return {
                                  ...current,
                                  shape: { kind: 'box', dimensions },
                                };
                              })
                            }
                          />
                        </label>
                      ))}
                    </div>
                  )}
                  {['sphere', 'cone', 'cylinder'].includes(mesh.shape.kind) && (
                    <label>
                      Radius
                      <input
                        type="number"
                        min="0.001"
                        step="0.1"
                        value={'radius' in mesh.shape ? mesh.shape.radius : 0.5}
                        onChange={(event) =>
                          editMesh((current) => {
                            if (!('radius' in current.shape)) return current;
                            return {
                              ...current,
                              shape: {
                                ...current.shape,
                                radius: Number(event.target.value),
                              },
                            };
                          })
                        }
                      />
                    </label>
                  )}
                  {(mesh.shape.kind === 'cone' ||
                    mesh.shape.kind === 'cylinder') && (
                    <label>
                      Height
                      <input
                        type="number"
                        min="0.001"
                        step="0.1"
                        value={mesh.shape.height}
                        onChange={(event) =>
                          editMesh((current) => {
                            if (
                              current.shape.kind !== 'cone' &&
                              current.shape.kind !== 'cylinder'
                            )
                              return current;
                            return {
                              ...current,
                              shape: {
                                ...current.shape,
                                height: Number(event.target.value),
                              },
                            };
                          })
                        }
                      />
                    </label>
                  )}

                  <h3>Surface material</h3>
                  <label>
                    Material
                    <select
                      value={mesh.materialId}
                      onChange={(event) =>
                        editMesh((current) => ({
                          ...current,
                          materialId: event.target.value,
                        }))
                      }
                    >
                      {definition.materials.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  {material && (
                    <>
                      <label>
                        Color
                        <input
                          type="color"
                          value={toHex(material.color)}
                          onChange={(event) =>
                            editMaterial((current) => ({
                              ...current,
                              color: fromHex(event.target.value),
                            }))
                          }
                        />
                      </label>
                      {(['roughness', 'metallic'] as const).map((field) => (
                        <label key={field}>
                          {field}
                          <input
                            type="range"
                            min="0"
                            max="1"
                            step="0.05"
                            value={material[field]}
                            onChange={(event) =>
                              editMaterial((current) => ({
                                ...current,
                                [field]: Number(event.target.value),
                              }))
                            }
                          />
                          <small>{material[field].toFixed(2)}</small>
                        </label>
                      ))}
                    </>
                  )}
                  <button
                    className="asset-remove"
                    disabled={busy}
                    onClick={removePart}
                  >
                    Remove selected part
                  </button>
                </div>
              ) : (
                <p className="muted">
                  Select a part to edit its geometry and materials.
                </p>
              )}
            </aside>
          </div>
        </>
      ) : (
        <p className="muted">Could not load an asset definition.</p>
      )}

      <section className="asset-library">
        <div className="section-heading">
          <div>
            <h2>Published library</h2>
            <p className="muted">
              Immutable generated assets · available for production
            </p>
          </div>
          <label className="asset-project-select">
            Attach to project
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Select a project</option>
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!library.length && (
          <p className="muted">
            No generated assets yet. Publish your first asset above.
          </p>
        )}
        <div className="asset-library-grid">
          {library.map((asset) => (
            <div
              className="asset-library-item"
              key={asset.assetId + '@' + asset.version}
            >
              {asset.previewUrl ? (
                <img
                  src={asset.previewUrl}
                  alt={'Preview of ' + asset.assetId}
                />
              ) : (
                <div className="asset-no-preview">No preview</div>
              )}
              <strong>{asset.assetId}</strong>
              <small>
                {asset.version} · {asset.partCount} parts · {asset.jointCount}{' '}
                joints
              </small>
              <div className="asset-library-actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(async () => {
                      const entry = await api<{
                        definition: ProceduralAssetDefinition;
                      }>(
                        'asset-studio/definitions/' +
                          encodeURIComponent(asset.assetId) +
                          '/' +
                          encodeURIComponent(asset.version),
                      );
                      load(entry.definition);
                      setNotice(
                        'Loaded a published definition. Change the version before publishing edits.',
                      );
                    })
                  }
                >
                  Edit
                </button>
                <a href={asset.glbUrl} download>
                  GLB
                </a>
                <button
                  disabled={busy || !projectId}
                  onClick={() => void attach(asset)}
                >
                  Attach
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}
