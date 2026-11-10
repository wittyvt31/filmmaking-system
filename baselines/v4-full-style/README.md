# Controlled 150-frame style comparison

Both manifests use the same three artwork files, camera push-in, seed, 150 frames at 30 FPS, 640×360 Blender render size, 16 EEVEE samples, and 1920×1080 H.264 MP4 delivery. Glow and final grade are disabled. The style version is the only pixel-relevant difference.

| Style                 | Blender render | Per frame | Visual verifier | Observation                                                                  |
| --------------------- | -------------: | --------: | --------------- | ---------------------------------------------------------------------------- |
| charcoal_horror 1.2.0 |      639.210 s |   4.261 s | Pass            | Original dark, screen-speckled treatment is preserved.                       |
| charcoal_horror 2.0.0 |     2292.311 s |  15.282 s | Pass            | Room, father, and telephone remain legible; screen-wide speckling is absent. |

Each MP4 has 150 frames, lasts 5.000 seconds, and passes FFprobe at 1920×1080, 30 FPS, H.264, yuv420p, and bt709. The verifier reports no blank, near-uniform, low-entropy, or identical consecutive frames. The contact sheets and numbered PNGs show the camera push-in.

The 2.0.0 render crashed near the ends of both parallel ranges and resumed the missing frames. Its original receipt incorrectly reports `completedWithWarning: false` because the adapter only recorded final successful attempts. The accompanying `2.0.0.last-blender-crash.txt` is the last available crash report; it records `EXCEPTION_ACCESS_VIOLATION` and Intel `ig11icd64.dll` version 31.0.101.2145. The adapter was corrected after this run to preserve per-attempt diagnostics and mark recovered renders with warnings. A targeted fake-Blender regression test verifies that correction; this 150-frame render was not repeated after the receipt fix.

The prior 150-frame flat receipt reports 25.727 s total, or 0.172 s/frame, on this machine. That is roughly 25× faster than 1.2.0 and 89× faster than 2.0.0, though flat uses Workbench and a separate preset. These are hardware-specific measurements, not production-speed forecasts. The 2.0.0 material needs performance work before longer films.
