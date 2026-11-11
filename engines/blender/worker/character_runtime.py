"""Resolve character assets, check their rig contract, and apply authored poses."""
import math

import bpy
from mathutils import Matrix, Vector

from character_builder import generate_character
from collection_cache import read_collection, write_collection


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
    identity = Matrix.Identity(4)
    if rig.parent != root or any(abs(a - b) > 1e-5 for row, expected in zip(rig.matrix_local, identity) for a, b in zip(row, expected)):
        raise ValueError("Character armature must have an identity transform relative to its root")
    for expected in character["bones"]:
        joint = rig.data.bones.get(expected["id"])
        head, tail = Vector(expected["head"]), Vector(expected["tail"])
        if joint is None or (joint.parent.name if joint.parent else None) != expected.get("parent"):
            raise ValueError("Missing or incompatible joint hierarchy: " + expected["id"])
        rest = bpy.types.Bone.MatrixFromAxisRoll((tail - head).normalized(), 0)
        rotation = joint.matrix_local.to_3x3()
        if (joint.head_local - head).length > 1e-4 or (joint.tail_local - tail).length > 1e-4 or any(
            abs(a - b) > 1e-4 for row, expected_row in zip(rotation, rest) for a, b in zip(row, expected_row)
        ):
            raise ValueError("Incompatible joint rest pose: " + joint.name)
        if rig.pose.bones[joint.name].constraints:
            raise ValueError("FilmieHumanoid pose joints must be free of imported constraints: " + joint.name)
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
    return rig


def prepare_character(scene, character, instantiate_asset, parents):
    source = character["source"]
    cache = character.get("cache")
    cache_hit = False
    if source["kind"] == "imported":
        root, _ = instantiate_asset(source["asset"], character["transform"], character["id"],
                                    root_marker="filmie_character_root")
        collection = root.users_collection[0]
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
    rig = validate_rig(root, collection, character)
    root.animation_data_clear()
    rig.animation_data_clear()
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


def apply_poses(character, root, rig, action_fcurves):
    root_keys = character["poses"]["root"]
    if root_keys:
        channels = ("location", "rotation_euler", "scale")
        for key in root_keys:
            apply_root(root, key["transform"])
            for channel in channels:
                root.keyframe_insert(data_path=channel, frame=key["frame"] + 1)
        interpolate(root, channels, root_keys, action_fcurves)
    for track in character["poses"]["joints"]:
        bone = rig.pose.bones[track["joint"]]
        bone.rotation_mode = "XYZ"
        for key in track["keys"]:
            bone.rotation_euler = tuple(math.radians(value) for value in key["rotationDegrees"])
            bone.keyframe_insert(data_path="rotation_euler", frame=key["frame"] + 1)
        interpolate(rig, (bone.path_from_id("rotation_euler"),), track["keys"], action_fcurves)
