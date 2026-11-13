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
    return document


def import_model(asset, destination, character=False):
    path = asset["localPath"]
    format_name = asset["format"]
    before = set(bpy.data.objects)
    collections = set(bpy.data.collections)
    document = None
    if format_name == "glb":
        document = validate_glb(path)
        # Importer-generated bone widgets belong to a hidden collection. Skip
        # them so moving model objects into the destination never exposes them.
        result = bpy.ops.import_scene.gltf(filepath=path, disable_bone_shape=True)
    elif format_name == "stl":
        result = bpy.ops.wm.stl_import(filepath=path)
    elif format_name == "ply":
        result = bpy.ops.wm.ply_import(filepath=path)
    else:
        raise ValueError("Unsupported model format " + format_name)
    objects = sorted(set(bpy.data.objects) - before, key=lambda obj: obj.name)
    if "FINISHED" not in result or not any(obj.type == "MESH" for obj in objects):
        raise ValueError("Import did not produce a mesh for " + asset["assetId"])
    if character:
        for obj in objects:
            obj.animation_data_clear()
            if obj.type == "MESH" and obj.data.shape_keys:
                obj.data.shape_keys.animation_data_clear()
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
    articulation_nodes = {}
    descriptor = asset.get("descriptor")
    if descriptor and document:
        objects_by_node_index = {}
        marker_keys = (
            "filmie_glb_node_index",
            "filmieGlbNodeIndex",
            "gltf2io_gltf2_node",
            "gltf2io_gltf2_node_index",
        )
        for obj in objects:
            for key in marker_keys:
                marker = obj.get(key)
                if isinstance(marker, (int, float)) and int(marker) == marker:
                    if marker in objects_by_node_index and objects_by_node_index[marker] != obj:
                        raise ValueError("Duplicate deterministic GLB node mapping: " + str(marker))
                    objects_by_node_index[marker] = obj
                    break
        objects_by_part_id = {}
        for obj in objects:
            for key in ("filmieProceduralPartId", "filmie_procedural_part_id"):
                part_id = obj.get(key)
                if isinstance(part_id, str):
                    if part_id in objects_by_part_id and objects_by_part_id[part_id] != obj:
                        raise ValueError("Duplicate deterministic procedural part mapping: " + part_id)
                    objects_by_part_id[part_id] = obj
                    break
        nodes = document.get("nodes", [])
        for handle in descriptor.get("resolvedHandles", []):
            node_index = handle.get("nodeIndex")
            if node_index is None:
                continue
            if node_index < 0 or node_index >= len(nodes):
                raise ValueError(
                    "Semantic handle node index is outside the imported GLB: "
                    + handle.get("id", "unknown")
                )
            extras = nodes[node_index].get("extras", {})
            part_id = None
            if isinstance(extras, dict):
                part_id = extras.get("filmieProceduralPartId") or extras.get(
                    "filmie_procedural_part_id"
                )
            indexed = objects_by_node_index.get(node_index)
            if isinstance(part_id, str):
                # The GLB document is authoritative: an importer-generated index
                # marker must never redirect a procedural handle to another part.
                mapped = objects_by_part_id.get(part_id)
                if indexed is not None and mapped is not None and indexed != mapped:
                    raise ValueError(
                        "Conflicting GLB index and procedural part metadata for handle: "
                        + handle.get("id", "unknown")
                    )
            else:
                mapped = indexed
            if mapped is None:
                raise ValueError(
                    "GLB lacks deterministic semantic node metadata for handle: "
                    + handle.get("id", "unknown")
                )
            articulation_nodes[str(node_index)] = mapped
            mapped["filmie_glb_node_index"] = int(node_index)
    return root, articulation_nodes


def instantiate_with_materials(instantiate, asset, transform, entity_id, collection, overrides, materials):
    if not overrides:
        return instantiate(asset, transform, entity_id, collection)[0]
    root = capture_character_names(lambda: instantiate(asset, transform, entity_id, collection)[0], entity_id)
    apply_material_overrides(root, entity_id, overrides, materials)
    return root


def capture_character_names(load, entity_id, capture_meshes=False):
    # Blender suffixes colliding datablock names. Temporarily reserve the source
    # names so slot rules refer to the file's names, including real numeric suffixes.
    groups = [(bpy.data.materials, "filmie_source_material")]
    if capture_meshes:
        groups.append((bpy.data.objects, "filmie_source_object"))
    reservations = []
    for datablocks, key in groups:
        existing = {item: item.name for item in datablocks}
        names = set(existing.values())
        prefix = "__FilmieReserved__"
        while any(name.startswith(prefix) for name in names):
            prefix += "_"
        for i, item in enumerate(existing):
            item.name = f"{prefix}{i}"
        reservations.append((datablocks, key, existing, names))
    try:
        return load()
    finally:
        for datablocks, key, existing, names in reservations:
            for item in list(datablocks):
                if item in existing:
                    continue
                if key not in item:
                    item[key] = item.name
                if item.name in names:
                    item.name = entity_id + "/" + item.name
            for item, name in existing.items():
                item.name = name


def apply_material_overrides(root, entity_id, overrides, materials):
    named = {slot["source"]: materials[slot["materialId"]] for slot in overrides.get("slots", [])}
    replace_all = materials[overrides["materialId"]] if overrides["mode"] == "all" else None
    matched = set()
    for obj in [root, *root.children_recursive]:
        if obj.type != "MESH":
            continue
        if not obj.material_slots and replace_all is not None:
            obj.data = obj.data.copy()
            obj.data.materials.append(replace_all)
        for slot in obj.material_slots:
            name = slot.material.get("filmie_source_material", slot.material.name) if slot.material else None
            replacement = replace_all if replace_all is not None else named.get(name)
            if replacement is not None:
                if name in named:
                    matched.add(name)
                slot.link = "OBJECT"
                slot.material = replacement
    missing = sorted(set(named) - matched)
    if missing:
        raise ValueError(f"Unknown source materials on {entity_id}: {', '.join(missing)}")
