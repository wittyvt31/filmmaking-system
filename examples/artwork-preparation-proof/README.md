# Layered artwork preparation proof

This example demonstrates a data-driven pre-production package built from
original, deterministic charcoal drawings. `create_artwork.py` generates the
transparent PNG layers; Pillow is needed only to recreate those source images.
The registered PNG files are the actual artwork. `artwork-spec.json` describes
how the layers are assembled into five reusable Blender collection packages:
one environment, one pivoted father cutout, and three props.

From the repository root:

```powershell
pnpm filmie artwork prepare --project examples/artwork-preparation-proof
pnpm filmie validate --project examples/artwork-preparation-proof
pnpm filmie render --project examples/artwork-preparation-proof --output renders/artwork-preparation-proof
```

The preparation command resolves each exact source image version, verifies its
SHA-256, imports and packs the RGBA PNGs, and adds immutable `.blend` packages
to `assets.json`. Reusing an existing asset version is allowed only when its
generator inputs and file checksum match. Change a package version when its
assembly specification changes.

The father package has torso, head, hair, and separately pivoted arms. Eye and
mouth layers have `calm` and `alarmed` variants. The helper
`engines/blender/worker/artwork_runtime.py:set_artwork_variant(root, slot,
variant)` applies a declared variant after a collection is loaded and updates
the corresponding `filmie_variant_<slot>` property on the asset root. The package
also includes semantic hand and head anchors. These are image-plane cutout
controls; they do not deform artwork or provide skeletal/mesh deformation.

The environment layers have independent transforms and depth. The chair,
telephone, and lantern are separate versioned prop packages with attachment
anchors. Flat image layers preserve alpha and order; perspective-dependent
occlusion and automatic segmentation of flattened images are not inferred.
