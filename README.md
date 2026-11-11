# Filmie

Filmie is a local-first production system. It validates prepared project packages, compiles frame-accurate timelines, renders shots through Blender or Remotion, assembles video with FFmpeg, and verifies the output. It does not invent scripts or creative instructions during production.

## Requirements

- Windows 10/11, Node.js 22.17+, pnpm 12.16.1
- FFmpeg and FFprobe on `PATH` for assembly and media inspection
- Blender 5.x for Blender projects; Chrome or Edge for Remotion

Install with `pnpm install --frozen-lockfile`. Set `FILMIE_BLENDER`, `FILMIE_FFMPEG`, or `FILMIE_FFPROBE` to select non-default executables.

## Run a project

```powershell
pnpm filmie doctor
pnpm filmie validate --project examples/demo
pnpm filmie plan --project examples/demo
pnpm filmie render --project examples/demo --output renders/demo
```

A prepared project keeps its `manifest.json`, `assets.json`, source artwork, and versioned reusable assets together. `renders/` contains disposable production outputs; `.cache/` contains reusable local render artifacts; `dist/` contains build output. Never store source artwork or authoritative manifests in these generated directories.

## Architecture

- `packages/contracts`: runtime schemas and shared interfaces.
- `packages/manifest`, `packages/assets`, `packages/timeline`, `packages/scene`: input parsing, asset resolution, and deterministic compilation.
- `packages/planner`: resolved render jobs and dependencies.
- `packages/cache`, `packages/media`: local artifact cache and renderer-independent FFmpeg/FFprobe operations.
- `engines/blender`, `engines/remotion`: renderer adapters and engine-specific execution.
- `packages/orchestrator`: coordinates injected renderer/media interfaces, receipts, and production stages.
- `apps/cli`: command-line composition root. A future API or frontend can call the same validated project and orchestration interfaces without owning renderer logic.
- `examples/`: source project packages and reproducible inputs. `tests/`: automated checks.

Dependencies point from engines and domain packages toward contracts. The orchestrator coordinates adapters through interfaces; media assembly does not depend on a renderer. Project data is persistent input, reusable cache is regenerable, and render/build outputs are disposable.

## Development

```powershell
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

Use `pnpm install --frozen-lockfile` to reproduce the pinned dependency graph. Keep production deterministic: validate inputs, preserve exact asset versions, include pixel-affecting inputs in cache keys, and reject unsupported instructions explicitly.
