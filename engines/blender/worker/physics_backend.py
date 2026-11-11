"""Translate Filmie's primitive body contract to Bullet, then sample world poses."""

import bpy
from mathutils import Quaternion, Vector
from world_builder import box_mesh


def _pose(data):
    return Vector(data["position"]), Quaternion(data["rotation"]).normalized()


def _compose(a, b):
    position, rotation = a
    return position + rotation @ b[0], rotation @ b[1]


def _inverse(pose):
    position, rotation = pose
    inverse = rotation.conjugated()
    return inverse @ -position, inverse


def _dimensions(shape):
    kind = shape["kind"]
    if kind == "box":
        return shape["dimensions"]
    diameter = 2 * shape["radius"]
    height = {
        "sphere": lambda: diameter,
        "cylinder": lambda: shape["height"],
        "capsule": lambda: diameter + shape["segmentLength"],
    }[kind]()
    return (diameter, diameter, height)


def _proxy(scene, collider, properties):
    dimensions = _dimensions(collider["shape"])
    mesh = box_mesh(dimensions, None)
    obj = bpy.data.objects.new("Collision proxy", mesh)
    scene.collection.objects.link(obj)
    obj.hide_render = True
    obj.rotation_mode = "QUATERNION"
    bpy.context.view_layer.objects.active = obj
    bpy.ops.rigidbody.object_add()
    body = obj.rigid_body
    body.type = "PASSIVE" if properties["mode"] == "static" else "ACTIVE"
    body.collision_shape = collider["shape"]["kind"].upper()
    body.mass = properties["massKg"]
    body.friction = properties["friction"]
    body.restitution = properties["restitution"]
    body.linear_damping = properties["linearDamping"]
    body.angular_damping = properties["angularDamping"]
    body.use_margin = True
    body.collision_margin = min(0.001, min(dimensions) * 0.025)
    return obj


def _animation_poses(body, initial, frames, track):
    if track is not None:
        yield from map(_pose, track)
        return
    keys = [(key["frame"], _pose(key["pose"])) for key in body["keyframes"]]
    if not keys or keys[0][0] != 0:
        keys.insert(0, (0, initial))
    index = 0
    for frame in range(frames):
        while index + 1 < len(keys) and keys[index + 1][0] <= frame:
            index += 1
        start, pose = keys[index]
        if index + 1 == len(keys):
            yield pose
        else:
            end, target = keys[index + 1]
            t = (frame - start) / (end - start)
            yield pose[0].lerp(target[0], t), pose[1].slerp(target[1], t)


def bake_physics(scene, simulation, object_motion, frames):
    """Return one world-space root pose per frame per moving entity."""
    if simulation["version"] != 1:
        raise ValueError("Unsupported physics simulation version")
    moving = [body for body in simulation["bodies"] if body["properties"]["mode"] != "static"]
    if not moving:
        return {}
    scene.frame_set(1)
    bpy.ops.rigidbody.world_add()
    world = scene.rigidbody_world
    scene.use_gravity = True
    scene.gravity = simulation["settings"]["gravity"]
    world.substeps_per_frame = simulation["settings"]["substeps"]
    world.solver_iterations = simulation["settings"]["solverIterations"]
    world.point_cache.frame_start = 1
    world.point_cache.frame_end = frames
    tracks = {track["objectId"]: track["poses"] for track in object_motion}
    proxies = []
    active = {}
    baked = {}
    try:
        for body in simulation["bodies"]:
            entity = body["entityId"]
            initial = _pose(body["initialPose"])
            properties = body["properties"]
            for collider in body["colliders"]:
                offset = _pose(collider["pose"])
                proxy = _proxy(scene, collider, properties)
                proxies.append(proxy)
                proxy.location, proxy.rotation_quaternion = _compose(initial, offset)
                if properties["mode"] == "static":
                    continue
                active[entity] = (proxy, _inverse(offset))
                baked[entity] = []
                modes = {change["frame"]: change["mode"] for change in body["transitions"]}
                mode = properties["mode"]
                previous_rotation = None
                for frame, pose in enumerate(_animation_poses(body, initial, frames, tracks.get(entity))):
                    mode = modes.get(frame, mode)
                    proxy.rigid_body.kinematic = mode == "kinematic"
                    proxy.location, rotation = _compose(pose, offset)
                    if previous_rotation is not None:
                        rotation.make_compatible(previous_rotation)
                    previous_rotation = rotation
                    proxy.rotation_quaternion = rotation
                    proxy.keyframe_insert(data_path="rigid_body.kinematic", frame=frame + 1)
                    proxy.keyframe_insert(data_path="location", frame=frame + 1)
                    proxy.keyframe_insert(data_path="rotation_quaternion", frame=frame + 1)
        # Bullet must see the entire timeline in order, even for a partial render.
        for frame in range(1, frames + 1):
            scene.frame_set(frame)
            depsgraph = bpy.context.evaluated_depsgraph_get()
            for entity, (proxy, inverse_offset) in active.items():
                matrix = proxy.evaluated_get(depsgraph).matrix_world
                position, rotation = _compose(
                    (matrix.translation, matrix.to_quaternion()), inverse_offset
                )
                baked[entity].append((position, rotation))
        return baked
    finally:
        bpy.ops.rigidbody.world_remove()
        for proxy in proxies:
            mesh = proxy.data
            bpy.data.objects.remove(proxy, do_unlink=True)
            bpy.data.meshes.remove(mesh)
        scene.frame_set(1)


def apply_physics_bake(scene, baked, action_fcurves):
    roots = {obj.get("filmie_entity_id"): obj for obj in scene.objects}
    for entity, poses in baked.items():
        root = roots[entity]
        root.rotation_mode = "QUATERNION"
        previous = None
        for frame, (position, rotation) in enumerate(poses, start=1):
            if previous is not None:
                rotation.make_compatible(previous)
            previous = rotation
            root.location = position
            root.rotation_quaternion = rotation
            root.keyframe_insert(data_path="location", frame=frame)
            root.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        for curve in action_fcurves(root.animation_data.action):
            for key in curve.keyframe_points:
                key.interpolation = "LINEAR"
    scene.frame_set(1)
