"""Build deterministic Filmie procedural assets and export a self-contained GLB."""
import json
import os
import sys

import bpy

from geometry_builder import build_mesh
from visual_runtime import build_material


def read_spec():
    try:
        separator = sys.argv.index("--")
        path = sys.argv[separator + 1]
    except (ValueError, IndexError) as exc:
        raise RuntimeError("Expected -- <procedural-spec.json>") from exc
    with open(path, "r", encoding="utf-8") as stream:
        return json.load(stream)


def apply_transform(obj, transform):
    position = transform["position"]
    rotation = transform["rotationDegrees"]
    obj.location = (position["x"], position["y"], position["z"])
    obj.rotation_euler = (
        rotation["x"] * 3.141592653589793 / 180.0,
        rotation["y"] * 3.141592653589793 / 180.0,
        rotation["z"] * 3.141592653589793 / 180.0,
    )
    obj.scale = (transform["scale"],) * 3


def main():
    spec = read_spec()
    definition = spec["definition"]
    output = os.path.abspath(spec["outputPath"])
    materials = {
        material["id"]: build_material(material)
        for material in sorted(definition["materials"], key=lambda item: item["id"])
    }
    meshes = {}
    for mesh_definition in sorted(definition["meshes"], key=lambda item: item["id"]):
        meshes[mesh_definition["id"]] = build_mesh(
            mesh_definition, materials[mesh_definition["materialId"]]
        )

    root = bpy.data.objects.new(definition["assetId"], None)
    bpy.context.scene.collection.objects.link(root)
    parts = {}
    sorted_parts = sorted(definition["parts"], key=lambda item: item["id"])
    for index, part in enumerate(sorted_parts, start=1):
        obj = bpy.data.objects.new(part["id"], meshes[part["meshId"]])
        bpy.context.scene.collection.objects.link(obj)
        parent = parts.get(part.get("parentId"), root)
        if parent is None:
            raise ValueError("Unknown procedural parent: " + part["parentId"])
        obj.parent = parent
        apply_transform(obj, part["transform"])
        obj["filmie_procedural_part_id"] = part["id"]
        obj["filmie_glb_node_index"] = index
        parts[part["id"]] = obj
    root["filmie_procedural_asset_id"] = definition["assetId"]
    root["filmie_procedural_definition_sha256"] = spec["definitionSha256"]
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0
    os.makedirs(os.path.dirname(output), exist_ok=True)
    result = bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        export_apply=False,
        export_animations=False,
        export_skins=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_extras=True,
    )
    if "FINISHED" not in result or not os.path.isfile(output):
        raise RuntimeError("Blender did not produce the requested procedural GLB")
    print(
        "FILMIE_PROCEDURAL_ASSET="
        + json.dumps(
            {
                "assetId": definition["assetId"],
                "partCount": len(sorted_parts),
                "meshCount": len(meshes),
            },
            sort_keys=True,
        )
    )


try:
    main()
except Exception as error:
    print("FILMIE_PROCEDURAL_ASSET_ERROR=" + json.dumps({"message": str(error)}))
    raise
