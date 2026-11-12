"""Resolve character assets, check their rig contract, and apply authored poses."""
import math

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector

from character_builder import generate_character
from collection_cache import read_collection, write_collection
from model_import import apply_material_overrides, capture_character_names
from visual_runtime import build_material


def ancestors(item):
    while item.parent:
        item = item.parent
        yield item


def apply_root(root, transform):
    root.location = tuple(transform["position"][axis] for axis in ("x", "y", "z"))
    root.rotation_mode = "XYZ"
    root.rotation_euler = tuple(math.radians(transform["rotationDegrees"][axis]) for axis in ("x", "y", "z"))
    root.scale = (transform["scale"],) * 3


def validate_rig(root, collection, character):
    armatures = [obj for obj in collection.all_objects if obj.type == "ARMATURE"]
    if len(armatures) != 1:
        raise ValueError("Character must have exactly one armature: " + character["id"])
    rig = armatures[0]
    source = character["source"]
    mapped = source.get("jointMap", {})
    adaptive = source["kind"] == "imported" and (
        source["asset"].get("format") == "glb" or mapped or source.get("restSkeleton"))
    identity = Matrix.Identity(4)
    if not adaptive and (rig.parent != root or any(abs(a - b) > 1e-5 for row, expected in zip(rig.matrix_local, identity) for a, b in zip(row, expected))):
        raise ValueError("Character armature must have an identity transform relative to its root")
    if adaptive and root not in ancestors(rig):
        raise ValueError("Character armature is outside the model root")
    relative = root.matrix_world.inverted() @ rig.matrix_world if adaptive else identity
    position, orientation, scale = relative.decompose()
    if adaptive and (min(scale) <= 0 or max(scale) - min(scale) > 1e-5 or
                     any(abs(a-b) > 1e-5 for row, rebuilt in zip(relative, Matrix.LocRotScale(position, orientation, scale))
                         for a,b in zip(row, rebuilt))):
        raise ValueError("Character armature requires a positive uniform scale and no shear")
    bindings = {}
    mapped_names = {mapped.get(b["id"], b["id"]) for b in character["bones"]}
    for expected in character["bones"]:
        name = mapped.get(expected["id"], expected["id"])
        joint = rig.data.bones.get(name)
        head, tail = Vector(expected["head"]), Vector(expected["tail"])
        parent = expected.get("parent")
        parent_name = mapped.get(parent, parent)
        if joint is None or (parent and (joint.parent is None or joint.parent.name != parent_name)):
            raise ValueError(f"Missing or incompatible joint hierarchy: {expected['id']} -> {name}")
        if not parent and joint.parent and (not adaptive or any(p.name in mapped_names for p in ancestors(joint))):
            raise ValueError("Incompatible mapped root joint: " + name)
        rest = bpy.types.Bone.MatrixFromAxisRoll((tail - head).normalized(), 0)
        actual_head = relative @ joint.head_local
        if (actual_head - head).length > 1e-4:
            raise ValueError(f"Incompatible joint rest pose: {name}, expected head {tuple(head)}, got {tuple(actual_head)}")
        rotation = joint.matrix_local.to_3x3()
        if not adaptive and ((joint.tail_local - tail).length > 1e-4 or any(
            abs(a - b) > 1e-4 for row, expected_row in zip(rotation, rest) for a, b in zip(row, expected_row)
        )):
            raise ValueError("Incompatible joint rest pose: " + joint.name)
        if adaptive:
            source_basis = orientation @ rotation.to_quaternion()
            bindings[expected["id"]] = {"bone": name, "basis": list(source_basis.inverted() @ rest.to_quaternion())}
    if any(bone.constraints for bone in rig.pose.bones):
        raise ValueError("Filmie pose rigs must be free of imported pose constraints")
    meshes = [obj for obj in collection.all_objects if obj.type == "MESH" and len(obj.data.vertices) and any(
        modifier.type == "ARMATURE" and modifier.object == rig and modifier.use_vertex_groups
        for modifier in obj.modifiers
    )]
    if not meshes:
        raise ValueError("Character armature has no skinned geometry: " + character["id"])
    for mesh in meshes:
        indices = {group.index for group in mesh.vertex_groups if group.name in rig.data.bones and rig.data.bones[group.name].use_deform}
        for vertex in mesh.data.vertices:
            total = sum(group.weight for group in vertex.groups if group.group in indices)
            if abs(total - 1) > 1e-3:
                raise ValueError("Character mesh has unnormalized or missing skin weights: " + mesh.name)
    return rig, bindings, meshes


