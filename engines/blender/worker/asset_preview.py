"""Render a fast geometry/material preview of a *published* Filmie GLB asset.

This deliberately reimports the final artifact through model_import, including
the semantic-node checks used by production. It never modifies the source GLB.
"""
import json
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model_import import import_model


def read_spec():
    try:
        spec_path = sys.argv[sys.argv.index("--") + 1]
    except (ValueError, IndexError) as exc:
        raise RuntimeError("Expected -- <asset-preview-spec.json>") from exc
    with open(spec_path, "r", encoding="utf-8") as stream:
        return json.load(stream)


def main():
    spec = read_spec()
    scene = bpy.context.scene
    root, semantic_nodes = import_model(
        {
            "localPath": spec["inputPath"],
            "format": "glb",
            "assetId": spec["assetId"],
            "version": spec["version"],
            "descriptor": spec["descriptor"],
        },
        scene.collection,
    )
    required_nodes = {
        str(item["nodeIndex"])
        for item in spec["descriptor"].get("resolvedHandles", [])
        if "nodeIndex" in item
    }
    if not required_nodes.issubset(semantic_nodes.keys()):
        raise RuntimeError("Published GLB semantic node mappings are incomplete")

    meshes = [obj for obj in root.children_recursive if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("Published GLB has no previewable mesh geometry")
    bpy.context.view_layer.update()
    corners = [
        obj.matrix_world @ Vector(corner)
        for obj in meshes
        for corner in obj.bound_box
    ]
    minimum = Vector(tuple(min(point[axis] for point in corners) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in corners) for axis in range(3)))
    center = (minimum + maximum) * 0.5
    span = max((maximum - minimum).length, 0.5)

    camera_data = bpy.data.cameras.new("Filmie Asset Preview Camera")
    camera = bpy.data.objects.new("Filmie Asset Preview Camera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = center + Vector((span * 1.12, -span * 1.35, span * 0.85))
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = span * 1.45
    camera_data.clip_start = 0.01
    camera_data.clip_end = max(1000.0, span * 10)
    scene.camera = camera

    # Workbench renders quickly on CPU-only systems and still makes part colors,
    # geometry, scale and parent hierarchy visually inspectable.
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.background_type = "WORLD"
    scene.world = bpy.data.worlds.new("Filmie Asset Preview Background")
    scene.world.color = (0.06, 0.075, 0.095)
    scene.render.resolution_x = 720
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.filepath = os.path.abspath(spec["outputPath"])
    scene.frame_set(1)
    bpy.ops.render.render(write_still=True)
    if not os.path.isfile(scene.render.filepath):
        raise RuntimeError("Blender did not write the preview PNG")
    print("FILMIE_ASSET_PREVIEW=" + json.dumps({
        "outputPath": scene.render.filepath,
        "meshCount": len(meshes),
        "semanticNodeCount": len(semantic_nodes),
    }, sort_keys=True))


try:
    main()
except Exception as error:
    print("FILMIE_ASSET_PREVIEW_ERROR=" + json.dumps({"message": str(error)}))
    raise
