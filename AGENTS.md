# Filmie engineering guide

Filmie executes prepared, validated production packages. Production must not invent missing creative instructions or assets.

## Workspace ownership

- `packages/contracts`: Zod schemas, shared types, and serialization contracts.
- `packages/manifest`: prepared screenplay to validated project manifest.
- `packages/assets`: immutable asset versions, integrity checks, and resolution.
- `packages/timeline`, `packages/scene`, `packages/planner`: deterministic frame timeline, renderer-independent scene compilation, and render-job planning.
- `packages/cache`: verified local artifact cache and fingerprints.
- `packages/media`: FFmpeg/FFprobe encoding, assembly, and inspection. Keep renderer-specific behavior out.
- `engines/blender`, `engines/remotion`: engine adapters and engine-specific workers/compositions.
- `packages/orchestrator`: pipeline stages, receipts, and adapter coordination.
- `apps/cli`: command-line composition root. Future API/UI boundaries should call validated project/orchestration interfaces.
- `examples/`: persistent manifests and source or versioned assets. `renders/`, `.cache/`, and `dist/` are regenerable outputs.

## Development

- Install with `pnpm install --frozen-lockfile`.
- Use `pnpm format`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check`.
- Use one focused Vitest file while iterating. Blender runtime tests require the configured Blender executable; media tests require FFmpeg/FFprobe.
- CLI entry: `pnpm filmie <command>`. Executable overrides: `FILMIE_BLENDER`, `FILMIE_FFMPEG`, `FILMIE_FFPROBE`.

## Engineering rules

1. Put shared validation in contracts. Unsupported fields and runtime behavior must fail clearly.
2. Keep dependencies directed toward contracts. The orchestrator depends on interfaces, not concrete renderers.
3. Any pixel-affecting input belongs in the shot fingerprint; assembly-only inputs belong in the assembly fingerprint.
4. Derive procedural randomness from an explicit seed. Preserve exact asset version and content hash.
5. Spawn external tools with argument arrays, capture exit status and diagnostics, and validate outputs before promotion.
6. Keep source artwork and manifests outside generated-output directories. Do not commit disposable renders or caches.
7. Report verification only for commands or renders actually executed in the current task.
