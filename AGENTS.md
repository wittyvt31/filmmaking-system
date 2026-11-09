# Filmie (filmmaking-system) — agent guide

Deterministic pipeline: project manifest -> plan -> per-shot render (Blender or Remotion) -> FFmpeg assembly. Goal: minimal 2.5D charcoal animation. Read this file first; do not re-explore the repo.

## Commands

- `pnpm typecheck` (tsc -b) · `pnpm test` (vitest run) · `pnpm check` (format, lint, typecheck, test, build; run once before committing)
- One test file while iterating: `pnpm exec vitest run tests/<name>.test.ts`
- `pnpm filmie doctor` · `pnpm filmie render --project <dir> --output <dir>` · `pnpm filmie prepare --project <dir>` · `pnpm filmie artwork prepare --project <dir>`
- Env: `FILMIE_BLENDER`, `FILMIE_FFMPEG`, `FILMIE_FFPROBE` select executables.

## Map (line counts approximate)

- `packages/contracts` — every Zod schema and type: manifest, shots, scene, render policy and quality, artwork, rigs, receipts. Single source of truth. Large; use Grep.
- `packages/contracts/src/style.ts` — charcoal style override contract.
- `packages/contracts/src/identifiers.ts` — stable IDs and immutable asset-version references.
- `packages/contracts/src/asset-specifications.ts` — procedural asset build specifications.
- `packages/contracts/src/render-policy.ts` — rational/video settings, render quality, and renderer selection policy.
- `packages/contracts/src/motion.ts` — transitions, audio cues, character actions, and motion-clip libraries.
- `packages/contracts/src/scene.ts` — renderer-independent scene composition, camera, lights, layers, and props.
- `packages/contracts/src/shots.ts` — shot, track, and timeline instruction schemas.
- `packages/contracts/src/project-manifest.ts` — validated project-manifest schema and inferred type.
- `packages/contracts/src/project-manifest-shape.ts` — internal base manifest schema and validation types.
- `packages/contracts/src/manifest-timeline-validation.ts` — internal video/audio placement and transition validation.
- `packages/contracts/src/manifest-scene-validation.ts` — internal shot and scene cross-reference validation.
- `packages/contracts/src/production-package.ts` — prepared screenplay and production-package contracts.
- `packages/contracts/src/rigs.ts` — semantic cutout rig definitions.
- `packages/contracts/src/artwork.ts` — artwork package, preparation, hierarchy, and layer contracts.
- `packages/contracts/src/compiled-scene.ts` — compiled scene instruction interface.
- `packages/contracts/src/renderer.ts` — renderer adapter, request, capability, result, and receipt contracts.
- `packages/contracts/src/serialization.ts` — manifest parsing, canonical JSON, hashing, and comparison utilities.
- `packages/contracts/src/shared-internal.ts` — non-public schemas and helpers shared between contract modules.
- `packages/contracts/src/index.ts` — public barrel re-exporting each topic module.
- `packages/assets` — AssetRegistry; immutable versioned assets with SHA-256.
- `packages/planner` — prepareProductionPlan: validate, resolve assets, compile timeline and scenes, return render plan.
- `packages/scene` — compileScene: structured shot scene -> compiled instructions (style, actions, camera keyframes).
- `packages/timeline`, `packages/orchestrator`, `packages/cache`, `packages/media`, `packages/manifest` — timeline compile, job execution and receipts, render cache, FFmpeg encode and assembly, manifest helpers (unverified).
- `engines/blender/src/index.ts` — BlenderRendererAdapter: settings and quality profile resolution, cache fingerprint, chunked render with resume, crash tolerance and fallback. `artwork.ts`: artwork preparation. `authoring.ts`: procedural asset authoring.
- `engines/blender/worker/render_shot.py` — runs inside Blender. `color_material` (charcoal material, grain boil), `create_screen_paper`, `setup_compositor_glow`, `create_scene` (engine, device, lights, camera), `apply_motion_curves`, `main` (chunked render loop, writes worker-result.json). Also `prepare_artwork.py`, `build_assets.py`, `artwork_runtime.py`.
- `engines/remotion` — Remotion adapter. `apps/cli` — commander CLI.
- `tests/` — vitest. Blender-gated tests use `describe.skipIf(!existsSync(blender))`.
- `examples/` — `2.5d-proof` and `artwork-preparation-proof` are the layered-artwork examples.

## Rules

1. Contracts first. A new setting is a Zod schema in contracts, passes through the adapter into the worker spec, and is read by the worker. It is not done until a test fails when the worker ignores it.
2. Anything that changes pixels goes into the cache fingerprint (engine, device, samples, profile, overrides, style version, worker dependency hash).
3. Determinism: derive every random value from `randomSeed`; no wall-clock or unseeded randomness.
4. The worker targets Blender 5.x: layered actions via `action_fcurves()`, compositor under `compositing_node_group`. Optional effects must never block frames.
5. `renders/` is gitignored. Committed evidence goes in `baselines/`.
6. Never say something is verified unless a command or render in this session showed it. Cloud sessions have no Blender: Blender-gated tests skip there, and render checks run on the user's machine.
7. Reports: at most 15 lines, one line per task item.

## Gotchas

- The Intel UHD machine crashed EEVEE after writing frames. The adapter accepts a non-zero exit when every frame validates and records `completedWithWarning`.
- `tests/blender-crash-tolerance.test.ts` compiles a C# fake Blender with csc.exe, so it runs on Windows only.
- The cloud sandbox's FFmpeg lacks a BMP decoder, so three `media-assembly` tests fail there; that is the sandbox, not the code.
- The README says reach, grasp, lift and expression are rejected at render time. Check the worker before trusting either.
