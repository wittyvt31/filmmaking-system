"""Bake Bullet transforms in a scene containing only simulation proxies."""
import json
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from animation_curves import action_fcurves
from physics_backend import bake_physics


def main():
    spec_path, output_path = sys.argv[sys.argv.index("--") + 1:]
    with open(spec_path, "r", encoding="utf-8") as stream:
        spec = json.load(stream)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = spec["frameRate"]["numerator"]
    scene.render.fps_base = spec["frameRate"]["denominator"]
    scene.frame_end = spec["frameCount"]
    baked = bake_physics(scene, spec["simulation"], spec["objectMotion"], spec["frameCount"], action_fcurves)
    result = {
        "version": 1,
        "fingerprint": spec["fingerprint"],
        "backend": spec["backend"],
        "frameRate": spec["frameRate"],
        "startFrame": 0,
        "frameCount": spec["frameCount"],
        "space": "world",
        "tracks": {entity: [{"position": list(p), "rotation": list(q)} for p, q in poses]
                   for entity, poses in baked.items()},
    }
    temporary = output_path + ".partial"
    with open(temporary, "w", encoding="utf-8") as stream:
        json.dump(result, stream, sort_keys=True, allow_nan=False)
    os.replace(temporary, output_path)


if __name__ == "__main__":
    main()
