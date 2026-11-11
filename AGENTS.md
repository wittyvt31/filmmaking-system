# Filmie engineering guide

Filmie is a local, manifest-driven 3D production pipeline. Production validates prepared instructions and exact model versions; it does not create assets or invent missing content.

## Workspace

- `packages/contracts`: strict manifest, scene, render, timeline, receipt, and serialization contracts.
- `packages/assets`: immutable asset versions, SHA-256 integrity checks, and resolution.
- `packages/scene`, `packages/timeline`, `packages/planner`: deterministic scene compilation, frame timeline, and render planning.
- `packages/cache`, `packages/media`: local artifact caching and renderer-independent FFmpeg/FFprobe operations.
- `engines/blender`: Blender adapter and Python worker. `apps/cli` composes the pipeline.
- `packages/orchestrator`: validation, execution, receipts, caching, and assembly coordination.
- `examples/3d-production`: minimal prepared Blender model project. `renders/`, `.cache/`, and `dist/` are generated outputs.

## Development

- Install: `pnpm install --frozen-lockfile`.
- Validate: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` or `pnpm check`.
- Run: `pnpm filmie <command>`. Executables can be selected with `FILMIE_BLENDER`, `FILMIE_FFMPEG`, and `FILMIE_FFPROBE`.

## Rules

1. Put shared validation in contracts and reject unsupported instructions explicitly.
2. Keep dependencies directed toward contracts; orchestration depends on adapter interfaces.
3. Include every pixel-affecting input in render fingerprints and every assembly-only input in assembly fingerprints.
4. Preserve asset version and content hash; derive procedural randomness from explicit seeds.
5. Spawn tools with argument arrays, capture diagnostics, and validate artifacts before promotion.
6. Keep persistent manifests and source assets separate from generated outputs. Report only checks actually run.

## Current scope

Implemented: prepared `.blend` collection loading, Blender render configuration, supported keyframed model actions, PNG rendering, FFmpeg assembly, audio cues, cache, receipts, and media verification. Planned: frontend/API, general-purpose asset authoring and rig preparation, and broader animation or physics. Blender model authoring and rigging are not provided by the production pipeline.
