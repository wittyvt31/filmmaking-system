# Automated Filmmaking System

A local-first TypeScript monorepo for converting prepared creative instructions into a validated production plan, independently rendered shot clips, and an assembled master video. It does not write stories, scripts, dialogue, narration, or music ideas.

## Requirements

- Windows 10 or 11
- Node.js 22.17.0 or later
- pnpm 12.16.1 (the exact version is recorded in `packageManager`)
- FFmpeg 9.0.2 and FFprobe 9.0.2 available on `PATH` for future assembly and media work
- Google Chrome or Microsoft Edge installed for Remotion rendering; set `CHROME_PATH` when installed in a nonstandard location
- Git

The CLI prefers FFmpeg and FFprobe executables available on `PATH`, accepts explicit `FILMIE_FFMPEG` and `FILMIE_FFPROBE` overrides, and falls back to the pinned Remotion distribution's local binaries when the system tools are unavailable. No shell command is invoked: the media engine uses Node.js `spawn()` with argument arrays.

## Install and work locally

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm render:example
```

Useful commands:

```powershell
pnpm format       # Format supported files
pnpm format:check # Check formatting without changing files
pnpm lint         # Run ESLint
pnpm typecheck    # Check all TypeScript project references
pnpm test         # Run contract and planning tests with Vitest
pnpm build        # Build all workspace projects
pnpm render:example # Independently render the three one-second sample shots
pnpm filmie validate --project examples/demo
pnpm filmie timeline --project examples/demo
pnpm filmie plan --project examples/demo
pnpm filmie render --project examples/demo
pnpm filmie cache --project examples/demo
pnpm filmie clean --project examples/demo
pnpm check        # Run formatting, lint, typecheck, tests, and build
```

## Workspace layout

- `apps/cli`: the command-line application boundary.
- `packages/contracts`: shared Zod schemas, rational frame rates, render policy, and RFC 8785 canonical JSON.
- `packages/manifest`: validated project manifest contract.
- `packages/assets`: immutable versioned asset registry and local file/hash resolution.
- `packages/timeline`: deterministic integer-frame compiler with half-open intervals, gaps, overlaps, transitions, and audio tracks.
- `packages/planner`: asset-aware render job and artifact plan generation.
- `packages/scene`: deterministic, renderer-independent scene and frame-action compiler.
- `engines/blender/authoring`: deterministic, versioned Blender-native procedural asset preparation from a strict JSON specification.
- `packages/cache`: verified local shot and assembly artifact cache.
- `packages/media`: Remotion-independent FFmpeg/FFprobe assembly engine, audio placement, black timeline gaps, output inspection, and assembly fingerprints.
- `packages/orchestrator`: loads and validates projects, resolves assets, compiles the timeline, runs shot jobs, checks caches, assembles and verifies the master, and writes production receipts and logs.
- `engines/remotion`: renderer adapter, reusable prepared-shot composition, Remotion implementation, validation, receipts, and local artifact cache integration.
- `engines/blender`: Blender 5.2.3 adapter and fixed Python worker for EEVEE PNG-sequence rendering.
- `docs`: architecture notes and future design records.
- `examples`: reserved for small, non-production workspace examples.

Package dependencies use the `workspace:` protocol. Contracts sit below domain packages, planner, cache, and media; the orchestrator coordinates those contracts through injected renderer and media interfaces; the CLI wires the Remotion adapter and FFmpeg engine together. The media package has no dependency on Remotion. The orchestrator does not depend on a concrete renderer, so another engine can be passed without changing it.

Each TypeScript package is a composite project in the root project-reference build. All packages use ESM and strict TypeScript settings inherited from `tsconfig.base.json`.

## Prepared project inputs

Project manifests are validated by `ProjectManifestSchema` or `parseProjectManifest` from `@filmmaking/contracts`. Shot duration, timeline positions, cue offsets, and transition lengths are integer frame counts. A rational frame rate is represented as a reduced `{ numerator, denominator }` pair. Timeline clips use `[startFrame, endFrame)` intervals. Every declared shot must appear exactly once on a video track, every overlap must have a matching explicit transition, and all clips and audio cues must fit within the declared timeline duration. Gaps are preserved and reported by the compiled timeline.

`AssetRegistry` in `@filmmaking/assets` keys versions by the exact `{ assetId, version }` pair. Re-registering a version fails; a new version must be added under a new version string. Asset records include a source URI, SHA-256 hex digest, JSON metadata, license, and provenance. Planning resolves local file URIs or relative paths, verifies the file exists, and checks its digest. Non-local source schemes are rejected by this local prototype.

`prepareProductionPlan(manifest, registry, assetBaseDirectory)` from `@filmmaking/planner` validates the manifest, resolves all referenced assets, compiles the timeline and any structured scenes, and returns a deterministic render plan. Shot render jobs target the validated renderer selection; the final assembly job is assigned to FFmpeg. `RemotionRendererAdapter` preserves its existing video, PNG-sequence, and still-image behavior. `BlenderRendererAdapter` saves a `.blend` scene and renders a frame-validated PNG sequence using EEVEE, Cycles, or Workbench. Cycles accepts CPU or explicit/automatic OPTIX, CUDA, HIP, METAL, and ONEAPI device selection. `FfmpegMediaEngine` encodes the sequence to shot video consumed by the existing assembler. Blender defaults to the standard Windows installation location and can be overridden with `FILMIE_BLENDER`.

Run `pnpm filmie doctor` to inspect the Blender version, available Blender render engines and Cycles devices, CPU/RAM, FFmpeg and FFprobe. Set `FILMIE_BLENDER`, `FILMIE_FFMPEG`, or `FILMIE_FFPROBE` to select local executables. Blender manifests may set `renderPolicy.qualityProfile` to `draft`, `preview`, or `final`; these select 854×480, 1280×720, or at least 1920×1080 PNG working frames and profile sample defaults. Omit the profile to preserve the manifest's explicit output dimensions. `qualityOverrides` sets project render values, while each shot may specify `renderOverrides`; resolution and frame-rate adjustments are normalized by the existing media encoding policy during assembly. Renderer `config` supports `engine`, `device`, `samples`, and `denoising`. Render engine, resolved settings, seed, style and worker implementation dependencies participate in shot cache identity. Cycles GPU failures in automatic mode retry once on CPU; manual backend requests fail explicitly.

Blender renders in 12-frame sequential chunks and writes individually validated PNGs into a hidden `.partial` staging directory. A rerun reuses only PNGs with a valid signature and expected dimensions, then promotes the complete validated sequence atomically. Incomplete output stays outside the final artifact path. Chunk execution is sequential in this milestone; parallel frame-range workers are not enabled.

The versioned `charcoal_horror` style is shared by procedural asset authoring and scene rendering. It includes palette mapping, per-layer seeded procedural grain with stepped deterministic boil, screen-fixed procedural paper, alpha-aware transparency, vignette, haze, subtle seeded key-light flicker, and a low-cost compositor glow. Paper and grain controls are strict style overrides. To create a local package from structured asset instructions, run `pnpm filmie prepare --project examples/they-have-reached-procedural`; this reads `asset-spec.json`, runs Blender 5.2.3 locally, writes immutable `.blend` asset versions, records SHA-256 hashes and provenance in `assets.json`, and emits `preproduction.receipt.json`. It never calls AI services. The separate production phase consumes the prepared manifest and registry: `pnpm filmie render --project examples/they-have-reached-procedural --output renders/they-have-reached-procedural`. The sample creates a father with a hierarchical pose rig, a rural house interior, chair, table, telephone and lantern, then demonstrates frame-based breathing and a head turn. The current authoring catalog is intentionally small and explicitly typed; unsupported geometry or actions fail validation rather than being guessed.

For assembled transparent PNG artwork, `pnpm filmie artwork prepare --project <project>` reads `artwork-spec.json` and exact image versions from `assets.json`, validates hierarchies, pivots, facial variant slots, and anchors, then packs each character/environment/prop as an immutable Blender collection in `assets/generated/`. It writes actual source hashes, license restrictions, provenance, and a preparation receipt. `examples/artwork-preparation-proof/` contains a complete source-artwork and package specification example. The Python helper `engines/blender/worker/artwork_runtime.py` selects prepared facial variants after a package is loaded. This workflow assembles human- or tool-prepared transparent layers; it does not segment arbitrary flattened art.

The original image-based five-second example remains available at `examples/they-have-reached-blender/`; its father and telephone remain part of the opaque supplied artwork and are not animated. Blender rendering supports the implemented image-backed/static layers and procedural assets, plus breathing and head-turn actions on assets that provide the expected controls. Reach, grasp, lift and expression are still contract-only and are rejected at render time.

The prepared one-second example manifest and SVG assets live directly under `examples/`; run `pnpm render:example` to create three independent MP4 clips in `renders/sample-project/`.

The 15-second acceptance project is in `examples/demo/`. A project directory contains `manifest.json`, an `assets.json` array with immutable hashes and provenance, and relative asset files/URIs. Run `pnpm filmie render --project examples/demo` to execute validation, timeline compilation, render planning, shot rendering, assembly, and FFprobe verification in one command. Generated outputs are written to `dist/master.mp4` and `dist/production/<project-id>/`, which contains the compiled timeline, render plan, shot clips and receipts, assembly receipt, production receipt, log, and readable summary. Caches are scoped under `.cache/production/<project-id>/`; reruns validate and reuse unchanged shot and assembly artifacts.

The FFmpeg assembly MVP handles one video track, preserves explicit timeline gaps as black video, and lays audio cues onto their declared tracks with silence outside cue intervals. It reports transitions, overlaps, and multiple video tracks as unsupported instead of dropping them. Transition effects and multi-track video compositing remain future work.

Render policy is technical configuration kept separate from shot descriptions. The policy's dimensions and rational frame rate must match the project's global video settings, and codec/container combinations are validated. Renderer-specific settings use strict Zod object schemas, so unknown Remotion configuration fields and unsupported renderer identifiers fail validation.

`canonicalJson` and `canonicalJsonSha256` from `@filmmaking/contracts` use `json-canonicalize` 3.0.1 with strict undefined rejection for RFC 8785 serialization and deterministic hashes.

## Scope and dependencies

The initial prototype is local-only. It does not require Redis, cloud infrastructure, paid APIs, or external AI services. Shared tooling versions are pinned exactly in the root manifest and the resolved dependency graph is recorded in `pnpm-lock.yaml`.
