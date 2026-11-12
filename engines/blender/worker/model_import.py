"""Load pinned interchange assets with Blender's native import operators."""
import json
import os
import struct

import bpy


def validate_glb(path):
    with open(path, "rb") as stream:
        header = stream.read(20)
        if len(header) != 20:
            raise ValueError("Truncated GLB header")
        magic, version, size, chunk_size, kind = struct.unpack("<4sIII4s", header)
        if (magic != b"glTF" or version != 2 or size != os.fstat(stream.fileno()).st_size
                or kind != b"JSON" or chunk_size > min(16 * 1024**2, size - 20)):
            raise ValueError("Invalid GLB 2.0 header or JSON chunk")
        document = json.loads(stream.read(chunk_size))
    for section in ("buffers", "images"):
        for entry in document.get(section, []):
            uri = entry.get("uri")
            if uri is not None and not uri.startswith("data:"):
                raise ValueError("GLB must be self-contained; external buffers or textures are unsupported")


def import_model(asset, destination):
    path = asset["localPath"]
    format_name = asset["format"]
    before = set(bpy.data.objects)
    collections = set(bpy.data.collections)
    if format_name == "glb":
        validate_glb(path)
        result = bpy.ops.import_scene.gltf(filepath=path)
    elif format_name == "stl":
        result = bpy.ops.wm.stl_import(filepath=path)
    elif format_name == "ply":
        result = bpy.ops.wm.ply_import(filepath=path)
    else:
        raise ValueError("Unsupported model format " + format_name)
    objects = sorted(set(bpy.data.objects) - before, key=lambda obj: obj.name)
    if "FINISHED" not in result or not any(obj.type == "MESH" for obj in objects):
        raise ValueError("Import did not produce a mesh for " + asset["assetId"])
    bpy.context.view_layer.update()
    root = bpy.data.objects.new(asset["assetId"], None)
    destination.objects.link(root)
    for obj in objects:
        if obj.parent is None:
            matrix = obj.matrix_world.copy()
            obj.parent = root
            obj.matrix_world = matrix
        if obj.type == "LIGHT":
            obj.hide_render = True
        previous = list(obj.users_collection)
        if destination not in previous:
            destination.objects.link(obj)
        for collection in previous:
            if collection != destination:
                collection.objects.unlink(obj)
    for collection in set(bpy.data.collections) - collections:
        if not collection.all_objects:
            bpy.data.collections.remove(collection)
    for name in ("assetId", "version", "format"):
        root["filmie_model_" + name] = asset[name]
    return root


def instantiate_with_materials(instantiate, asset, transform, entity_id, collection, overrides, materials):
    if not overrides:
        return instantiate(asset, transform, entity_id, collection)[0]
    # Blender suffixes colliding datablock names. Temporarily reserve the source
    # names so slot rules refer to the file's names, including real numeric suffixes.
    existing = [(mat, mat.name) for mat in bpy.data.materials]
    existing_names = {name for _, name in existing}
    for i, (material, _) in enumerate(existing):
        material.name = f"__FilmieReserved__{i}__"
    try:
        root, _ = instantiate(asset, transform, entity_id, collection)
        named = {slot["source"]: materials[slot["materialId"]] for slot in overrides.get("slots", [])}
        replace_all = materials[overrides["materialId"]] if overrides["mode"] == "all" else None
        matched = set()
        for obj in [root, *root.children_recursive]:
            if obj.type != "MESH":
                continue
            if not obj.material_slots and replace_all is not None:
                # A shared source mesh may appear in multiple instances.
                obj.data = obj.data.copy()
                obj.data.materials.append(replace_all)
            for slot in obj.material_slots:
                name = slot.material.name if slot.material else None
                replacement = replace_all if replace_all is not None else named.get(name)
                if replacement is not None:
                    if name in named:
                        matched.add(name)
                    slot.link = "OBJECT"
                    slot.material = replacement
        missing = sorted(set(named) - matched)
        if missing:
            raise ValueError(f"Unknown source materials on {entity_id}: {', '.join(missing)}")
        return root
    finally:
        reserved = {mat for mat, _ in existing}
        for material in bpy.data.materials:
            if material not in reserved and material.name in existing_names:
                material.name = entity_id + "/" + material.name
        for material, name in existing:
            material.name = name
