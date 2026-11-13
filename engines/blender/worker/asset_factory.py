"""Headless interchange conversion into a self-contained GLB."""
import json
import os
import sys

import bpy


def read_spec():
    try:
        separator = sys.argv.index("--")
        path = sys.argv[separator + 1]
    except (ValueError, IndexError) as exc:
        raise RuntimeError("Expected -- <worker-spec.json>") from exc
    with open(path, "r", encoding="utf-8") as stream:
        return json.load(stream)


def import_source(path, extension):
    if extension == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path, load_ui=False)
        return
    if extension in (".glb", ".gltf"):
        result = bpy.ops.import_scene.gltf(filepath=path, disable_bone_shape=True)
    elif extension == ".fbx":
        result = bpy.ops.import_scene.fbx(
            filepath=path,
            automatic_bone_orientation=False,
            use_prepost_rot=True,
        )
    elif extension == ".obj":
        try:
            result = bpy.ops.wm.obj_import(filepath=path)
        except AttributeError:
            result = bpy.ops.import_scene.obj(filepath=path)
    else:
        raise RuntimeError("Unsupported source format: " + extension)
    if "FINISHED" not in result:
        raise RuntimeError("Blender did not finish importing " + path)


def contents(extension):
    objects = list(bpy.data.objects)
    types = {}
    for obj in objects:
        types[obj.type] = types.get(obj.type, 0) + 1
    warnings = []
    losses = []
    if extension == ".obj":
        losses.extend(["skinning", "animation"])
    if extension == ".fbx":
        losses.append("non-GLB constraints and drivers")
    if extension == ".blend":
        losses.extend(["non-GLB modifiers", "non-GLB constraints and drivers"])
    unsupported_types = sorted(
        kind for kind in types if kind not in {"MESH", "ARMATURE", "EMPTY", "CAMERA", "LIGHT"}
    )
    if unsupported_types:
        warnings.append("Unsupported Blender object types were not guaranteed to survive GLB export: " + ", ".join(unsupported_types))
        losses.append("unsupported object types: " + ", ".join(unsupported_types))
    if any(obj.animation_data and obj.animation_data.drivers for obj in objects):
        warnings.append("Animation drivers are not represented by GLB and were not evaluated.")
        losses.append("animation drivers")
    return {
        "objectCount": len(objects),
        "objectTypes": types,
        "objectNames": sorted(obj.name for obj in objects),
        "meshCount": len(bpy.data.meshes),
        "materialCount": len(bpy.data.materials),
        "imageCount": len(bpy.data.images),
        "armatureCount": len(bpy.data.armatures),
        "actionCount": len(bpy.data.actions),
        "collectionCount": len(bpy.data.collections),
        "warnings": warnings,
        "losses": sorted(set(losses)),
    }


def main():
    spec = read_spec()
    source = os.path.abspath(spec["sourcePath"])
    output = os.path.abspath(spec["outputPath"])
    extension = os.path.splitext(source)[1].lower()
    import_source(source, extension)
    report = contents(extension)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    result = bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        export_apply=False,
        export_animations=True,
        export_skins=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_cameras=True,
        export_lights=True,
    )
    if "FINISHED" not in result or not os.path.isfile(output):
        raise RuntimeError("Blender did not produce the requested GLB output")
    print("FILMIE_ASSET_FACTORY=" + json.dumps({"contents": report}))


try:
    main()
except Exception as error:
    print("FILMIE_ASSET_FACTORY_ERROR=" + json.dumps({"message": str(error)}))
    raise