def prepare_character(scene, character, instantiate_asset, parents):
    source = character["source"]
    cache = character.get("cache")
    cache_hit = False
    if source["kind"] == "imported":
        name = "Filmie Imported Character " + cache["key"][:24] if cache else None
        collection = read_collection(cache, name) if cache else None
        if collection is not None:
            scene.collection.children.link(collection)
            root = next(obj for obj in collection.objects if obj.get("filmie_character_root"))
            cache_hit = True
        else:
            root = capture_character_names(
                lambda: instantiate_asset(source["asset"], character["transform"], character["id"],
                                          root_marker="filmie_character_root")[0],
                character["id"], capture_meshes=True)
            collection = root.users_collection[0]
            if cache:
                collection.name = name
                write_collection(cache, collection)
    else:
        name = "Filmie Humanoid " + cache["key"][:32] if cache else "Filmie Humanoid"
        collection = read_collection(cache, name) if cache else None
        if collection is not None:
            scene.collection.children.link(collection)
            cache_hit = True
        else:
            collection = generate_character(scene, character, name)
            if cache:
                write_collection(cache, collection)
        root = next(obj for obj in collection.objects if obj.get("filmie_character_root"))
    bpy.context.view_layer.update()
    rig, bindings, meshes = validate_rig(root, collection, character)
    if bindings:
        rig["filmie_joint_bindings"] = bindings
    if source["kind"] == "imported":
        for obj in collection.all_objects:
            obj.animation_data_clear()
            if obj.type == "MESH" and obj.data.shape_keys:
                obj.data.shape_keys.animation_data_clear()
        if "materialOverrides" in source:
            materials = {m["id"]: build_material(m) for m in source.get("materials", [])}
            apply_material_overrides(root, character["id"], source["materialOverrides"], materials)
    else:
        root.animation_data_clear()
        rig.animation_data_clear()
    deformation = character.get("deformation", {})
    for mesh in meshes:
        if "skinning" in deformation:
            for modifier in mesh.modifiers:
                if modifier.type == "ARMATURE" and modifier.object == rig:
                    modifier.use_deform_preserve_volume = deformation["skinning"] == "preserve-volume"
        if deformation.get("subdivision", 0):
            modifier = mesh.modifiers.new("Filmie surface subdivision", "SUBSURF")
            modifier.levels = modifier.render_levels = deformation["subdivision"]
    if "parentId" in character:
        root.parent = parents[character["parentId"]]
        root.matrix_parent_inverse.identity()
    apply_root(root, character["transform"])
    root.name = character["id"]
    root["filmie_entity_id"] = character["id"]
    rig["filmie_character_id"] = character["id"]
    rig["filmie_rig_profile"] = character["rig"]["profile"]
    rig["filmie_rig_version"] = character["rig"]["version"]
    for bone in rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    return root, rig, cache_hit


def interpolate(owner, paths, keys, action_fcurves):
    modes = {key["frame"] + 1: key["interpolation"] for key in keys}
    for curve in action_fcurves(owner.animation_data.action):
        if curve.data_path not in paths:
            continue
        for point in curve.keyframe_points:
            mode = modes[round(point.co.x)]
            point.interpolation = {"linear": "LINEAR", "hold": "CONSTANT", "ease": "BEZIER"}[mode]
            if mode == "ease":
                point.handle_left_type = point.handle_right_type = "AUTO_CLAMPED"
        curve.update()


