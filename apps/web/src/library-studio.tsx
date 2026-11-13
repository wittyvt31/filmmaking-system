import { useEffect, useState } from 'react';
import type {
  LibraryAsset,
  LibraryInspection,
  LibraryWorld,
  LibraryWorldInstance,
  ProjectSummary,
  VisualUniverse,
} from '@filmmaking/web-api/types';
import { api } from './api.js';

const emptyWorld = (): LibraryWorld => ({
  id: 'world.house-night',
  version: '1.0.0',
  name: 'House at Night',
  universeId: 'cinematic-horror',
  theme: 'horror',
  instances: [],
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const vector = () => ({ x: 0, y: 0, z: 0 });

export function LibraryStudio({
  projects,
  onApplied,
}: {
  projects: ProjectSummary[];
  onApplied?: (projectId: string) => void;
}) {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [universes, setUniverses] = useState<VisualUniverse[]>([]);
  const [worlds, setWorlds] = useState<LibraryWorld[]>([]);
  const [inboxPath, setInboxPath] = useState('');
  const [filterUniverse, setFilterUniverse] = useState('cinematic-horror');
  const [filterTheme, setFilterTheme] = useState('');
  const [world, setWorld] = useState<LibraryWorld>(emptyWorld);
  const [selectedAsset, setSelectedAsset] = useState('');
  const [projectId, setProjectId] = useState('');
  const [stage, setStage] = useState('');
  const [assetId, setAssetId] = useState('props.smartphone.black');
  const [version, setVersion] = useState('1.0.0');
  const [category, setCategory] = useState('prop');
  const [provider, setProvider] = useState('Blendkit');
  const [sourceUrl, setSourceUrl] = useState('');
  const [licenseName, setLicenseName] = useState('');
  const [themes, setThemes] = useState('horror');
  const [inspection, setInspection] = useState<LibraryInspection>();
  const [universe, setUniverse] = useState<VisualUniverse>({
    id: 'stylized-horror',
    name: 'Stylized Horror',
    visualStyle: 'stylized',
    description: '',
    palette: ['#243040', '#b9a6a2'],
    shadingNotes: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function reload() {
    const [assetData, universesData, worldsData, config] = await Promise.all([
      api<{ assets: LibraryAsset[] }>('external-library/assets'),
      api<{ universes: VisualUniverse[] }>('external-library/universes'),
      api<{ worlds: LibraryWorld[] }>('external-library/worlds'),
      api<{ inboxDirectory: string }>('external-library/config'),
    ]);
    setAssets(assetData.assets);
    setUniverses(universesData.universes);
    setWorlds(worldsData.worlds);
    setInboxPath(config.inboxDirectory);
  }
  useEffect(() => {
    void reload().catch((cause) => setError(message(cause)));
  }, []);

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

  function addInstance() {
    const [id, version] = selectedAsset.split('@');
    if (!id || !version) return;
    let n = world.instances.length + 1;
    while (world.instances.some((instance) => instance.id === 'item-' + n)) n += 1;
    const entry: LibraryWorldInstance = {
      id: 'item-' + n,
      assetId: id,
      version,
      transform: {
        position: vector(),
        rotationDegrees: vector(),
        scale: 1,
      },
    };
    setWorld((current) => ({ ...current, instances: [...current.instances, entry] }));
  }

  function editInstance(id: string, change: (entry: LibraryWorldInstance) => LibraryWorldInstance) {
    setWorld((current) => ({
      ...current,
      instances: current.instances.map((entry) => entry.id === id ? change(entry) : entry),
    }));
  }

  const visible = assets.filter((asset) => {
    if (filterUniverse && asset.library.universeId !== filterUniverse) return false;
    return !filterTheme || asset.library.themes?.includes(filterTheme);
  });
  const available = assets.filter(
    (asset) => asset.library.universeId === world.universeId,
  );

  return (
    <section className="asset-studio library-studio">
      <div className="asset-studio-head">
        <div>
          <p className="eyebrow">EXTERNAL ASSETS / REUSABLE WORLDS</p>
          <h1>Filmie Library &amp; Worlds</h1>
          <p className="muted">
            Bring selected models from Blender into Filmie, organize them by visual universe
            and build reusable environments from versioned assets.
          </p>
        </div>
        <button disabled={busy} onClick={() => void perform(reload)}>
          Refresh library
        </button>
      </div>
      {error && <div className="asset-alert" role="alert">{error}</div>}
      {notice && <div className="asset-notice" role="status">{notice}</div>}
      <div className="library-panel-grid">
        <section className="library-panel">
          <h2>1 · Publish from Blender</h2>
          <p className="muted">
            Install <code>tools/blender/filmie_bridge/__init__.py</code> as a Blender
            add-on. In Blender, select the downloaded model and its armature/meshes,
            then use <strong>N → Filmie → Publish Selection</strong>.
          </p>
          <label>Local staging inbox
            <input readOnly value={inboxPath} aria-label="Blender staging inbox path"/>
          </label>
          <p className="muted">
            The add-on exports a self-contained GLB and publishes it through this
            local server. For assets already exported into the inbox, publish below.
          </p>
          <div className="library-fields">
            <label>Staged GLB filename
              <input value={stage} onChange={(event) => setStage(event.target.value)} placeholder="asset-file.glb"/>
            </label>
            <label>Asset ID
              <input value={assetId} onChange={(event) => setAssetId(event.target.value)}/>
            </label>
            <label>Immutable version
              <input value={version} onChange={(event) => setVersion(event.target.value)}/>
            </label>
            <label>Category
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                {['environment', 'character', 'prop', 'vehicle'].map((value) => <option key={value}>{value}</option>)}
              </select>
            </label>
            <label>Visual universe
              <select value={filterUniverse} onChange={(event) => setFilterUniverse(event.target.value)}>
                {universes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label>Theme tags, comma separated
              <input value={themes} onChange={(event) => setThemes(event.target.value)}/>
            </label>
            <label>Source provider
              <input value={provider} onChange={(event) => setProvider(event.target.value)}/>
            </label>
            <label>Original asset page (optional)
              <input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)}/>
            </label>
            <label>Actual asset license (required)
              <input value={licenseName} onChange={(event) => setLicenseName(event.target.value)} placeholder="Enter verified license"/>
            </label>
          </div>
          <div className="asset-actions">
            <button disabled={busy || !stage} onClick={() => void perform(async () => {
              const data = await api<LibraryInspection>('external-library/inspect', { filename: stage });
              setInspection(data);
              setNotice('GLB inspected. Review rig and facial diagnostics below.');
            })}>Inspect staged GLB</button>
            <button className="primary" disabled={busy || !stage || !licenseName.trim()} onClick={() => void perform(async () => {
              await api('external-library/import', {
                filename: stage, assetId, version, category, universeId: filterUniverse,
                themes: themes.split(',').map((value) => value.trim()).filter(Boolean),
                sourceProvider: provider, ...(sourceUrl.trim() ? { sourceUrl } : {}),
                license: { name: licenseName, restrictions: [] }, preview: false,
              });
              setInspection(undefined);
              await reload();
              setNotice('Asset published into Filmie. It can now be reused in worlds and productions.');
            })}>Publish staged GLB</button>
          </div>
          {inspection && (
            <div className="asset-validation">
              <strong>{inspection.meshCount} meshes · {inspection.nodeCount} nodes · {inspection.materialCount} materials</strong>
              <p>Rig: {inspection.character.status}; {inspection.character.skeletonCount} skeleton(s), {inspection.character.boneCount} bones</p>
              <p>Facial controls: {inspection.character.facial} ({inspection.character.morphTargetCount} morph targets)</p>
              {inspection.character.issues.map((issue) => <p key={issue} className="muted">{issue}</p>)}
              <details>
                <summary>Suggested joint mappings (review required)</summary>
                <pre>{JSON.stringify(inspection.character.suggestedJointMap, null, 2)}</pre>
              </details>
            </div>
          )}
        </section>
        <section className="library-panel">
          <h2>2 · Visual universes</h2>
          <p className="muted">
            Universes define the intended visual identity. Theme tags such as horror
            or drama organize reusable assets without copying the underlying models.
          </p>
          {universes.map((item) => (
            <div className="library-universe" key={item.id}>
              <strong>{item.name}</strong>
              <small>{item.id} · {item.visualStyle}</small>
              <p className="muted">{item.description}</p>
              <div className="library-swatches">
                {item.palette.map((color) => <span key={color} style={{ background: color }} title={color}/>)}
              </div>
            </div>
          ))}
          <details>
            <summary>Create another visual universe</summary>
            <div className="library-fields">
              <label>ID<input value={universe.id} onChange={(event) => setUniverse({ ...universe, id: event.target.value })}/></label>
              <label>Name<input value={universe.name} onChange={(event) => setUniverse({ ...universe, name: event.target.value })}/></label>
              <label>Visual style<input value={universe.visualStyle} onChange={(event) => setUniverse({ ...universe, visualStyle: event.target.value })}/></label>
              <label>Art direction<textarea value={universe.description} onChange={(event) => setUniverse({ ...universe, description: event.target.value })}/></label>
              <label>Shading notes<textarea value={universe.shadingNotes} onChange={(event) => setUniverse({ ...universe, shadingNotes: event.target.value })}/></label>
              <label>Palette (comma separated hex colors)
                <input value={universe.palette.join(', ')} onChange={(event) => setUniverse({ ...universe, palette: event.target.value.split(',').map((color) => color.trim()).filter(Boolean) })}/>
              </label>
              <button disabled={busy} onClick={() => void perform(async () => {
                await api('external-library/universe', universe);
                await reload();
                setNotice('Visual universe saved.');
              })}>Save universe</button>
            </div>
          </details>
        </section>
      </div>
      <section className="library-panel">
        <div className="section-heading">
          <h2>3 · Published asset library</h2>
          <div className="asset-actions">
            <label>Universe
              <select value={filterUniverse} onChange={(event) => setFilterUniverse(event.target.value)}>
                <option value="">All</option>
                {universes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <label>Theme
              <input value={filterTheme} onChange={(event) => setFilterTheme(event.target.value)} placeholder="horror"/>
            </label>
          </div>
        </div>
        {!visible.length && <p className="muted">No matching published assets yet. Import one from Blender first.</p>}
        <div className="library-assets">
          {visible.map((asset) => (
            <article key={asset.assetId + '@' + asset.version}>
              <strong>{asset.assetId}</strong>
              <small>{asset.version} · {asset.category} · {asset.library.sourceProvider || 'Filmie'}</small>
              <small>{asset.library.themes?.join(', ') || 'untagged'}</small>
              {asset.rigCompatibility?.status && <small>Rig: {asset.rigCompatibility.status}</small>}
              <a href={asset.glbUrl} download>GLB</a>
            </article>
          ))}
        </div>
      </section>
      <section className="library-panel">
        <div className="section-heading">
          <div>
            <h2>4 · World assembly</h2>
            <p className="muted">Place reusable library assets into an immutable world package, then attach it to a production.</p>
          </div>
          <button disabled={busy} onClick={() => setWorld(emptyWorld())}>New world</button>
        </div>
        <div className="library-fields library-world-heading">
          <label>World ID<input value={world.id} onChange={(event) => setWorld({ ...world, id: event.target.value })}/></label>
          <label>Version<input value={world.version} onChange={(event) => setWorld({ ...world, version: event.target.value })}/></label>
          <label>Name<input value={world.name} onChange={(event) => setWorld({ ...world, name: event.target.value })}/></label>
          <label>Universe<select value={world.universeId} onChange={(event) => setWorld({ ...world, universeId: event.target.value })}>
            {universes.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <label>Theme<input value={world.theme} onChange={(event) => setWorld({ ...world, theme: event.target.value })}/></label>
        </div>
        <div className="asset-actions">
          <label>Add asset
            <select value={selectedAsset} onChange={(event) => setSelectedAsset(event.target.value)}>
              <option value="">Choose library asset</option>
              {available.map((item) => <option key={item.assetId + item.version} value={item.assetId + '@' + item.version}>{item.assetId}@{item.version}</option>)}
            </select>
          </label>
          <button disabled={!selectedAsset || busy} onClick={addInstance}>+ Place instance</button>
        </div>
        {world.instances.map((instance) => (
          <div className="library-world-instance" key={instance.id}>
            <div className="section-heading">
              <strong>{instance.assetId}@{instance.version}</strong>
              <button disabled={busy} onClick={() => setWorld((current) => ({
                ...current, instances: current.instances.filter((item) => item.id !== instance.id),
              }))}>Remove</button>
            </div>
            <div className="library-instance-controls">
              <label>Instance ID<input value={instance.id} onChange={(event) => editInstance(instance.id, (current) => ({ ...current, id: event.target.value }))}/></label>
              {(['position', 'rotationDegrees'] as const).map((group) =>
                (['x', 'y', 'z'] as const).map((axis) => (
                  <label key={group + axis}>{group === 'position' ? 'Pos' : 'Rot'} {axis}
                    <input type="number" step="0.1" value={instance.transform[group][axis]} onChange={(event) =>
                      editInstance(instance.id, (current) => ({
                        ...current,
                        transform: {
                          ...current.transform,
                          [group]: { ...current.transform[group], [axis]: Number(event.target.value) },
                        },
                      }))
                    }/>
                  </label>
                )),
              )}
              <label>Scale<input type="number" min="0.01" step="0.1" value={instance.transform.scale} onChange={(event) =>
                editInstance(instance.id, (current) => ({
                  ...current,
                  transform: { ...current.transform, scale: Number(event.target.value) },
                }))
              }/></label>
            </div>
          </div>
        ))}
        <div className="asset-actions">
          <button className="primary" disabled={busy || !world.instances.length} onClick={() => void perform(async () => {
            await api('external-library/world', world);
            await reload();
            setNotice('World version saved. It references the published GLBs without duplicating them.');
          })}>Save reusable world</button>
          <label>Production project
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">Choose project</option>
              {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <button disabled={busy || !projectId} onClick={() => void perform(async () => {
            const response = await api<{ revisionId: string }>('external-library/apply-world', {
              projectId, worldId: world.id, version: world.version,
            });
            onApplied?.(projectId);
            setNotice('World applied to every shot as a new production revision ' + response.revisionId.slice(0, 8) + '.');
          })}>Apply saved world to project</button>
        </div>
        <h3>Saved worlds</h3>
        <div className="library-saved-worlds">
          {worlds.map((item) => (
            <button key={item.id + item.version} onClick={() => setWorld(item)}>
              {item.name} · {item.version} · {item.instances.length} instances
            </button>
          ))}
        </div>
      </section>
    </section>
  );
}
