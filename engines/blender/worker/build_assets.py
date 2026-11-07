"""Deterministic, local Blender asset authoring worker."""

import hashlib
import json
import math
import os
import random
import sys
import traceback

import bpy
from mathutils import Vector


def read_spec():
    try:
        separator = sys.argv.index("--")
        path = sys.argv[separator + 1]
    except (ValueError, IndexError) as exc:
        raise RuntimeError("Expected -- <asset-build-spec.json>") from exc
    with open(path, "r", encoding="utf-8") as stream:
        return json.load(stream)


def make_material(name, value, style):
    material = bpy.data.materials.new(name)
    material.diffuse_color = (*value, 1.0)
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    shader = nodes.get("Principled BSDF")
    if shader is None:
        shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Base Color"].default_value = (*value, 1.0)
    shader.inputs["Roughness"].default_value = 0.94
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = float(style["grainScale"])
    noise.inputs["Detail"].default_value = 3.0
    noise.inputs["Roughness"].default_value = 0.82
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.22
    ramp.color_ramp.elements[0].position = 0.18
    ramp.color_ramp.elements[0].color = (*[channel * 0.72 for channel in value], 1.0)
    ramp.color_ramp.elements[1].position = 0.84
    ramp.color_ramp.elements[1].color = (*[min(1.0, channel * 1.38) for channel in value], 1.0)
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.12
    bump.inputs["Distance"].default_value = 0.018
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], shader.inputs["Base Color"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    return material


def hex_color(value, fallback):
    if not value:
        return fallback
    rgb = tuple(int(value[index:index + 2], 16) / 255.0 for index in (1, 3, 5))
    luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
    return (luminance, luminance * 0.98, luminance * 0.94)


def create_collection(spec):
    collection_name = "ASSET__" + spec["assetId"].replace(".", "_").replace("-", "_")
    collection = bpy.data.collections.new(collection_name)
    bpy.context.scene.collection.children.link(collection)
    root = bpy.data.objects.new("ASSET_ROOT", None)
    collection.objects.link(root)
    root.empty_display_type = "PLAIN_AXES"
    root["filmie_asset_id"] = spec["assetId"]
    return collection, root


def link_object(obj, collection, parent):
    for owner in list(obj.users_collection):
        owner.objects.unlink(obj)
    collection.objects.link(obj)
    if parent:
        obj.parent = parent
    return obj


def box(name, collection, parent, location, dimensions, material, bevel=0.0):
    dx, dy, dz = [value / 2.0 for value in dimensions]
    vertices = [
        (-dx, -dy, -dz), (dx, -dy, -dz), (dx, dy, -dz), (-dx, dy, -dz),
        (-dx, -dy, dz), (dx, -dy, dz), (dx, dy, dz), (-dx, dy, dz),
    ]
    faces = [
        (0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
        (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
    ]
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = location
    if bevel:
        modifier = obj.modifiers.new("Soft worn edges", "BEVEL")
        modifier.width = bevel
        modifier.segments = 1
    if parent:
        obj.parent = parent
    return obj


def ellipsoid(name, collection, parent, location, scale, material, segments=16, rings=10):
    vertices = []
    faces = []
    for ring in range(rings + 1):
        phi = math.pi * ring / rings
        for segment in range(segments):
            theta = 2.0 * math.pi * segment / segments
            vertices.append((
                scale[0] * math.sin(phi) * math.cos(theta),
                scale[1] * math.sin(phi) * math.sin(theta),
                scale[2] * math.cos(phi),
            ))
    for ring in range(rings):
        for segment in range(segments):
            a = ring * segments + segment
            b = ring * segments + (segment + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.materials.append(material)
    for polygon in mesh.polygons:
        polygon.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = location
    if parent:
        obj.parent = parent
    return obj


def cylinder(name, collection, parent, location, radius, depth, material, vertices=16):
    points = []
    faces = []
    for z in (-depth / 2.0, depth / 2.0):
        for index in range(vertices):
            angle = 2.0 * math.pi * index / vertices
            points.append((radius * math.cos(angle), radius * math.sin(angle), z))
    faces.append(tuple(range(vertices - 1, -1, -1)))
    faces.append(tuple(range(vertices, vertices * 2)))
    for index in range(vertices):
        nxt = (index + 1) % vertices
        faces.append((index, nxt, nxt + vertices, index + vertices))
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(points, [], faces)
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    collection.objects.link(obj)
    obj.location = location
    if parent:
        obj.parent = parent
    return obj


def stroke(name, collection, parent, points, material, width=0.006):
    curve = bpy.data.curves.new(name + "Curve", "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 1
    curve.bevel_depth = width
    curve.bevel_resolution = 0
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for destination, point in zip(spline.points, points):
        destination.co = (*point, 1.0)
    obj = bpy.data.objects.new(name, curve)
    collection.objects.link(obj)
    obj.data.materials.append(material)
    if parent:
        obj.parent = parent
    return obj


def controller(name, collection, parent, location, semantic_id=None):
    obj = bpy.data.objects.new(name, None)
    collection.objects.link(obj)
    obj.empty_display_type = "SPHERE"
    obj.empty_display_size = 0.05
    obj.location = location
    obj["filmie_control_id"] = name
    if semantic_id:
        obj["filmie_semantic_id"] = semantic_id
    if parent:
        obj.parent = parent
    return obj


def assign_controller(obj, control):
    world_matrix = obj.matrix_world.copy()
    # Meshes are deformed through their Armature modifiers below. Parenting the
    # same mesh to a rig Empty would compose the transform twice.
    obj.parent = None
    obj.matrix_world = world_matrix


def create_character_skeleton(collection, root, height, build):
    armature_data = bpy.data.armatures.new("FILMIE_HUMANOID_RIG")
    armature = bpy.data.objects.new("FILMIE_Humanoid", armature_data)
    collection.objects.link(armature)
    armature.parent = root
    armature["filmie_rig_type"] = "humanoid-semantic-v1"
    armature["filmie_control_contract"] = "chest,head,left-arm,right-arm,left-leg,right-leg,left-hand,right-hand,left-eye,right-eye,left-brow,right-brow,mouth"

    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bones = armature_data.edit_bones

    def bone(name, head, tail, parent=None):
        item = bones.new(name)
        item.head = head
        item.tail = tail
        if parent:
            item.parent = bones[parent]
        return item

    bone("root", (0.0, 0.0, 0.0), (0.0, 0.0, 0.06))
    bone("pelvis", (0.0, 0.0, 0.18 * height), (0.0, 0.0, 0.36 * height), "root")
    bone("spine", (0.0, 0.0, 0.36 * height), (0.0, 0.0, 0.58 * height), "pelvis")
    bone("chest", (0.0, 0.0, 0.58 * height), (0.0, 0.0, 0.78 * height), "spine")
    bone("head", (0.0, 0.0, 0.76 * height), (0.0, 0.0, 0.92 * height), "chest")
    for side_name, side in (("L", -1.0), ("R", 1.0)):
        bone("upper_arm." + side_name,
             (side * 0.28 * build, 0.0, 0.74 * height),
             (side * 0.43 * build, 0.0, 0.52 * height), "chest")
        bone("forearm." + side_name,
             (side * 0.43 * build, 0.0, 0.52 * height),
             (side * 0.43 * build, -0.08, 0.31 * height),
             "upper_arm." + side_name)
        bone("hand." + side_name,
             (side * 0.43 * build, -0.08, 0.31 * height),
             (side * 0.43 * build, -0.08, 0.25 * height),
             "forearm." + side_name)
        bone("thigh." + side_name,
             (side * 0.15 * build, 0.0, 0.18 * height),
             (side * 0.15 * build, -0.16, -0.04 * height), "pelvis")
        bone("shin." + side_name,
             (side * 0.15 * build, -0.16, -0.04 * height),
             (side * 0.15 * build, -0.48, -0.27 * height),
             "thigh." + side_name)
        bone("foot." + side_name,
             (side * 0.15 * build, -0.48, -0.27 * height),
             (side * 0.15 * build, -0.66, -0.27 * height),
             "shin." + side_name)

    bpy.ops.object.mode_set(mode="POSE")
    for side_name in ("L", "R"):
        forearm = armature.pose.bones["forearm." + side_name]
        ik_target = bpy.data.objects.new("IK_hand." + side_name + ".Target", None)
        collection.objects.link(ik_target)
        ik_target.empty_display_type = "CUBE"
        ik_target.empty_display_size = 0.04
        ik_target.parent = root
        ik_target["filmie_ik_chain"] = "hand." + side_name
        constraint = forearm.constraints.new("IK")
        constraint.name = "FILMIE Hand IK"
        constraint.target = ik_target
        constraint.subtarget = ""
        constraint.chain_count = 2
        shin = armature.pose.bones["shin." + side_name]
        foot_target = bpy.data.objects.new("IK_foot." + side_name + ".Target", None)
        collection.objects.link(foot_target)
        foot_target.empty_display_type = "CUBE"
        foot_target.empty_display_size = 0.04
        foot_target.parent = root
        foot_target.location = (0.15 * build * (-1.0 if side_name == "L" else 1.0), -0.66, -0.27 * height)
        foot_target["filmie_ik_chain"] = "foot." + side_name
        foot_constraint = shin.constraints.new("IK")
        foot_constraint.name = "FILMIE Foot IK"
        foot_constraint.target = foot_target
        foot_constraint.chain_count = 2

    # Semantic controls created below drive pose bones. This is the only
    # runtime deformation path: the visual Empty controls never transform
    # deform meshes directly.
    bone_semantics = {
        "chest": "chest",
        "head": "head",
        "left-arm": "upper_arm.L",
        "right-arm": "upper_arm.R",
        "left-leg": "thigh.L",
        "right-leg": "thigh.R",
        "left-hand": "hand.L",
        "right-hand": "hand.R",
    }
    for semantic_name, bone_name in bone_semantics.items():
        if bone_name not in armature.pose.bones:
            continue
        armature.pose.bones[bone_name]["filmie_semantic_id"] = semantic_name
    bpy.ops.object.mode_set(mode="OBJECT")
    armature.select_set(False)
    return armature


def skin_character_meshes(collection, armature):
    for obj in collection.objects:
        if obj.type != "MESH":
            continue
        lower_name = obj.name.lower()
        candidates = []
        if "torso" in lower_name or "garment" in lower_name or "neck" in lower_name:
            candidates = [("chest", 1.0), ("spine", 0.35)]
        elif "sleeve" in lower_name or "arm" in lower_name:
            side = "R" if "right" in lower_name or ".r" in lower_name else "L"
            candidates = [("upper_arm." + side, 0.55), ("forearm." + side, 0.45)]
        elif "hand" in lower_name:
            side = "R" if ".r" in lower_name or "right" in lower_name else "L"
            candidates = [("hand." + side, 0.75), ("forearm." + side, 0.25)]
        elif any(token in lower_name for token in ("face", "hair", "ear", "nose", "mouth", "brow", "eye")):
            candidates = [("head", 0.85), ("chest", 0.15)]
        elif "shin" in lower_name or "lower leg" in lower_name:
            side = "R" if ".r" in lower_name or "right" in lower_name else "L"
            candidates = [("shin." + side, 0.75), ("thigh." + side, 0.25)]
        elif "thigh" in lower_name or "seated" in lower_name:
            side = "R" if ".r" in lower_name or "right" in lower_name else "L"
            candidates = [("thigh." + side, 0.75), ("shin." + side, 0.25)]
        elif "foot" in lower_name or "sandal" in lower_name:
            side = "R" if ".r" in lower_name or "right" in lower_name else "L"
            candidates = [("foot." + side, 0.85), ("shin." + side, 0.15)]
        if not candidates:
            continue
        for bone_name, weight in candidates:
            if bone_name not in armature.data.bones:
                continue
            group = obj.vertex_groups.get(bone_name) or obj.vertex_groups.new(name=bone_name)
            group.remove(range(len(obj.data.vertices)))
        first_name, first_weight = candidates[0]
        second_name, second_weight = candidates[1] if len(candidates) > 1 else (None, 0.0)
        first_group = obj.vertex_groups.get(first_name)
        second_group = obj.vertex_groups.get(second_name) if second_name else None
        for vertex_index, vertex in enumerate(obj.data.vertices):
            world_point = obj.matrix_world @ vertex.co
            influences = []
            for bone_name, nominal_weight in candidates:
                bone = armature.data.bones.get(bone_name)
                if bone is None:
                    continue
                head = armature.matrix_world @ bone.head_local
                tail = armature.matrix_world @ bone.tail_local
                segment = tail - head
                segment_length_squared = segment.length_squared
                if segment_length_squared <= 1.0e-8:
                    distance = (world_point - head).length
                else:
                    projection = max(0.0, min(1.0, (world_point - head).dot(segment) / segment_length_squared))
                    distance = (world_point - (head + segment * projection)).length
                influences.append((bone_name, nominal_weight / max(0.03, distance)))
            influence_sum = sum(weight for _name, weight in influences)
            resolved = {
                name: weight / influence_sum if influence_sum > 0.0 else 0.0
                for name, weight in influences
            }
            primary = resolved.get(first_name, 0.0)
            if second_group is None:
                primary = 1.0
            first_group.add([vertex_index], primary, "REPLACE")
            if second_group is not None:
                secondary = resolved.get(second_name, 1.0 - primary)
                second_group.add([vertex_index], secondary, "REPLACE")
        modifier = obj.modifiers.new("FILMIE Humanoid Skin", "ARMATURE")
        modifier.object = armature


def build_character(spec, collection, root, style, seed):
    height = spec["heightMeters"]
    proportions = spec.get("bodyProportions", {})
    build = {"slender": 0.88, "average": 1.0, "stocky": 1.16}[spec["build"]] * float(proportions.get("shoulderWidth", 1.0))
    skeleton = create_character_skeleton(collection, root, height, build)
    materials = spec.get("materialOverrides", {})
    skin = make_material("Graphite | weathered skin", hex_color(materials.get("skin"), (0.31, 0.285, 0.255)), style)
    cloth = make_material("Graphite | homespun cloth", hex_color(materials.get("clothing"), (0.16, 0.15, 0.14)), style)
    shawl = make_material("Graphite | worn shawl", (0.23, 0.21, 0.185), style)
    hair = make_material("Graphite | hair", hex_color(materials.get("hair"), (0.055, 0.05, 0.045)), style)
    highlight = make_material("Paper | face marks", (0.48, 0.445, 0.39), style)
    eye = make_material("Ink | eyes", (0.018, 0.017, 0.016), style)
    chest = controller("RIG_chest", collection, root, (0.0, 0.0, 0.58 * height), "chest")
    head = controller("RIG_head", collection, chest, (0.0, 0.0, 0.18 * height), "head")
    left_arm = controller("RIG_arm.L", collection, chest, (-0.3 * build, 0.0, 0.0), "left-arm")
    right_arm = controller("RIG_arm.R", collection, chest, (0.3 * build, 0.0, 0.0), "right-arm")
    left_leg = controller("RIG_leg.L", collection, chest, (-0.15 * build, -0.16, -0.22 * height), "left-leg")
    right_leg = controller("RIG_leg.R", collection, chest, (0.15 * build, -0.16, -0.22 * height), "right-leg")
    head.scale = (1.0, 1.0, 1.0)
    head_scale = float(proportions.get("headScale", 1.0))
    head.scale = (head_scale,) * 3
    for arm in (left_arm, right_arm):
        arm.scale = (1.0, 1.0, float(proportions.get("armLength", 1.0)))
    for leg in (left_leg, right_leg):
        leg.scale = (1.0, 1.0, float(proportions.get("legLength", 1.0)))

    torso = ellipsoid("Father | kurta torso", collection, None,
                      (0.0, 0.0, 0.0), (0.31 * build, 0.22, 0.37 * height), cloth)
    assign_controller(torso, chest)
    coat_width = 0.43 if spec["clothing"] == "shawl" else 0.33
    coat = ellipsoid("Character | outer garment", collection, None,
                     (-0.06, -0.015, -0.02), (coat_width * build, 0.23, 0.31 * height), shawl)
    coat.rotation_euler[1] = -0.12
    assign_controller(coat, chest)

    head_z = 0.18 * height
    face = ellipsoid("Father | face", collection, None,
                     (0.0, -0.015, head_z), (0.19 * build, 0.17, 0.235 * height), skin)
    assign_controller(face, head)
    neck = ellipsoid("Father | neck", collection, None,
                     (0.0, 0.01, 0.25 * height), (0.105, 0.11, 0.12), skin)
    assign_controller(neck, chest)
    if spec["hair"] != "bald":
        cap_scale = (0.197 * build, 0.177, 0.13 * height)
        cap_z = head_z + 0.135 * height
        if spec["hair"] == "receding-wavy":
            cap_scale = (cap_scale[0], cap_scale[1], cap_scale[2] * 0.68)
            cap_z -= 0.025 * height
        hair_cap = ellipsoid("Father | wavy hair cap", collection, None,
                             (0.0, 0.025, cap_z), cap_scale, hair)
        assign_controller(hair_cap, head)
    for side in (-1, 1):
        ear = ellipsoid("Father | ear", collection, None,
                        (side * 0.19 * build, -0.012, head_z - 0.015), (0.045, 0.05, 0.075), skin)
        assign_controller(ear, head)
        brow_z = head_z + ({"worried": 0.027, "stern": 0.032, "neutral": 0.04}[spec["expression"]])
        brow_inner = -side * ({"worried": 0.018, "stern": -0.01, "neutral": 0.0}[spec["expression"]])
        brow = stroke("Father | expressive brow", collection, None,
                      [(side * 0.028, -0.179, brow_z + brow_inner), (side * 0.09, -0.184, brow_z - 0.018),
                       (side * 0.145, -0.16, brow_z - 0.035)], hair, 0.013)
        brow_control = controller("RIG_brow." + ("L" if side < 0 else "R"), collection, head,
                                   (0.0, 0.0, 0.0), "left-brow" if side < 0 else "right-brow")
        assign_controller(brow, brow_control)
        eye_control = controller("RIG_eye." + ("L" if side < 0 else "R"), collection, head,
                                 (side * 0.085, -0.17, head_z + 0.005),
                                 "left-eye" if side < 0 else "right-eye")
        eye_obj = ellipsoid("Father | eye", collection, None,
                            (side * 0.085, -0.17, head_z + 0.005), (0.025, 0.018, 0.016), eye, 12, 8)
        assign_controller(eye_obj, eye_control)
        wrinkle = stroke("Father | cheek graphite", collection, None,
                         [(side * 0.12, -0.153, head_z - 0.07),
                          (side * 0.15, -0.14, head_z - 0.095)], highlight, 0.004)
        assign_controller(wrinkle, head)
    nose = ellipsoid("Father | nose", collection, None,
                     (0.0, -0.195, head_z - 0.04), (0.04, 0.055, 0.075), shawl, 12, 8)
    assign_controller(nose, head)
    mouth_control = controller("RIG_mouth", collection, head,
                               (0.0, -0.17, head_z - 0.12), "mouth")
    mouth = ellipsoid("Character | mouth", collection, None,
                      (0.0, -0.18, head_z - 0.12), (0.068, 0.012, 0.014), hair, 12, 8)
    assign_controller(mouth, mouth_control)
    if spec["facialHair"] != "none":
        for side in (-1, 1):
            moustache = stroke("Father | moustache", collection, None,
                               [(0.0, -0.195, head_z - 0.085),
                                (side * 0.07, -0.194, head_z - 0.092),
                                (side * 0.12, -0.178, head_z - 0.11)], hair, 0.018)
            assign_controller(moustache, head)

    for side, arm in ((-1, left_arm), (1, right_arm)):
        sleeve = ellipsoid("Father | sleeve", collection, None,
                           (side * 0.29 * build, 0.0, -0.12), (0.13, 0.14, 0.25), cloth)
        sleeve.rotation_euler[1] = side * -0.55
        assign_controller(sleeve, arm)
        hand_control = controller("RIG_hand." + ("L" if side < 0 else "R"), collection, arm,
                                  (side * 0.43 * build, -0.08, -0.3),
                                  "left-hand" if side < 0 else "right-hand")
        hand = ellipsoid("Father | hand", collection, None,
                         (side * 0.43 * build, -0.08, -0.3), (0.075, 0.065, 0.06), skin)
        assign_controller(hand, hand_control)

    lower_tone = (0.25, 0.23, 0.20) if spec["clothing"] == "kurta-dhoti" else (0.19, 0.175, 0.155)
    trouser = make_material("Graphite | lower garment", lower_tone, style)
    for side in (-1, 1):
        leg_control = left_leg if side < 0 else right_leg
        thigh = ellipsoid("Father | seated thigh", collection, None,
                          (side * 0.15 * build, -0.16, -0.22 * height),
                          (0.16 * build, 0.28, 0.12 * height), trouser)
        assign_controller(thigh, leg_control)
        if spec["clothing"] == "kurta-dhoti":
            for fold in range(3):
                fold_x = side * (0.07 + fold * 0.045) * build
                drape = stroke("Clothing | dhoti fold", collection, None,
                               [(fold_x, -0.405, -0.18 * height),
                                (fold_x - side * 0.035, -0.41, -0.27 * height)],
                               highlight, 0.0035)
                assign_controller(drape, leg_control)
        shin = ellipsoid("Father | lower leg", collection, None,
                         (side * 0.15 * build, -0.39, -0.42 * height),
                         (0.105, 0.11, 0.18 * height), trouser)
        assign_controller(shin, leg_control)
        if spec["clothing"] == "kurta-pajama":
            shin.scale.x = 0.88
        foot = ellipsoid("Father | sandal", collection, None,
                         (side * 0.15 * build, -0.48, -0.54 * height),
                         (0.11, 0.18, 0.055), hair)
        assign_controller(foot, leg_control)

    # Age is expressed through deterministic facial graphite marks, not texture randomness.
    wrinkle_count = max(1, min(8, int(spec["ageYears"] // 12)))
    for wrinkle_index in range(wrinkle_count):
        z = head_z + 0.075 - wrinkle_index * 0.014
        wrinkle = stroke("Character | age wrinkle", collection, None,
                         [(-0.075, -0.171, z), (0.0, -0.181, z - 0.006), (0.075, -0.171, z)],
                         highlight, 0.0035)
        assign_controller(wrinkle, head)

    # A deterministic stipple of short graphite creases breaks the smooth primitive silhouette.
    rng = random.Random(seed)
    for index in range(24):
        x = rng.uniform(-0.24, 0.24) * build
        z = rng.uniform(-0.28, 0.24) * height
        y = -0.222 - rng.uniform(0.0, 0.012)
        mark = stroke("Father | charcoal hatch", collection, None,
                      [(x, y, z), (x + rng.uniform(-0.025, 0.025), y - 0.002, z + 0.035)],
                      hair if index % 3 else highlight, 0.0025)
        assign_controller(mark, chest)
    semantic_controls = {
        obj["filmie_semantic_id"]: obj.name
        for obj in collection.objects
        if obj.get("filmie_semantic_id")
    }
    skin_character_meshes(collection, skeleton)
    return {
        "collection": collection.name,
        "controls": [obj.name for obj in collection.objects if obj.get("filmie_control_id")],
        "semanticControls": semantic_controls,
    }


def build_environment(spec, collection, root, style, seed):
    width = spec["widthMeters"]
    depth = spec["depthMeters"]
    height = spec["heightMeters"]
    materials = spec.get("materialOverrides", {})
    plaster = make_material("Architecture | wall surface", hex_color(materials.get("wall"), (0.31, 0.29, 0.26)), style)
    wood = make_material("Architecture | structural timber", hex_color(materials.get("wood"), (0.12, 0.105, 0.09)), style)
    floor = make_material("Architecture | ground surface", hex_color(materials.get("ground"), (0.19, 0.17, 0.145)), style)
    ink = make_material("Room | charcoal strokes", (0.07, 0.064, 0.057), style)
    architecture_type = spec.get("architectureType", "interior-room")
    wall_height = height if architecture_type == "interior-room" else height * (0.48 if architecture_type == "courtyard" else 0.86)
    box("Room | floor", collection, root, (0.0, depth / 2.0, -0.08), (width, depth, 0.16), floor)
    box("Architecture | rear facade", collection, root, (0.0, depth, wall_height / 2.0), (width, 0.18, wall_height), plaster)
    if architecture_type in ("interior-room", "courtyard"):
        box("Architecture | left boundary", collection, root, (-width / 2.0, depth / 2.0, wall_height / 2.0), (0.18, depth, wall_height), plaster)
        box("Architecture | right boundary", collection, root, (width / 2.0, depth / 2.0, wall_height / 2.0), (0.18, depth, wall_height), plaster)
    if architecture_type == "interior-room":
        for x in (-width * 0.34, 0.0, width * 0.34):
            box("Room | ceiling beam", collection, root, (x, depth / 2.0, height - 0.12), (0.11, depth, 0.2), wood, 0.025)
    if "roof-eaves" in spec["features"]:
        box("Architecture | roof eaves", collection, root, (0.0, depth * 0.46, wall_height + 0.12), (width * 1.12, depth * 1.1, 0.22), wood, 0.035)
    if "column-porch" in spec["features"]:
        for x in (-width * 0.36, 0.0, width * 0.36):
            box("Architecture | porch pier", collection, root, (x, depth * 0.23, wall_height * 0.48), (0.18, 0.18, wall_height * 0.96), wood, 0.025)
    if "stone-course" in spec["features"]:
        for index in range(1, 5):
            z = wall_height * index / 5
            stroke("Architecture | masonry course", collection, root,
                   [(-width / 2, depth - 0.09, z), (width / 2, depth - 0.09, z)], ink, 0.009)
    if "wooden-door" in spec["features"]:
        door_x = -width * 0.3
        box("Room | door", collection, root, (door_x, depth - 0.105, height * 0.34),
            (width * 0.19, 0.045, height * 0.68), wood, 0.02)
        for index in range(4):
            x = door_x - width * 0.075 + index * width * 0.05
            box("Room | door plank", collection, root, (x, depth - 0.076, height * 0.34),
                (0.018, 0.018, height * 0.62), ink)
    if "barred-window" in spec["features"]:
        window_x = width * 0.28
        window_z = height * 0.61
        window_w = width * 0.27
        window_h = height * 0.32
        for x in (window_x - window_w / 2, window_x + window_w / 2):
            box("Room | window stile", collection, root, (x, depth - 0.09, window_z), (0.07, 0.12, window_h), wood)
        for z in (window_z - window_h / 2, window_z + window_h / 2):
            box("Room | window rail", collection, root, (window_x, depth - 0.09, z), (window_w, 0.12, 0.07), wood)
        for index in (-1, 0, 1):
            box("Room | iron window bar", collection, root,
                (window_x + index * window_w / 4, depth - 0.025, window_z), (0.025, 0.035, window_h), ink)
    if "timber-beams" in spec["features"]:
        for x in (-width * 0.44, width * 0.44):
            box("Room | wall post", collection, root, (x, depth - 0.12, height / 2.0), (0.13, 0.16, height), wood)
    rng = random.Random(seed)
    # Irregular, low-cost graphite scuffs make procedural plaster read as drawn rather than clean CG.
    for index in range(100):
        x = rng.uniform(-width * 0.46, width * 0.46)
        z = rng.uniform(0.12, height - 0.1)
        length = rng.uniform(0.025, 0.15)
        y = depth - 0.087
        stroke("Room | hand-scored plaster", collection, root,
               [(x, y, z), (x + length * 0.4, y - 0.002, z + rng.uniform(-0.025, 0.025)),
                (x + length, y, z + rng.uniform(-0.02, 0.02))], ink, rng.uniform(0.0012, 0.003))


def build_furniture(spec, collection, root, style):
    wood = make_material("Furniture | aged neem wood", (0.12, 0.105, 0.085), style)
    seat_or_top = make_material("Furniture | worn surfaces", (0.22, 0.195, 0.16), style)
    width, height, depth = spec["widthMeters"], spec["heightMeters"], spec["depthMeters"]
    furniture_type = spec["furnitureType"]
    if furniture_type == "chair":
        seat_z = height * 0.44
        box("Chair | seat", collection, root, (0, 0, seat_z), (width, depth, 0.1), seat_or_top, 0.025)
        box("Chair | back", collection, root, (0, depth * 0.43, seat_z + height * 0.23),
            (width * 0.92, 0.09, height * 0.48), wood, 0.025)
        for x in (-width * 0.42, width * 0.42):
            for y in (-depth * 0.4, depth * 0.38):
                box("Chair | leg", collection, root, (x, y, seat_z / 2), (0.075, 0.075, seat_z), wood)
            box("Chair | arm rest", collection, root, (x, 0, seat_z + 0.18), (0.07, depth * 0.72, 0.08), wood, 0.025)
    elif furniture_type == "table":
        top_z = height * 0.88
        box("Table | slab", collection, root, (0, 0, top_z), (width, depth, 0.13), seat_or_top, 0.035)
        for x in (-width * 0.42, width * 0.42):
            for y in (-depth * 0.38, depth * 0.38):
                box("Table | leg", collection, root, (x, y, top_z / 2), (0.09, 0.09, top_z), wood)
    elif furniture_type in ("stool", "bench"):
        seat_z = height * 0.82
        box("Seat | slab", collection, root, (0, 0, seat_z), (width, depth, 0.11), seat_or_top, 0.025)
        for x in (-width * 0.42, width * 0.42):
            for y in (-depth * 0.38, depth * 0.38):
                box("Seat | leg", collection, root, (x, y, seat_z / 2), (0.075, 0.075, seat_z), wood)
    elif furniture_type == "bed":
        frame_z = height * 0.34
        box("Bed | frame", collection, root, (0, 0, frame_z), (width, depth, 0.16), wood, 0.025)
        box("Bed | mattress", collection, root, (0, 0, frame_z + 0.13), (width * 0.94, depth * 0.94, 0.12), seat_or_top, 0.035)
        box("Bed | headboard", collection, root, (0, depth * 0.47, height * 0.54), (width, 0.08, height * 0.64), wood, 0.02)
        for x in (-width * 0.42, width * 0.42):
            for y in (-depth * 0.4, depth * 0.4):
                box("Bed | leg", collection, root, (x, y, frame_z / 2), (0.08, 0.08, frame_z), wood)
    else:
        box("Cabinet | body", collection, root, (0, 0, height / 2), (width, depth, height), wood, 0.025)
        for x in (-width * 0.24, width * 0.24):
            box("Cabinet | door", collection, root, (x, -depth / 2 - 0.006, height * 0.53), (width * 0.46, 0.025, height * 0.88), seat_or_top, 0.008)
            ellipsoid("Cabinet | handle", collection, root, (x + width * 0.13, -depth / 2 - 0.025, height * 0.53), (0.018, 0.018, 0.035), wood, 10, 6)


def build_prop(spec, collection, root, style):
    black = make_material("Prop | blackened metal", (0.06, 0.055, 0.05), style)
    brass = make_material("Prop | tarnished brass", (0.31, 0.27, 0.19), style)
    ceramic = make_material("Prop | bakelite", (0.11, 0.095, 0.08), style)
    scale = spec["scale"]
    if spec["propType"] == "custom":
        spec_anchors = spec.get("anchors", [])
        root["filmie_anchors"] = json.dumps({
            anchor["id"]: [anchor["position"][axis] * scale for axis in ("x", "y", "z")]
            for anchor in spec_anchors
        }, sort_keys=True)
        for component in sorted(spec["geometry"], key=lambda item: item["id"]):
            position = tuple(float(component["position"][axis]) * scale for axis in ("x", "y", "z"))
            rotation = component["rotationDegrees"]
            material = make_material(
                "Custom prop | " + component["id"],
                hex_color(component["materialTone"], (0.2, 0.19, 0.17)), style,
            )
            if component["type"] == "box":
                obj = box("Custom prop | " + component["id"], collection, root, position,
                          tuple(float(value) * scale for value in component["dimensions"]),
                          material, float(component.get("bevel", 0.0)) * scale)
            elif component["type"] == "ellipsoid":
                obj = ellipsoid("Custom prop | " + component["id"], collection, root, position,
                                tuple(float(value) * scale for value in component["radii"]), material)
            elif component["type"] == "cylinder":
                obj = cylinder("Custom prop | " + component["id"], collection, root, position,
                               float(component["radius"]) * scale, float(component["depth"]) * scale,
                               material, int(component.get("vertices", 16)))
            else:
                points = [tuple(float(value) * scale for value in point) for point in component["points"]]
                obj = stroke("Custom prop | " + component["id"], collection, root, points,
                             material, float(component["width"]) * scale)
            obj.rotation_euler = tuple(math.radians(float(rotation[axis])) for axis in ("x", "y", "z"))
        return
    if spec["propType"] == "rotary-telephone":
        root["filmie_anchors"] = json.dumps({
            "receiver": [0.0, 0.12 * scale, 0.28 * scale],
            "base": [0.0, 0.0, 0.09 * scale],
        }, sort_keys=True)
        box("Telephone | bakelite base", collection, root, (0, 0, 0.09 * scale),
            (0.34 * scale, 0.25 * scale, 0.18 * scale), ceramic, 0.035 * scale)
        dial = cylinder("Telephone | rotary dial", collection, root,
                        (0, -0.025 * scale, 0.192 * scale), 0.105 * scale, 0.018 * scale, brass, 32)
        dial.rotation_euler[0] = math.radians(24)
        for index in range(10):
            angle = 2 * math.pi * index / 10
            ellipsoid("Telephone | dial finger hole", collection, root,
                      (0.073 * scale * math.cos(angle), -0.073 * scale * math.sin(angle) - 0.035 * scale,
                       0.207 * scale), (0.012 * scale, 0.012 * scale, 0.006 * scale), black, 10, 6)
        receiver = ellipsoid("Telephone | receiver", collection, root,
                             (0, 0.12 * scale, 0.28 * scale), (0.23 * scale, 0.045 * scale, 0.045 * scale), black)
        for x in (-0.19 * scale, 0.19 * scale):
            ellipsoid("Telephone | receiver bell", collection, root,
                      (x, 0.12 * scale, 0.28 * scale), (0.055 * scale, 0.06 * scale, 0.07 * scale), black)
        stroke("Telephone | coiled cord", collection, root,
               [(0.12 * scale, 0.12 * scale, 0.23 * scale), (0.2 * scale, 0.14 * scale, 0.14 * scale),
                (0.16 * scale, 0.16 * scale, 0.08 * scale)], black, 0.008 * scale)
    else:
        root["filmie_anchors"] = json.dumps({
            "handle": [0.0, 0.0, 0.68 * scale],
            "base": [0.0, 0.0, 0.035 * scale],
        }, sort_keys=True)
        cylinder("Lantern | foot", collection, root, (0, 0, 0.035 * scale), 0.12 * scale, 0.07 * scale, black)
        cylinder("Lantern | oil tank", collection, root, (0, 0, 0.16 * scale), 0.085 * scale, 0.22 * scale, brass)
        cylinder("Lantern | glass chamber", collection, root, (0, 0, 0.39 * scale), 0.075 * scale, 0.25 * scale, ceramic)
        cylinder("Lantern | cap", collection, root, (0, 0, 0.55 * scale), 0.12 * scale, 0.06 * scale, black)
        for side in (-1, 1):
            stroke("Lantern | wire guard", collection, root,
                   [(side * 0.105 * scale, 0, 0.18 * scale), (side * 0.095 * scale, 0, 0.54 * scale),
                    (0, 0, 0.61 * scale)], brass, 0.012 * scale)
        stroke("Lantern | carrying handle", collection, root,
               [(-0.07 * scale, 0, 0.57 * scale), (-0.07 * scale, 0, 0.78 * scale),
                (0.07 * scale, 0, 0.78 * scale), (0.07 * scale, 0, 0.57 * scale)], black, 0.012 * scale)


def main():
    spec = read_spec()
    output_directory = spec["outputDirectory"]
    os.makedirs(output_directory, exist_ok=True)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)
    style = spec["style"]
    results = []
    for asset in sorted(spec["assets"], key=lambda entry: entry["assetId"]):
        seed_material = (str(spec["seed"]) + asset["assetId"] + asset["version"]).encode("utf-8")
        seed = int(hashlib.sha256(seed_material).hexdigest()[:8], 16)
        collection, root = create_collection(asset)
        if asset["kind"] == "character":
            details = build_character(asset, collection, root, style, seed)
        elif asset["kind"] == "environment":
            build_environment(asset, collection, root, style, seed)
            details = {"collection": collection.name, "controls": [], "semanticControls": {}}
        elif asset["kind"] == "furniture":
            build_furniture(asset, collection, root, style)
            details = {"collection": collection.name, "controls": [], "semanticControls": {}}
        else:
            build_prop(asset, collection, root, style)
            details = {"collection": collection.name, "controls": [], "semanticControls": {}}
        blend_path = os.path.join(output_directory, asset["assetId"], asset["version"], "asset.blend")
        os.makedirs(os.path.dirname(blend_path), exist_ok=True)
        bpy.data.libraries.write(blend_path, {collection}, fake_user=True, compress=True)
        results.append({
            "assetId": asset["assetId"],
            "version": asset["version"],
            "kind": asset["kind"],
            "displayName": asset["displayName"],
            "sourcePath": blend_path,
            "collection": details["collection"],
            "controls": details["controls"],
            "semanticControls": details["semanticControls"],
            "sha256": hashlib.sha256(open(blend_path, "rb").read()).hexdigest(),
            "bytes": os.path.getsize(blend_path),
        })
    with open(os.path.join(output_directory, "worker-result.json"), "w", encoding="utf-8") as stream:
        json.dump({"status": "success", "assets": results}, stream, sort_keys=True)


try:
    main()
except Exception as error:
    print("FILMIE_ASSET_WORKER_ERROR: " + str(error), file=sys.stderr)
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)
