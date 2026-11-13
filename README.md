# Filmie

Filmie is a local, manifest-driven 3D production pipeline. It validates an approved project, resolves exact versioned Blender model assets, compiles a frame timeline, renders through Blender, assembles with FFmpeg, and verifies outputs. It does not interpret scripts, create assets, or invent missing instructions during production.

## Requirements

- Windows 10/11, Node.js 22.17+, pnpm 12.16.1
- Blender 5.x, FFmpeg, and FFprobe available locally

Install dependencies with `pnpm install --frozen-lockfile`. Set `FILMIE_BLENDER`, `FILMIE_FFMPEG`, or `FILMIE_FFPROBE` to choose executables.

Inspect a GLB and report only verified structure with:

```powershell
pnpm filmie inspect-asset --file path\to\asset.glb
pnpm filmie inspect-asset --file path\to\asset.glb --descriptor path\to\asset-descriptor.json
```

Authored handles, articulation, colliders, sockets, and material semantics are
accepted only from the versioned descriptor; the inspector does not infer them.

Normalize a self-contained GLB without modifying the source:

```powershell
pnpm filmie normalize-asset --input path\to\input.glb --output path\to\filmie-asset.glb
```

Normalization canonicalizes the GLB JSON chunk, preserves the binary payload and
component references, and rejects external resources or ambiguous transforms.

## Asset Lab — test real procedural model generation

Generate a deterministic articulated crane, publish the resulting GLB and
reimport it into Blender for a quick material/geometry preview:

```powershell
pnpm filmie build-procedural-asset --definition examples/asset-lab/crane.definition.json --registry renders/asset-lab/assets.json --license-name "Filmie reference demo" --preview renders/asset-lab/crane.png
```

Open `renders/asset-lab/crane.png` to inspect the result. The same directory
contains the immutable content-addressed GLB, registry and validation reports.
See [Asset Lab](examples/asset-lab/README.md) for requirements, expected output
and guidance. The preview is intentionally lightweight; it is not a cinematic
shot render.

### Create assets visually in Filmie Studio

