"""Render eight frames with the camera and non-character animation held at frame one."""

import json
import sys
from pathlib import Path

import bpy
import numpy as np

sys.path.insert(0, str(Path("engines/blender/worker").resolve()))
import render_shot as worker


def read_rgb(path):
    image = bpy.data.images.load(str(path), check_existing=False)
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels.reshape(height, width, 4)[::-1, :, :3]


def main():
    spec = worker.read_spec()
    out = Path(spec["outputDirectory"])
    scene, _, roots, controls = worker.create_scene(spec)
    worker.apply_actions(spec, roots, controls)
    worker.apply_motion_curves(spec, controls, roots)
    head, torso = (controls["father"][key] for key in ("head", "chest"))
    character = spec["characters"][0]
    try:
        worker.instantiate_asset(character["artwork"], character["transform"],
                                 spec["style"], "bad-rig", {"contentHash": "incorrect"})
    except RuntimeError as error:
        if "Matte cutout rig" not in str(error):
            raise
        # The failure occurs before animation or rendering. Discard the appended copy.
        bad = bpy.data.objects["bad-rig"]
        for collection in list(bad.users_collection):
            for obj in list(collection.objects):
                bpy.data.objects.remove(obj, do_unlink=True)
            bpy.data.collections.remove(collection)
    else:
        raise RuntimeError("Worker ignored the incompatible rig reference")
    for pivot in (head, torso):
        sprite = next(obj for obj in pivot.children if obj.type == "MESH")
        material = sprite.data.materials[0]
        image = next(node.image for node in material.node_tree.nodes if node.type == "TEX_IMAGE")
        pixels = np.empty(len(image.pixels), dtype=np.float32)
        image.pixels.foreach_get(pixels)
        assert pixels[3::4].min() == 0 and pixels[3::4].max() == 1
        assert material.surface_render_method == "BLENDED"
    scene.frame_set(1)
    for obj in scene.objects:
        if obj not in (head, torso):
            obj.animation_data_clear()
        if obj.data and hasattr(obj.data, "animation_data_clear"):
            obj.data.animation_data_clear()
    for material in bpy.data.materials:
        if material.node_tree:
            material.node_tree.animation_data_clear()
    scene.world.animation_data_clear()
    # Fixed-camera pixel box containing the father and a margin for the two motions.
    left, top, right, bottom = 115, 158, 268, 319
    inside = np.zeros((spec["height"], spec["width"]), dtype=bool)
    inside[top:bottom, left:right] = True
    samples = []
    reference = None
    for frame in (1, 31, 61, 76, 86, 101, 111, 150):
        scene.frame_set(frame)
        path = out / f"frame_{frame:06d}.png"
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        rgb = read_rgb(path)
        if reference is None:
            reference = rgb
        difference = np.abs(rgb - reference).mean(axis=2)
        samples.append({
            "frame": frame,
            "insideMeanAbsoluteRgbDifference": float(difference[inside].mean()),
            "outsideMeanAbsoluteRgbDifference": float(difference[~inside].mean()),
            "torsoScaleZ": float(torso.scale.z),
            "headRotationRadians": list(head.rotation_euler),
        })
    peak_inside = max(sample["insideMeanAbsoluteRgbDifference"] for sample in samples)
    peak_outside = max(sample["outsideMeanAbsoluteRgbDifference"] for sample in samples)
    passed = (peak_inside > 0.0001 and peak_outside <= 0.0001
              and peak_outside < peak_inside / 10
              and abs(samples[2]["torsoScaleZ"] - 1.008) < 1e-6
              and abs(samples[4]["headRotationRadians"][1] - 0.0275) < 1e-6
              and abs(samples[-1]["headRotationRadians"][1] - 0.055) < 1e-6)
    (out / "motion.json").write_text(json.dumps({
        "passed": passed, "boxXyxy": [left, top, right, bottom],
        "measurement": "Mean absolute RGB difference against frame 1. Camera, material grain and other animation are frozen at frame 1.",
        "peakInside": peak_inside, "peakOutside": peak_outside, "samples": samples,
    }, indent=2) + "\n", encoding="utf-8")
    if not passed:
        raise RuntimeError("Father motion did not meet the recorded criteria")


main()
