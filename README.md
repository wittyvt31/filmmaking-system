# Filmie

Filmie is a local, manifest-driven 3D production pipeline. It validates an approved project, resolves exact versioned Blender model assets, compiles a frame timeline, renders through Blender, assembles with FFmpeg, and verifies outputs. It does not interpret scripts, create assets, or invent missing instructions during production.

## Requirements

- Windows 10/11, Node.js 22.17+, pnpm 12.16.1
- Blender 5.x, FFmpeg, and FFprobe available locally

Install dependencies with `pnpm install --frozen-lockfile`. Set `FILMIE_BLENDER`, `FILMIE_FFMPEG`, or `FILMIE_FFPROBE` to choose executables.

## Run the reference project

```powershell
pnpm filmie doctor
pnpm filmie validate --project examples/3d-production
pnpm filmie plan --project examples/3d-production
pnpm filmie render --project examples/3d-production --output renders/3d-production
```

Each project contains `manifest.json`, `assets.json`, and exact versioned assets. The manifest describes scene models, characters, props, lighting, camera, shot timing, and audio cues. Scene assets must be Blender model collections identified in asset metadata. Source manifests and assets live with the project; `.cache/` stores reusable artifacts; `renders/` and `dist/` are disposable outputs.

## Architecture

- `packages/contracts`: validated manifest, scene, render, timeline, receipt, and serialization contracts.
- `packages/assets`: immutable asset versions, SHA-256 verification, and file resolution.
- `packages/scene`, `packages/timeline`, `packages/planner`: renderer-facing scene instructions, integer-frame timeline, and render-job planning.
- `packages/cache`, `packages/media`: local artifact cache and renderer-independent FFmpeg/FFprobe operations.
- `engines/blender`: Blender adapter and Python render worker.
- `packages/orchestrator`: filesystem project loading, validation, package approval, job execution, caching, assembly, and receipts.
- `apps/cli`: command-line composition root.

## Implemented and planned

Implemented: strict JSON manifests; Blender 3D collection loading; perspective camera paths and scene lighting; deterministic keyframed actions supported by the Blender worker when the referenced model supplies required controls; EEVEE, Cycles, and Workbench configuration; PNG sequence rendering; FFmpeg encoding, timeline ordering, transitions and audio cues; asset integrity checks, cache fingerprints, receipts, and FFprobe verification.

Planned: frontend/API and persistent manifest service; general asset authoring and rig preparation; broader animation/physics systems; richer model interchange and validation. Filmie currently consumes prepared `.blend` collections and does not create or rig production models.

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

Production packages use ESM and strict TypeScript. Validate schema changes, preserve exact asset identities, include pixel-affecting values in render fingerprints, spawn tools with argument arrays, and reject unsupported instructions explicitly.