def bind_rotation(rig, joint, value):
    binding = rig.get("filmie_joint_bindings", {}).get(joint)
    if not binding:
        return rig.pose.bones[joint], value
    basis = Quaternion(binding["basis"])
    return rig.pose.bones[binding["bone"]], basis @ Quaternion(value) @ basis.inverted()


def apply_morphs(character, root, action_fcurves):
    meshes = [obj for obj in [root, *root.children_recursive] if obj.type == "MESH"]
    used = set()
    for track in character.get("morphs", []):
        matches = [obj for obj in meshes if obj.get("filmie_source_object", obj.name) == track["mesh"]]
        if len(matches) != 1:
            raise ValueError("Morph mesh must resolve uniquely: " + track["mesh"])
        data = matches[0].data.shape_keys
        target = data.key_blocks.get(track["target"]) if data else None
        if not target or target == data.reference_key or not data.use_relative:
            raise ValueError("Unknown or incompatible relative morph target: " + track["mesh"] + "/" + track["target"])
        key = (data, target.name)
        if key in used:
            raise ValueError("Morph tracks conflict on shared mesh data: " + track["target"])
        used.add(key)
        keys = track["keys"]
        if keys[0]["frame"] > 0:
            keys = [{"frame": 0, "interpolation": "hold", "value": target.value}, *keys]
        for key in keys:
            target.value = key["value"]
            target.keyframe_insert(data_path="value", frame=key["frame"] + 1)
        interpolate(data, (target.path_from_id("value"),), keys, action_fcurves)


def apply_poses(character, root, rig, action_fcurves):
    apply_morphs(character, root, action_fcurves)
    if "sampledMotion" in character:
        apply_sampled_motion(character["sampledMotion"], root, rig, action_fcurves)
        return
    root_keys = character["poses"]["root"]
    if root_keys:
        channels = ("location", "rotation_euler", "scale")
        for key in root_keys:
            apply_root(root, key["transform"])
            for channel in channels:
                root.keyframe_insert(data_path=channel, frame=key["frame"] + 1)
        interpolate(root, channels, root_keys, action_fcurves)
    for track in character["poses"]["joints"]:
        mapped = track["joint"] in rig.get("filmie_joint_bindings", {})
        path = "rotation_quaternion" if mapped else "rotation_euler"
        for key in track["keys"]:
            euler = Euler(tuple(math.radians(value) for value in key["rotationDegrees"]), "XYZ")
            bone, value = bind_rotation(rig, track["joint"], euler.to_quaternion())
            bone.rotation_mode = "QUATERNION" if mapped else "XYZ"
            setattr(bone, path, value if mapped else euler)
            bone.keyframe_insert(data_path=path, frame=key["frame"] + 1)
        interpolate(rig, (bone.path_from_id(path),), track["keys"], action_fcurves)


def apply_sampled_motion(motion, root, rig, action_fcurves):
    def key_channel(owner, channel, values):
        for frame, value in enumerate(values, start=1):
            setattr(owner, channel, value)
            owner.keyframe_insert(data_path=channel, frame=frame)

    if "rootPosition" in motion:
        key_channel(root, "location", motion["rootPosition"])
    if "rootRotation" in motion:
        root.rotation_mode = "QUATERNION"
        key_channel(root, "rotation_quaternion", motion["rootRotation"])
    if "rootScale" in motion:
        key_channel(root, "scale", ((value,) * 3 for value in motion["rootScale"]))
    for track in motion["joints"]:
        bone, _ = bind_rotation(rig, track["joint"], (1, 0, 0, 0))
        bone.rotation_mode = "QUATERNION"
        key_channel(bone, "rotation_quaternion", (bind_rotation(rig, track["joint"], q)[1] for q in track["rotations"]))

    for owner in (root, rig):
        if owner.animation_data and owner.animation_data.action:
            for curve in action_fcurves(owner.animation_data.action):
                for key in curve.keyframe_points:
                    key.interpolation = "LINEAR"