Run `pnpm web`, open [Filmie Studio](http://127.0.0.1:4173), and switch to
**Asset Studio** in the header. No manifest or existing production project is
required to start asset authoring.

1. Choose **Crane preset** (articulated) or **New box**, or import an authored
   procedural JSON definition.
2. Add or select parts in the hierarchy; edit dimensions, parent, position,
   rotation, materials, and joint controls. Orbit/zoom the lightweight
   **authoring viewport** to inspect structural changes.
3. Select **Validate**, then **Generate + publish GLB**. The local Blender
   process exports and validates the real GLB, publishes an immutable version,
   and renders a separate PNG preview from the published asset.
4. Download either output from the asset library, or select a project and
   **Attach** the published version to that project's registry. Reference the
   exact asset ID and version in the project manifest to use it in production.

The interactive viewport is an efficient authoring preview of primitive geometry,
not a full GLB renderer. Imported procedural curves/sweeps are verified through
the Blender preview. The service persists authored definitions, registry,
content-addressed GLBs, and previews under `.filmie/asset-studio/`, and preserves
the current unpublished editor draft in the browser. Change `assetVersion`
when publishing modified geometry; existing published versions are immutable.

[View automated Asset Studio build/attach smoke](https://github.com/wittyvt31/filmmaking-system/actions/workflows/filmie-asset-lab.yml).

Run `pnpm web` and open [Filmie Studio](http://127.0.0.1:4173). Create a project from the `3d-production` catalog, edit and validate the manifest, save a revision, then run it. Restart the command after changing frontend or API source. To access it from your local network, set `FILMIE_WEB_HOST=0.0.0.0` and `FILMIE_WEB_ALLOWED_HOSTS` to the server's IP address before running `pnpm web`; allow the selected port through the Windows firewall on a private network only. The app has no authentication, so only expose it to trusted devices.

The web app stores project revisions and run history in `.filmie/`, writes outputs to `renders/web/`, and shares the production cache with the CLI. Set `FILMIE_WEB_PORT` to change the port or `FILMIE_WEB_CATALOGS` to use another folder of prepared projects, each with a `manifest.json` and `assets.json`. Keep the catalog asset files available for reruns.

Create a Studio project from `cinematography` to see a dolly, an orbit and crane, and a handheld tracking cut around one animated performer. Use `scene.camera.type: "rigs"` to define independently animated cameras and reuse their IDs in `cuts`. The cuts are zero-based, start-inclusive and end-exclusive, and together cover the shot. Position keys use world metres and can supply absolute Bézier handles. Orientation keys use WXYZ quaternions with local −Z forward and +Y up. Alternatively, aim at a world point or a compiled entity or skeletal joint. Behaviors layer world-space or camera-relative motion onto the rig, and seeded handheld motion repeats for the same input.

Optics control focal length, sensor fit and size, aperture, clipping, and depth of field. Focus can use distance keys or track a target. Framing places a selected anchor at normalized screen coordinates with the origin at the lower left. For headroom, select a head anchor and supply its desired distance from the top edge. Add visibility anchors for other parts of the subject. Visibility checks the frame and clipping planes, with optional occlusion checks against static world collision proxies. Targets must have compiler-known transforms; runtime physics and legacy renderer-only animation are outside this tracking mode.

## Run the reference project

```powershell
pnpm filmie doctor
pnpm filmie validate --project examples/3d-production
pnpm filmie plan --project examples/3d-production
pnpm filmie render --project examples/3d-production --output renders/3d-production
```

Each project contains `manifest.json`, `assets.json`, and exact versioned assets. The manifest describes scene models, characters, props, lighting, camera, shot timing, and audio cues. Models can be prepared Blender collections or self-contained GLB, STL, and PLY files. Rigged characters can use prepared Blender collections or compatible skinned GLBs. GLB retains source node transforms, material data and custom extras. Source manifests and assets live with the project; `.cache/` stores reusable artifacts; `renders/` and `dist/` are disposable outputs.

Create a Studio project from `visual-styles` to compare the same animated scene in `realistic_cgi@1.0.0`, `stylized_3d@1.0.0`, `cel_shading@1.0.0`, and `charcoal_horror@1.2.0`. Set `scene.stylePreset` and `scene.styleVersion` independently of motion and geometry. `scene.visualSettings` controls exposure, optional default lights and a solid or equirectangular image environment. Stylized 3D adds saturation and roughness controls. Cel shading adds configurable diffuse bands and requires EEVEE. These shader treatments apply to Filmie-generated materials. Imported model collections retain their own shaders.

World surfaces reuse named `world.materials` entries. World materials and procedural character appearance support base color, metallic, roughness, opacity, transmission, IOR, emission, noise or checker color patterns, and pinned image textures for color, roughness, metallic, and opacity. Generated geometry uses box-projected textures. Opacity maps use image luminance. Lights support area, point, spot, and sun types with per-light shadow switches within the render quality policy. Workbench previews display basic surface colors.

The reference manifest uses `scene.world` version 1 for a measured room, a box-built bench, and a registered lantern attached to the bench. Dimensions and positions are in meters, Z is up, and child transforms are relative to their parent. Room dimensions describe the clear interior, centered on X and Y with the floor surface at Z = 0. Wall openings are measured from the low-coordinate end of the interior span, and window sill heights are measured from the floor. Physical properties are stored as object metadata for future simulation. Existing revisions that use `scene.environment` still load. Create a fresh project from the `3d-production` catalog in Studio to see the new reference.

The Studio `geometry-workshop` catalog shows a swept Bézier arch, round trim, an extruded platform, shared pedestal assemblies, and original and recolored GLB instances. Define reusable shapes in `world.meshes` and hierarchical mesh parts in `world.assemblies`, then reference them from entities. Extrusions use simple XY polygons and extend from local Z = 0 to the specified depth. Curves and sweeps use open polylines or sampled cubic Bézier paths. Sweeps can set an initial up vector and transport their profile along the path. Box, sphere, and cylinder mesh entities get primitive collision proxies. For other shapes, assemblies, and imports, author `colliders` where needed.

Declare imported model versions in `requiredAssets`. World asset entities can use `geometry.materialOverrides` to replace all surfaces or map named source materials to `world.materials` IDs. Overrides apply per instance and use Filmie's visual treatments. GLB must embed its buffers and textures. Imported lights are disabled for rendering so the manifest controls illumination.

The reference visitor uses `FilmieHumanoid` v1. Its procedural source defines height in meters, body proportions as fractions of height, and skin, clothing, shoe, and optional hair materials. The neutral rig stands at Z = 0 facing −Y, with the character's left toward +X. Bones use zero rest roll and local +Y along the bone. Pose tracks use zero-based shot frames and local XYZ joint angles in degrees. Each key sets the interpolation toward the next key using `linear`, `hold`, or `ease`. Root keys set transforms relative to the character's world parent.

In Studio, create a project from `humanoid-animation` to evaluate motion under a full-body camera and dedicated lighting. Characters can layer reusable `scene.motionClips` and procedural motions through `motion`. Clip keys and fades use seconds. Layer start and end frames are inclusive and zero-based. A mask selects joint names or `root`. Clip root channels are position and rotation offsets from the character transform. Replacement weights on the same channel can sum to 1, while additive layers apply in layer ID order. Match the first and last channel values for a loop. Authored pose tracks take precedence over the corresponding motion channels.

The third shot, `shot.cup-interaction`, demonstrates pickup, lift, carry, placement, and release. Each `scene.interactions` entry binds a skeletal character and effector chain to a prop or root world entity for the shot. Hand anchors are relative to the effector tip in metres, and object anchors are relative to the object root before scaling. Rotation tuples are unit quaternions in WXYZ order. Action frames are inclusive and zero-based. Reach defaults to the object's anchor, carry and place targets describe the object's world pose, and grasp and release each occupy one frame. A carry without a target follows the character's authored motion. Use one interaction binding per character and object per shot.

The fourth shot, `shot.walk-and-place`, adds a walk across the room and a turn before the cup transfer. Set `locomotion.waypoints` on an unparented humanoid. Each waypoint specifies a zero-based shot frame, the standing root's world position in metres, and a yaw in degrees. Segment distance and frame duration set the average speed. Smooth easing stops at each waypoint, and linear easing keeps speed constant within a segment. Repeat the position with a new yaw to turn in place. The character stands at the last waypoint for the rest of the shot.

Locomotion adapts alternating steps to the timing and stride settings and locks each planted foot with IK. Feet use horizontal world box tops near the waypoint elevation, with `floorHeight` as the fallback. Use world boxes as collision proxies for prepared mesh assets. A blocked path or unreachable gait fails validation. Locomotion supplies the root track and rejects competing authored root tracks. Joint animation and hand interactions still use the existing Motion Engine and constraint priorities.

The fifth shot, `shot.cup-drop`, hands the cup from the interaction track to rigid-body simulation. Set `world.physics` for gravity, substeps, and solver iterations. World entities can define box, sphere, cylinder, or capsule `colliders` in local coordinates. Built world boxes provide default colliders. Imported assets use explicit proxies. Locomotion queries the same geometry at its authored pose, including horizontal box and cylinder tops for foot support.

Set an entity's `physics.mode` to `static`, `kinematic`, or `dynamic`, with mass in kilograms and friction, restitution, and damping from zero to one. Moving bodies use one primitive collider on a root entity. Static geometry can use several. `releaseOnInteraction` starts simulation on the frame after release. Explicit `transitions` use zero-based shot frames. Returning to kinematic mode requires a world-pose keyframe at the takeover frame. Blender samples the whole simulation in order and saves transform keys that can be evaluated directly at any render frame.

The sixth shot, `shot.partner-contact`, combines locomotion with a handshake and a controlled shove. Each `scene.contactGraph` edge names two skeletal characters, their bones and chain roots, and an anchor relative to each posed bone tip. The edge specifies B's pose relative to A in metres and WXYZ quaternion rotation. It can constrain position, orientation, or both. Use inclusive zero-based frames and optional blend-in and blend-out lengths. Unresolved contacts fail validation.

Set `scene.contactResponse` to turn a contact into a reaction. A load names a contact ID and specifies the world direction acting on endpoint B, with the opposite load acting on A. Specify force in newtons, impulse in newton-seconds, and force duration in seconds. The optional impact frame defaults to the end of contact blend-in. Per-character settings control mass, damping frequency, displacement limits, joint recoil and the optional stagger foot. The shove reference calculates the receiver's recoil, step and recovery while holding the other foot in place. Authored world-offset keys can replace the generated root response for a chosen interval. Explicit root poses, moving locomotion, and world-space IK or object interaction ownership take precedence over generated root displacement.

An imported character references a pinned model with `rigProfile: "FilmieHumanoid"` and `rigVersion: 1` in its asset metadata. For a prepared Blender asset, also set `blenderCollection` and mark the collection root with `filmie_asset_id` or `filmie_character_root`. Both formats require one armature and normalized skin weights. A `rigJointMap` on the asset binds every Filmie joint to a distinct source bone. A shot can override the map with `source.jointMap`. Mapped joints must follow the profile hierarchy. Filmie converts rotations between the two rest bases while keeping the source skin and skeleton. Supply `source.restSkeleton` when joint positions differ from the body-derived profile. Use metres, Z up, and −Y forward. This is compatible-rig mapping rather than automatic retargeting between arbitrary skeletons.

The Studio `character-deformation` catalog demonstrates a skinned GLB with renamed bones, an articulated arm bend, and an animated chest morph. Use `morphs` to key a relative target on a named source mesh with zero-based frames and weights from 0 to 1. Filmie supplies the pose and morph tracks at runtime and clears embedded character animation. Set `deformation.skinning` to linear or preserve-volume and optionally add surface subdivision after skinning. Imported material slots can keep their source materials or use `source.materialOverrides` with Filmie material definitions in `source.materials`. Procedural characters use denser skinned loops, continuous arm and hand surfaces, and configurable radial segments.

The Studio `facial-performance` catalog demonstrates a mapped jaw and eyes, a smile, a blink, and authored lip-sync. Share named definitions in `scene.facialRigs` and select one with a character's `facial.rigId`. A control can drive named mesh morphs, mapped facial bone rotations, or both. Facial bones declare source names, canonical parents, rest axes, and limits. Expressions and visemes are named sets of control weights. Speech cues select a viseme directly or map an authored phoneme to one. Cue and layer intervals use zero-based frames with an exclusive end, and the manifest supplies the speech timing.

Facial layers support keyed weights, fades, and additive or replacement blending. Higher priorities apply later, and authored control overrides apply last. Direct skeletal pose and morph tracks keep ownership of their channels. Gaze can aim head or eye joints at a world point or a compiled entity or joint, using the specified local forward axis. It respects joint limits and uses target poses before facial animation so characters can track one another without a dependency cycle.

## Architecture

- `packages/contracts`: validated manifest, scene, render, timeline, receipt, and serialization contracts.
- `packages/assets`: immutable asset versions, SHA-256 verification, and file resolution.
- `packages/scene`, `packages/timeline`, `packages/planner`: renderer-facing scene instructions, integer-frame timeline, and render-job planning.
- `packages/cache`, `packages/media`: local artifact cache and renderer-independent FFmpeg/FFprobe operations.
- `engines/blender`: Blender adapter and Python render worker.
- `packages/orchestrator`: filesystem project loading, validation, package approval, job execution, caching, assembly, and receipts.
- `apps/cli`: command-line composition root.

## Implemented and planned

Implemented: strict JSON manifests; Blender 3D collection loading; perspective camera paths and scene lighting; deterministic keyframed actions supported by the Blender worker when the referenced model supplies required controls; EEVEE, Cycles, and Workbench configuration; PNG sequence rendering; FFmpeg encoding, timeline ordering, transitions and audio cues; asset integrity checks, cache fingerprints, receipts, and FFprobe verification.

Planned: general asset authoring and rig preparation; broader animation/physics systems; richer model interchange and validation. Filmie currently consumes prepared `.blend` collections and does not create or rig production models.

## Development

```powershell
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

Production packages use ESM and strict TypeScript. Validate schema changes, preserve exact asset identities, include pixel-affecting values in render fingerprints, spawn tools with argument arrays, and reject unsupported instructions explicitly.

In Studio, choose the `skeletal-retargeting` catalog to transfer one clip from a taller procedural humanoid to a skinned GLB with different proportions and leg rest axes. Define reusable `scene.retargetProfiles` with the clip rig, its complete rest skeleton, and a versioned semantic mapping. Select a profile with `character.retargetProfileId`. Motion layers and masks use the source rig's joint names. The mapping converts root offsets before applying target placement, and target authored poses override matching channels. The target's world-space constraints, locomotion, and interactions run on the transferred pose. Use joint-only clips when locomotion owns the root trajectory. Imported assets still use their own `source.jointMap` and `source.restSkeleton` for Blender binding.

Choose `articulated-dynamics` in Studio for a hatch that releases onto a stop and a carriage driven along a rail by keyed motor velocity. Define `world.joints` between entities with one collision proxy each. Anchors use body-local metres and must coincide in world position and orientation at bind time. Hinges rotate and sliders translate along anchor A's local X axis. Motor velocity keys use zero-based shot frames. Bullet supports fixed, hinge, slider, and freely rotating ball joints, with optional collision suppression between linked bodies. Position drives, joint damping, and limited ball cones remain available in the standalone solver.

A kinematic world proxy can follow a skeletal character's root or a joint through `physics.followCharacter`. Its frame-zero pose must match the world bind pose. A dynamic transition transfers ownership to Bullet. Secondary motion uses separate local control tracks on a physics-owned root.

Filmie caches complete Bullet bakes separately from shot frames. The production cache stores them in each project's `simulations` directory. The key covers resolved collision bodies, constraints, authored motion, release schedules, the full shot frame interval and rate, and the Blender build and bake code. Camera, light, material and render quality edits can reuse the same bake. Shot receipts record `simulationFingerprint` and `simulationCacheHit` when the renderer prepares a simulation artifact.
