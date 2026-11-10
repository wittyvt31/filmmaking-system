import json, sys
from pathlib import Path
import bpy
import numpy as np
sys.path.insert(0, str(Path("engines/blender/worker").resolve()))
import render_shot as worker

def rgb(path):
    image = bpy.data.images.load(str(path), check_existing=False)
    w,h = image.size
    pixels = np.empty(w*h*4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels.reshape(h,w,4)[::-1,:,:3]

spec = worker.read_spec()
out = Path(spec["outputDirectory"])
scene, _, roots, controls = worker.create_scene(spec)
worker.apply_actions(spec, roots, controls)
worker.apply_motion_curves(spec, controls, roots)
head = controls["father"]["head"]
scene.frame_set(61)
for obj in scene.objects:
    if obj != head:
        obj.animation_data_clear()
    if obj.data and hasattr(obj.data, "animation_data_clear"):
        obj.data.animation_data_clear()
for material in bpy.data.materials:
    if material.node_tree:
        material.node_tree.animation_data_clear()
scene.world.animation_data_clear()
frames = [1, 51, 61, 76, 86, 101, 111, 150]
box = [154, 171, 216, 234]
x,y,right,bottom = box
inside = np.zeros((360,640), dtype=bool)
inside[y:bottom,x:right] = True
baseline = None
report = {}
for frame in frames:
    scene.frame_set(frame)
    path = out / f"frame_{frame:06d}.png"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    if frame == 61:
        baseline = rgb(path)
    if frame == 111:
        diff = np.abs(rgb(path)-baseline)
        report = {"framesZeroBased":[60,110],"headBoxXyxy":box,
                  "angleDegrees":float(np.degrees(head.rotation_euler.y)),
                  "insideMean":float(diff[inside].mean()),
                  "outsideMax":float(diff[~inside].max()),
                  "cameraGrainAndBreathingFrozen":True}
report["passed"] = report["insideMean"] >= .009 and report["outsideMax"] == 0
(out/"motion.json").write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8")

if not report["passed"]:
    raise RuntimeError("Head motion failed the inside or outside pixel threshold")
