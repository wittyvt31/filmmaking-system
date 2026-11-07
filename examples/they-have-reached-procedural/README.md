# They Have Reached — procedural asset proof

This local two-phase proof demonstrates Blender-native asset creation followed by deterministic production. `asset-spec.json` declares a reusable father, a 1950s rural Indian interior, chair, table, rotary telephone, and kerosene lantern. No AI service or original storyboard art is required.

Run from the repository root:

```powershell
pnpm filmie prepare --project examples/they-have-reached-procedural
pnpm filmie validate --project examples/they-have-reached-procedural
pnpm filmie render --project examples/they-have-reached-procedural --output renders/they-have-reached-procedural
```

`prepare` uses Blender 5.2.3 to generate one immutable `.blend` file per exact asset version, verify SHA-256, and register each library collection in `assets.json`. Reruns reuse matching versions. Changed specifications for an existing asset version are rejected; publish a new version instead.

The prepared manifest places those versioned assets, adds the father rig reference, and specifies subtle breathing, a head turn toward the telephone, and a camera push-in. The current rig uses hierarchical Blender controls rather than a deforming humanoid mesh. Reach, grasp, lift, speech, and expression changes are not implemented in this proof.

The proof uses a low-cost 640×360, 30 FPS, three-second preview for the 8 GB integrated-graphics workstation. Override output and cache paths to preserve prior runs.
