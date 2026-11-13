# Filmie Asset Lab — first visual generation milestone

This sample exercises the real Asset Factory rather than a mock generator. It
creates an articulated six-part crane (including a rotating turret, pitching
boom, and sliding hook), exports it as a GLB, validates its exported semantic
node mapping and hierarchy, publishes an immutable version, **then imports the
published GLB back into Blender** to render a quick PNG inspection view.

## Prerequisites

Node.js 22.17+, pnpm 12.16.1, and Blender on `PATH` or in
`FILMIE_BLENDER`. On Windows you can also pass
`--blender "C:\Program Files\Blender Foundation\Blender 5.2\blender.exe"`.
Install dependencies with `pnpm install --frozen-lockfile`.

From the repository root:

```powershell
pnpm filmie build-procedural-asset --definition examples/asset-lab/crane.definition.json --registry renders/asset-lab/assets.json --license-name "Filmie reference demo" --preview renders/asset-lab/crane.png
```

**Look at:** `renders/asset-lab/crane.png`.

**Keep/use:** `renders/asset-lab/assets.json` (published registry),
`renders/asset-lab/artifacts/<sha256>.glb` (immutable 3D model),
`renders/asset-lab/reports/` (conversion/validation results).

A successful response contains a build status of `published` or `reused`,
and a preview status of `rendered` with a PNG SHA-256. Any rejected build or
preview sets a nonzero CLI exit code. Running the exact command again should
reuse the same immutable published asset and regenerate the preview. For a
different model, edit/copy the definition **and change its assetVersion**;
publishing altered content under the same identity is rejected by design.

The preview is a fast Blender Workbench material/geometry view, **not** a
cinematic photorealistic render. It checks real Blender import, GLB semantic
handle mapping, model shape, parent hierarchy, and material color. Joint pose
math is independently tested via the existing kinematics suite; full animated
shot rendering remains a separate production integration test.

## Troubleshooting

- If Blender cannot be found, set `FILMIE_BLENDER` or supply `--blender`.
- A rejected build contains diagnostics. Correct the definition or increment
  the version as appropriate; do not change the old registry entry.
- Preview rejection after publishing does **not** remove the valid GLB. The
  error reports why Blender could not reimport or render its PNG.
- The definition deliberately lists children **before** parents to exercise
  dependency-ordered scene building and exported GLB hierarchy verification.
