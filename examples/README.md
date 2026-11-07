# Examples

- `sample-project.json` is a 3-second project with three one-second shots for exercising Remotion independently.
- `demo/manifest.json` is the 15-second CLI acceptance project with three five-second shots.
- `assets/` contains original SVG background and character artwork used by both examples.
- `demo/assets.json` records exact asset versions, SHA-256 hashes, license, and provenance. Its relative asset URIs resolve to `../assets/`.

Run `pnpm filmie validate --project examples/demo` to validate the acceptance project or `pnpm filmie render --project examples/demo` to render and assemble it.
