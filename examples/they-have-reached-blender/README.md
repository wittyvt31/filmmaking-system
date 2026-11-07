# They Have Reached — Blender proof of concept

This isolated example renders a five-second, 1280×720, 30 FPS scene with the existing `interior-wide.png` artwork. The artwork is used as one intact panel because the father and telephone crops in the source pack are opaque and cannot be composited as transparent foreground elements without additional art preparation.

The Blender scene adds a reusable `charcoal_horror` treatment, subtle paper grain and edge darkening, a separate procedural foreground haze plane, and a slow camera push-in. The father remains static. No source artwork is copied, edited, or overwritten.

Run from the repository root:

```powershell
pnpm filmie render --project examples/they-have-reached-blender --output renders/they-have-reached-blender
```

The master video is written to `renders/they-have-reached-blender/master.mp4`. The saved `.blend`, numbered PNG frames, render/assembly receipts, and production summary are under the generated `production` directory beneath that output folder.
