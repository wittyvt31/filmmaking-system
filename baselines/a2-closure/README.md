# A2 rendering reliability closure evidence

Both production runs used the committed reference manifests under `examples/a2.1-experiments/`. After removing only `renderPolicy.qualityOverrides.compositing`, the manifests compare equal. Both requested Blender EEVEE and the `draft` quality profile. Each was rendered in a fresh output and cache directory through `pnpm filmie render`.

## Experiment A — compositor disabled

Command: `pnpm filmie render --project examples/a2.1-experiments/A --output renders/a2-closure/final-A/output --cache renders/a2-closure/final-A/cache --timeout 900000`

Result: exit 0; elapsed 244.794 s; receipt reports requested and actual `BLENDER_EEVEE`, no fallback, no degradation. FFprobe and visual verifier report 150 frames, 5.000 s, 1920x1080, 30/1 FPS, H.264/yuv420p/BT.709; verifier has no failure reasons, 0 near-uniform/low-entropy frames and 0 identical consecutive frames.

## Experiment B — compositor enabled

Command: `pnpm filmie render --project examples/a2.1-experiments/B --output renders/a2-closure/final-B/output --cache renders/a2-closure/final-B/cache --timeout 900000`

Result: exit 0; elapsed 259.890 s; receipt reports requested and actual `BLENDER_EEVEE`, no fallback, no degradation. FFprobe and visual verifier report 150 frames, 5.000 s, 1920x1080, 30/1 FPS, H.264/yuv420p/BT.709; verifier has no failure reasons, 0 near-uniform/low-entropy frames and 0 identical consecutive frames. The saved Blender scene has compositing enabled and a wired Render Layers -> Glare -> Group Output graph. `FILMIE_GLOW_SKIPPED` is absent. The encoded A/B videos (SHA-256 `89C9617346BB27A0197EB058E9BAB2AEA59650B4BAA1495E54EB61839ACA693F`) and all decoded frame MD5s are identical: this scene produced no visible glow difference, although the compositor was enabled and its graph was present in the saved scene. Do not infer a visible glow from this result; whether the scene values cross the configured threshold remains unconfirmed.

## Visual inspection

Contact sheets and frames 1, 75 and 150 are included for both runs. The charcoal interior artwork is visible and the frames are not uniform gray or blank. The camera moves from Y=-6.0 at frame 1 to Y=-5.35 at frame 150 in the saved scene; the push-in is subtle but present. Grain is visually strong and reduces fine scene detail; this is recorded as a quality limitation, not a rendering crash or missing-texture failure.

## Root cause and correction

Before the scoped fix, compositor-enabled rendering logged `FILMIE_GLOW_SKIPPED` because the Blender 5.2 compositor node group had no exposed output interface socket. The worker now creates an `Image`/`NodeSocketColor` output and links the Glare node into its Group Output. A Blender-gated runtime regression verifies the scene graph after save/reopen and confirms no skip warning.

## Automated checks

- Focused A2 command: `pnpm exec vitest run tests/blender-crash-tolerance.test.ts tests/verify-render.test.ts tests/blender-2.5d-runtime.test.ts` — PASS, 3 files / 6 tests, including Blender 5.2.3 runtime save/reopen verification.
- Isolated verifier command: `pnpm exec vitest run tests/verify-render.test.ts --reporter=verbose` — PASS, 1 file / 2 tests. The same verifier test was flaky during the loaded full-suite run, then passed alone.
- `pnpm lint` — PASS. `pnpm typecheck` — PASS. `pnpm build` — PASS.
- `pnpm check` — FAIL at its initial `prettier --check .` step; it reports eight untouched existing files: `examples/first-production-test/{assets.json,manifest.json,production-brief.md}`, `examples/they-have-reached-procedural/assets.json`, `examples/they-have-reached/{ASSET_CATALOG.md,assets.json,manifest.json}`, and `packages/contracts/src/index.ts`. The changed implementation and A2 evidence files were formatted; no unrelated files were changed.
- Full `pnpm test` — FAIL, 4 files failed / 15 passed; 8 tests failed / 58 passed. Failure causes: artwork-preparation expects an obsolete style-registration error message; three media assembly tests could not create FFmpeg outputs due Windows temp permission denied and its PNG encoding test timed out; two Remotion integration tests ended with `write EOF`; one verifier test failed under full-suite load but passes in isolation. No full-suite failure is in the changed compositor worker or its regression test.

## Diagnostics note

`pnpm filmie doctor` without an explicit Blender path failed because Blender is not on PATH and the CLI attempted `.trim()` on missing spawn output. With `--blender 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe'`, Blender 5.2.3 launched and the command exited 0, but the capability probe reported that `METAL` is not a valid device enum on this Windows Blender build. This does not affect either EEVEE render, but doctor capability reporting remains imperfect.
