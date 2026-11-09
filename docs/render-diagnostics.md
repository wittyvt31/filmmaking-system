# Render diagnostics — reference-shot final

Date: 2026-11-09

## Result

The final-profile render completed and Blender exited with code 0, but visual inspection of `renders/reference-shot/final/master.contact-sheet.png` showed a nearly uniform gray frame with no discernible reference artwork. The luma-based verifier reports no near-black/near-white frames, so this visual blank was not detected by its specified threshold checks. Per the task stop rule, no corrective render or renderer change was attempted. The separate proof-final run was interrupted and left incomplete.

## Blender and receipt evidence

- Blender: 5.2.3 LTS
- Blender process exit code: 0 (final reference render); not a crash.
- Faulting module: none.
- Completed frames: 150/150 for the final reference render. Proof-final was interrupted while in progress.
- Final reference receipt `completedWithWarning`: false
- Final reference receipt renderer/backend: `BLENDER_WORKBENCH` / `WORKBENCH`; samples: 64; 1920x1080.
- Final reference verifier: 150 frames, 5 seconds, 1920x1080, 30 FPS, no threshold-blank frames, 67 identical consecutive sampled frames.
- Separate stderr capture: unavailable; the receipt stores merged worker output, not a separate stderr stream. The following are the last 30 available receipt log entries.

## Last 30 available renderer log entries (verbatim receipt entries; merged stream)

01:09.344 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000131.png'
01:09.844 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000132.png'
01:10.328 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000133.png'
01:10.813 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000134.png'
01:11.282 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000135.png'
01:11.735 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000136.png'
01:12.203 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000137.png'
01:12.657 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000138.png'
01:13.110 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000139.png'
01:13.563 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000140.png'
01:14.016 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000141.png'
01:14.485 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000142.png'
01:14.907 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000143.png'
01:15.360 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000144.png'
01:15.813 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000145.png'
01:16.266 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000146.png'
01:16.735 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000147.png'
01:17.203 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000148.png'
01:17.641 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000149.png'
01:18.063 render | Saved: 'D:\filmmaking-system\renders\reference-shot\final\production\ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs\shots\.shot.reference-layered-room.blender.5e8b987741395d7d.partial\artifact\frames\frame_000150.png'
Info: Saved as "scene.blend"

Blender quit
D:\filmmaking-system\engines\blender\worker\render_shot.py:50: DeprecationWarning: 'Scene.use_nodes' is expected to be removed in Blender 6.0
scene.use_nodes = True
FILMIE_GLOW_SKIPPED: Compositor node group exposes no image output socket
D:\filmmaking-system\engines\blender\worker\render_shot.py:84: DeprecationWarning: 'Scene.use_nodes' is expected to be removed in Blender 6.0
scene.use_nodes = False
D:\filmmaking-system\engines\blender\worker\render_shot.py:440: DeprecationWarning: 'Material.use_nodes' is expected to be removed in Blender 6.0
material.use_nodes = True

## Paths

- Final video: `renders/reference-shot/final/master.mp4`
- Contact sheet: `renders/reference-shot/final/master.contact-sheet.png`
- Verify report: `renders/reference-shot/final/master.verify.json`
- Scene: `renders/reference-shot/final/production/ZmlsbWllLnJlZmVyZW5jZS1zaG90LWZpbmFs/shots/shot.reference-layered-room.blender/scene.blend`
- Interrupted proof-final output: `renders/reference-shot/proof-final/`
