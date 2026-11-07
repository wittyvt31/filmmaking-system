# Blender 5.2 Integration Readiness Audit

Date: 2026-11-07  
Repository: `D:\filmmaking-system`  
Audit scope: integration readiness only. No production code, projects, manifests, or artwork were changed. No packages were installed.

## Overall result

**NOT READY to become the primary rendering engine on this workstation.** Blender automation and the Node process-launch path are demonstrable, and FFmpeg can produce a compliant MP4 from Blender-rendered frames. However, the EEVEE render process repeatedly exits with Windows access violation `0xC0000005` in `ig11icd64.dll` after producing frames. This makes successful render completion unreliable. An active compositor node-group trial also produced blank white frames, and the direct Blender MP4 output configuration tested here failed. These are concrete integration blockers; the report does not infer production suitability from the simple scene.

## Diagnostic locations

All audit-created diagnostic files are under:

`C:\Users\hp\AppData\Local\Temp\Filmie Blender Audit b83f074f9e484850957eb1dcd8899323`

Notable outputs:

- `diagnostic-scene.blend`
- `frames\frame_0001.png`, `frame_0002.png`, `frame_0003.png`
- `diagnostic-ffmpeg.mp4`
- `node-process-tests\node-blender-integration.json`
- `image-sequence-import.json`
- `video-api-probe\`
- `blender.crash.txt` (captured Blender crash report)

Blender also wrote its automatic crash file at `C:\Users\hp\AppData\Local\Temp\blender.crash.txt`. No diagnostic or production files were deleted.

## Results by stage

| Area | Status | Executed evidence |
|---|---|---|
| Blender install/version | PASS | Absolute executable `"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe" --version` reported Blender 5.2.3 LTS, build date 2026-10-22, hash `e13b728c6880`, Windows. |
| Blender on PATH | FAIL | `Get-Command blender` found no command; `blender --version` returned “The term 'blender' is not recognized”. |
| Absolute background invocation | PASS | `blender.exe --background --factory-startup --python <script>` launched and ran Python; no-render script exited 0. |
| Blender Python automation | PASS | Blender-bundled Python reported 3.13.13 at `C:\Program Files\Blender Foundation\Blender 5.2\5.2\python\bin\python.exe`. Script created a scene, camera, light and objects; transformed objects; inserted camera keyframes; and saved `diagnostic-scene.blend` (117,200 bytes). This is Blender's bundled Python, not a verification of the separately installed system Python. |
| EEVEE image-sequence render | FAIL (render produced frames; process failed) | EEVEE `BLENDER_EEVEE`, 8 samples, generated three 1920×1080 PNG frames in 27.347 seconds. The process then exited `-1073741819` (`0xC0000005`, `EXCEPTION_ACCESS_VIOLATION`) in `ig11icd64.dll`. Reopened the saved scene and rendered one frame; it saved the frame and crashed the same way. The Intel graphics driver is implicated by the crash module, but the audit cannot claim a definitive underlying driver defect. |
| Animation/frame difference | PASS (output content), FAIL (clean process completion) | Camera X moved from approximately `-0.8000000119` to `0.8000000119`; 1,902 sampled pixels differed between first and last frames. Frame SHA-256: `5af9a1b6b79075eea17c5d37f2c0443c976b35b9d6b46c5d30bd3f709a2a19fe`, `a06163532d3fa31362293ad3ce0ac80f0da4449eb83f1a9e1e0d5c44cced6001`, `08de0eec3931444cda720209586500ae3aaeb9f2b832ecfc21095ded1b813b25`. |
| Active compositor node group | FAIL | Blender 5.2 API accepted a scene compositing node group and links; the attached graph rendered blank white frames. Scene API differs from older `scene.node_tree` examples (`scene.compositing_node_group`). Further compositor integration work is required before relying on it. |
| PNG transparency / layering | PASS | RGBA PNG alpha channel inspected (4 channels, alpha range 0–1). Separate character and prop PNGs were imported and composited as camera-facing image planes; rendered output showed both layers. |
| SVG import | PASS | A temporary SVG was imported through Blender's `bpy.ops.import_curve.svg`; a curve object was created without installing packages. |
| Image-sequence import | PASS | Blender `ShaderNodeTexImage.image_user` loaded a three-frame sequence; source was `SEQUENCE`, duration 3, frame 2 selected. Evidence in `image-sequence-import.json`. |
| Existing project asset import | PASS | Read and loaded `examples/they-have-reached` images: `interior-wide.png` 531×266×4; `interior-close.png` 381×266×4; `characters/father-seated.png` 316×335×4; `props/telephone.png` 335×192×4. This verifies import, not final artistic compositing quality. |
| Blender direct MP4 output | FAIL (tested configuration) | Setting `scene.render.image_settings.file_format='FFMPEG'` raised `TypeError`: enum `FFMPEG` not found; available values listed image formats (AVIF, JPEG, OPEN_EXR, PNG, etc.). An RNA enum probe showed FFMPEG metadata, but assignment failed for tested RGB and RGBA configurations. This does not prove every Blender video-output mode is unavailable. |
| FFmpeg fallback encode | PASS | Existing FFmpeg 9.0.2 assembled the 3 PNG frames. FFprobe reported H.264, 1920×1080, `yuv420p`, `bt709`, 30/1 FPS, 3 frames, 0.100000 seconds, and no audio stream. MP4 SHA-256: `AFF430F328E9A0AF207DE6B5C9E387225C8BFF9303F00431FC3570938375B8F4`. |
| FFmpeg / FFprobe install | PASS | PATH resolved both to `D:\tools\ffmpeg-9.0.2-full_build\ffmpeg-9.0.2-full_build\bin\`; both `-version` outputs identified 9.0.2. |
| Node/TypeScript process integration | PASS (launch mechanics) | Node v22.17.0 spawned Blender by absolute path, passed a Python-script path containing spaces, captured stdout/stderr, located generated JSON, detected a forced exit code 23, and terminated a 1-second timeout run (SIGTERM). Evidence in `node-process-tests\node-blender-integration.json`. This is a diagnostic harness, not a production adapter. |
| Existing adapter architecture | PASS (structural fit); PARTIAL (configuration wiring) | `RendererAdapter` is generic and injected into the orchestrator. Requests carry a shot, resolved local asset paths and hashes, settings, artifact, seed, cache/receipt paths, timeout, and abort signal. The media process helper uses `child_process.spawn` with argument arrays, output capture, timeout and abort support. Current CLI directly constructs `RemotionRendererAdapter`; strict renderer configuration/selection schemas currently accept Remotion only. Blender can fit the interface without a core redesign, but schema/configuration dispatch and a Blender adapter are still required. No adapter was implemented in this audit. |
| Hardware/driver inventory | PASS (available detail) | Windows CIM hardware query was denied. `dxdiag` provided Intel UHD Graphics, display memory 4068 MB (128 MB dedicated, 3940 MB shared), driver `27.20.100.8853`, 1920×1080. Node reported Intel Core i5-1035G1 @1.00GHz, 8 logical CPUs, 8,263,434,240 bytes total RAM; 1,560,117,248 bytes free at measurement. |

Blender emitted this environment warning during testing: `Extensions: writing cache failed ([WinError 5] Access is denied: 'C:\Users\hp\AppData\Roaming\Blender Foundation\Blender\5.2\extensions')`. The probes still ran, but extension-cache writes to that user location were denied. No permissions were changed.

## TypeScript integration assessment

The current renderer-adapter boundary is suitable for a Blender adapter: the orchestrator depends on an injected adapter, while the media package owns safe process launching. There is no need to redesign those boundaries. Integration work will need to add a validated Blender renderer selection/configuration and CLI adapter dispatch, then implement the adapter's capabilities, render and inspection operations. The audit did not build or run such an adapter.

## Manual configuration required

To make the executable discoverable by commands using PATH, add this directory to the Windows user or system PATH and open a new terminal:

`C:\Program Files\Blender Foundation\Blender 5.2`

Alternatively, configure the absolute executable path in a future validated application setting. This audit did not edit PATH or application configuration. Confirm the Intel graphics driver and Blender/EEVEE compatibility with the machine administrator or vendor; the access violation must be resolved or a supported rendering device/path selected and retested before designating Blender primary.

## Scope and limitations

- This was a small EEVEE diagnostic scene, not a benchmark or production scene; the 27.347-second time must not be extrapolated to production throughput.
- No character rigs, production environment, renderer adapter, package, or production asset was created or changed.
- Windows permissions, forced process failure, timeout termination, paths with spaces, FFmpeg/FFprobe, and generated output were exercised. Disk exhaustion and a real user interruption were **NOT TESTED**.
- System Python version was **NOT TESTED**; Blender's bundled Python was tested.
- Dedicated VRAM reported by dxdiag is 128 MB; shared graphics memory is not dedicated VRAM.

## Required follow-up before primary-engine approval

1. Resolve the repeatable Blender process access violation and rerun the EEVEE tests until Blender exits successfully.
2. Select and verify a working Blender 5.2 compositor workflow for layered project artwork.
3. Decide whether Blender should emit image sequences and leave H.264 encoding to FFmpeg; that fallback path passed this diagnostic.
4. After approval, implement Blender configuration/CLI dispatch and the adapter behind the existing interface, with tests for timeout, cancellation, failures, and artifact validation.
5. Repeat clean output verification through the production orchestrator, then run representative production workloads before evaluating performance.
