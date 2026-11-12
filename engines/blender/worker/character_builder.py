"""Construct and skin a neutral procedural humanoid from a compiled rig."""
import math

import bpy
from mathutils import Vector

from visual_runtime import build_material

SIDES = ("L", "R")


def create_armature(collection, bones):
    armature = bpy.data.armatures.new("FilmieHumanoid")
    rig = bpy.data.objects.new("Humanoid rig", armature)
    collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    for spec in bones:
        bone = armature.edit_bones.new(spec["id"])
        bone.head, bone.tail = spec["head"], spec["tail"]
        bone.roll = 0
        if "parent" in spec:
            bone.parent = armature.edit_bones[spec["parent"]]
    bpy.ops.object.mode_set(mode="OBJECT")
    return rig


class SkinMesh:
    def __init__(self):
        self.vertices = []
        self.weights = []
        self.faces = []
        self.materials = []

    def rings(self, sections, material):
        sides = 12
        start = len(self.vertices)
        for center, tangent, radius_x, radius_y, weights in sections:
            tangent = tangent.normalized()
            across = tangent.cross(Vector((0, 1, 0))).normalized()
            depth = tangent.cross(across)
            for side in range(sides):
                angle = math.tau * side / sides
                vertex = center + across * (radius_x * math.cos(angle)) + depth * (radius_y * math.sin(angle))
                self.vertices.append(tuple(vertex))
                self.weights.append(weights)
        end = len(self.vertices) - sides
        faces = [tuple(reversed(range(start, start + sides)))]
        for ring in range(start, end, sides):
            for side in range(sides):
                next_side = (side + 1) % sides
                faces.append((ring + side, ring + next_side, ring + next_side + sides, ring + side + sides))
        faces.append(tuple(range(end, end + sides)))
        self.faces.extend(faces)
        self.materials.extend([material] * len(faces))

    def tube(self, names, bones, radii, material):
        sections = []
        for index, name in enumerate(names):
            head, tail = (Vector(bones[name][key]) for key in ("head", "tail"))
            direction = tail - head
            if index == 0:
                sections.append((head, direction, *radii[index], {name: 1.0}))
            for fraction, weights in (
                (0.25, {name: 1.0}), (0.75, {name: 1.0}),
                (1, {name: 0.5, names[index + 1]: 0.5} if index + 1 < len(names) else {name: 1.0}),
            ):
                radius = tuple(a + fraction * (b - a) for a, b in zip(radii[index], radii[index + 1]))
                tangent = direction
                if fraction == 1 and index + 1 < len(names):
                    following = bones[names[index + 1]]
                    tangent = direction.normalized() + (Vector(following["tail"]) - Vector(following["head"])).normalized()
                sections.append((head.lerp(tail, fraction), tangent, *radius, weights))
        self.rings(sections, material)

    def oval(self, center, radii, joint, material):
        sections = []
        for index in range(9):
            angle = math.pi * index / 8
            width = max(0.02, math.sin(angle))
            sections.append((
                Vector((center[0], center[1], center[2] - radii[2] * math.cos(angle))),
                Vector((0, 0, 1)), radii[0] * width, radii[1] * width, {joint: 1.0},
            ))
        self.rings(sections, material)

    def create(self, collection, rig, appearance):
        mesh = bpy.data.meshes.new("Humanoid skin")
        mesh.from_pydata(self.vertices, [], self.faces)
        for material, spec in appearance.items():
            mesh.materials.append(build_material({**spec, "id": "Humanoid " + material}))
        material_indices = {name: index for index, name in enumerate(appearance)}
        for polygon, material in zip(mesh.polygons, self.materials):
            polygon.material_index = material_indices[material]
            polygon.use_smooth = len(polygon.vertices) == 4
        mesh.update()
        obj = bpy.data.objects.new("Humanoid skin", mesh)
        collection.objects.link(obj)
        obj.parent = rig
        groups = {bone.name: obj.vertex_groups.new(name=bone.name) for bone in rig.data.bones}
        for index, weights in enumerate(self.weights):
            for joint, weight in weights.items():
                groups[joint].add([index], weight, "REPLACE")
        modifier = obj.modifiers.new("Humanoid deformation", "ARMATURE")
        modifier.object = rig
        modifier.use_deform_preserve_volume = True
        return obj


def generate_character(scene, character, name):
    collection = bpy.data.collections.new(name)
    scene.collection.children.link(collection)
    root = bpy.data.objects.new("Humanoid root", None)
    collection.objects.link(root)
    root["filmie_character_root"] = True
    rig = create_armature(collection, character["bones"])
    rig.parent = root
    body = character["source"]["body"]
    height = body["height"]
    build = body["build"]
    bones = {bone["id"]: bone for bone in character["bones"]}
    mesh = SkinMesh()
    def radius(width, depth):
        return (width * height * build, depth * height * build)
    mesh.tube(("pelvis", "spine", "chest"), bones, [
        radius(body["hipWidth"] * 0.67, 0.073), radius(body["hipWidth"] * 0.59, 0.071),
        radius(body["shoulderWidth"] * 0.53, 0.083), radius(body["shoulderWidth"] * 0.48, 0.065),
    ], "top")
    mesh.tube(("neck",), bones, [radius(0.038, 0.039), radius(0.036, 0.038)], "skin")
    pelvis_width, pelvis_depth = radius(body["hipWidth"] * 0.74, 0.072)
    mesh.oval((0, 0, height * (body["legLength"] - 0.012)),
              (pelvis_width, pelvis_depth, height * 0.057), "pelvis", "trousers")
    mesh.oval((0, 0, height * 0.926), (height * 0.061, height * 0.054, height * 0.074), "head", "skin")
    mesh.oval((0, -height * 0.053, height * 0.924), (height * 0.013, height * 0.013, height * 0.02), "head", "skin")
    appearance = dict(character["source"]["appearance"])
    appearance["eyes"] = {"color": (0.055, 0.037, 0.031), "roughness": 0.58, "metallic": 0.0}
    for side in (-1, 1):
        mesh.oval(
            (side * height * 0.024, -height * 0.049, height * 0.941),
            (height * 0.01, height * 0.006, height * 0.0045),
            "head", "eyes",
        )
    if "hair" in appearance:
        mesh.oval((0, height * 0.004, height * 0.965), (height * 0.063, height * 0.054, height * 0.035), "head", "hair")
    for side in SIDES:
        upper, forearm, hand = ("upper_arm." + side, "forearm." + side, "hand." + side)
        thigh, shin, foot = ("thigh." + side, "shin." + side, "foot." + side)
        mesh.tube((upper, forearm), bones, [radius(0.046, 0.049), radius(0.033, 0.033), radius(0.022, 0.023)], "top")
        mesh.tube((hand,), bones, [radius(0.021, 0.023), radius(0.012, 0.016)], "skin")
        mesh.tube((thigh, shin), bones, [radius(0.064, 0.069), radius(0.047, 0.048), radius(0.029, 0.031)], "trousers")
        ankle = bones[foot]["head"]
        mesh.oval((ankle[0], -height * 0.043, height * 0.034), (height * 0.037, height * 0.074, height * 0.034), foot, "shoes")
    mesh.create(collection, rig, appearance)
    return collection
