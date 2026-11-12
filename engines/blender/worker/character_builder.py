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
    def __init__(self, sides=20):
        self.sides = sides
        self.vertices = []
        self.weights = []
        self.faces = []
        self.materials = []

    def rings(self, sections, material, section_materials=None):
        sides = self.sides
        start = len(self.vertices)
        for center, tangent, radius_x, radius_y, weights in sections:
            tangent = tangent.normalized()
            across = tangent.cross(Vector((0, 1, 0)))
            if across.length < 1e-6:
                across = tangent.cross(Vector((1, 0, 0)))
            across.normalize()
            depth = tangent.cross(across)
            for side in range(sides):
                angle = math.tau * side / sides
                vertex = center + across * (radius_x * math.cos(angle)) + depth * (radius_y * math.sin(angle))
                self.vertices.append(tuple(vertex))
                self.weights.append(weights)
        end = len(self.vertices) - sides
        faces = [tuple(reversed(range(start, start + sides)))]
        face_materials = [section_materials[0] if section_materials else material]
        for index, ring in enumerate(range(start, end, sides)):
            for side in range(sides):
                next_side = (side + 1) % sides
                faces.append((ring + side, ring + next_side, ring + next_side + sides, ring + side + sides))
                face_materials.append(section_materials[index + 1] if section_materials else material)
        faces.append(tuple(range(end, end + sides)))
        face_materials.append(section_materials[-1] if section_materials else material)
        self.faces.extend(faces)
        self.materials.extend(face_materials)

    def tube(self, names, bones, radii, material, materials=None):
        sections = []
        section_materials = []
        for index, name in enumerate(names):
            head, tail = (Vector(bones[name][key]) for key in ("head", "tail"))
            direction = tail - head
            if index == 0:
                sections.append((head, direction, *radii[index], {name: 1.0}))
                section_materials.append(materials[index] if materials else material)
            for fraction in (0.15, 0.34, 0.58, 0.82, 1):
                weights = {name: 1.0}
                neighbor = None
                proximity = 0.0
                if index > 0 and fraction < 0.34:
                    neighbor = names[index - 1]
                    proximity = 1 - fraction / 0.34
                elif index + 1 < len(names) and fraction > 0.66:
                    neighbor = names[index + 1]
                    proximity = (fraction - 0.66) / 0.34
                if neighbor is not None:
                    weight = 0.5 * proximity**2 * (3 - 2 * proximity)
                    weights = {name: 1 - weight, neighbor: weight}
                fullness = 1 + 0.08 * math.sin(math.pi * fraction)
                radius = tuple(fullness * (a + fraction * (b - a)) for a, b in zip(radii[index], radii[index + 1]))
                tangent = direction
                if fraction == 1 and index + 1 < len(names):
                    following = bones[names[index + 1]]
                    tangent = direction.normalized() + (Vector(following["tail"]) - Vector(following["head"])).normalized()
                sections.append((head.lerp(tail, fraction), tangent, *radius, weights))
                section_materials.append(materials[index] if materials else material)
        self.rings(sections, material, section_materials)

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
    mesh = SkinMesh(character["source"].get("radialSegments", 20))
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
        mesh.tube((upper, forearm, hand), bones, [
            radius(0.046, 0.049), radius(0.033, 0.033),
            radius(0.022, 0.023), radius(0.012, 0.016),
        ], "top", ("top", "top", "skin"))
        mesh.tube((thigh, shin), bones, [radius(0.064, 0.069), radius(0.047, 0.048), radius(0.029, 0.031)], "trousers")
        ankle = bones[foot]["head"]
        mesh.oval((ankle[0], -height * 0.043, height * 0.034), (height * 0.037, height * 0.074, height * 0.034), foot, "shoes")
    mesh.create(collection, rig, appearance)
    return collection
