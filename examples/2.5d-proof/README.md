# 2.5D layered artwork proof

This small project uses the supplied _They Have Reached_ charcoal artwork as
separate back, character, and prop planes. `prepare-artwork.py` makes two
reproducible alpha-matted derivatives from the supplied daughter and telephone
panels; it does not change the original files. Pillow is only needed to rerun
that preparation script. Production consumes the checked-in PNGs and does not
need Pillow or AI services.

Each scene image layer is a pivoted Blender plane under a transform root.
`group.window-character` parents the daughter sprite. The planes use explicit
depth and draw-order offsets; the camera push-in is compiled as frame-keyed
camera transforms. The same scene camera contract also supports pan, optical
zoom, and static framing.

The checked-in asset files and registry are already prepared. The script is
retained to document the deterministic matte creation and refuses to overwrite
these existing files; do not rerun it in this populated project. From the
repository root, validate and render with:

```powershell
pnpm filmie validate --project examples/2.5d-proof
pnpm filmie render --project examples/2.5d-proof --output renders/2.5d-proof
```

The preparation script is intentionally write-once and refuses to overwrite
existing output artwork or an asset registry.
