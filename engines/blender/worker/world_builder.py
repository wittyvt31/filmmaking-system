"""Build validated, renderer-independent world geometry in Blender."""

import math

import bpy
from collection_cache import read_collection, write_collection
from visual_runtime import build_material


def coordinates(value):
    return tuple(float(value[axis]) for axis in ("x", "y", "z"))


def box_mesh(dimensions, material):
    x, y, z = (value / 2 for value in dimensions)
    vertices = [
        (-x, -y, -z), (x, -y, -z), (x, y, -z), (-x, y, -z),
        (-x, -y, z), (x, -y, z), (x, y, z), (-x, y, z),
    ]
    faces = [
        (3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4),
        (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
    ]
    mesh = bpy.data.meshes.new("World box")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    if material is not None:
        mesh.materials.append(material)
    return mesh


def populate_collection(scene, world, instantiate_asset, name):
    collection = bpy.data.collections.new(name)
    scene.collection.children.link(collection)
    materials = {item["id"]: build_material(item) for item in world["materials"]}
    roots = {}
    meshes = {}
    for entity in world["entities"]:
        entity_id = entity["id"]
        transform = entity["transform"]
        if "asset" in entity:
            root, _ = instantiate_asset(entity["asset"], transform, entity_id, collection)
        else:
            root = bpy.data.objects.new(entity_id, None)
            collection.objects.link(root)
            root.location = coordinates(transform["position"])
            root.rotation_euler = tuple(math.radians(value) for value in coordinates(transform["rotationDegrees"]))
            root.scale = (float(transform["scale"]),) * 3
        if "parentId" in entity:
            root.parent = roots[entity["parentId"]]
        root["filmie_entity_id"] = entity_id
        for name in ("massKg", "friction", "restitution"):
            if name in entity.get("physics", {}):
                root["filmie_physics_" + name] = entity["physics"][name]
        roots[entity_id] = root
        for box in entity.get("boxes", []):
            dimensions = coordinates(box["dimensions"])
            key = (dimensions, box["materialId"])
            if key not in meshes:
                meshes[key] = box_mesh(dimensions, materials[box["materialId"]])
            obj = bpy.data.objects.new(entity_id + "/" + box["id"], meshes[key])
            collection.objects.link(obj)
            obj.parent = root
            obj.location = coordinates(box["position"])
            obj.rotation_euler.z = math.radians(box.get("rotationDegrees", 0))
            obj["filmie_world_part"] = box["id"]
    return collection


def build_world(scene, world, instantiate_asset, cache=None):
    if world["schemaVersion"] != 1:
        raise ValueError("Unsupported compiled world version")
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene["filmie_world_sha256"] = world["sha256"]
    name = "Filmie World"
    collection = read_collection(cache, name) if cache else None
    scene["filmie_world_cache_hit"] = collection is not None
    if collection is not None:
        scene.collection.children.link(collection)
        return collection
    collection = populate_collection(scene, world, instantiate_asset, name)
    if cache:
        write_collection(cache, collection)
    return collection
