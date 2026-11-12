"""Build reusable local-space meshes from Filmie's parametric geometry."""
import math

import bmesh
import bpy
from mathutils import Vector


def polygon_ccw(profile):
    area = sum(x * profile[(i + 1) % len(profile)][1] -
               y * profile[(i + 1) % len(profile)][0]
               for i, (x, y) in enumerate(profile))
    return profile if area > 0 else list(reversed(profile))


def connect_rings(rings):
    count = len(rings[0])
    last = (len(rings) - 1) * count
    faces = [tuple(reversed(range(count))), tuple(last + i for i in range(count))]
    for base in range(0, last, count):
        for i in range(count):
            following = (i + 1) % count
            faces.append((base+i, base+following, base+following+count, base+i+count))
    return [point for ring in rings for point in ring], faces


def path_points(path):
    if path["kind"] == "polyline":
        return [Vector(point) for point in path["points"]]
    points = [Vector(path["start"])]
    steps = path["stepsPerSegment"]
    for segment in path["segments"]:
        a, b, c, d = points[-1], Vector(segment["control1"]), Vector(segment["control2"]), Vector(segment["end"])
        for step in range(1, steps + 1):
            t = step / steps
            u = 1 - t
            points.append(a*u**3 + b*(3*u*u*t) + c*(3*u*t*t) + d*t**3)
    return points


def sweep(shape):
    points = path_points(shape["path"])
    directions = []
    for a, b in zip(points, points[1:]):
        delta = b - a
        if delta.length < 1e-6:
            raise ValueError("Sweep path contains a zero-length sampled segment")
        directions.append(delta.normalized())
    tangents = [directions[0]]
    for a, b in zip(directions, directions[1:]):
        if a.dot(b) < -0.9999:
            raise ValueError("Sweep path reverses direction at a cusp")
        tangents.append((a + b).normalized())
    tangents.append(directions[-1])
    tangent = tangents[0]
    axes = [Vector((0, 0, 1)), Vector((0, 1, 0)), Vector((1, 0, 0))]
    up = Vector(shape["up"]).normalized() if "up" in shape else min(axes, key=lambda axis: abs(axis.dot(tangent)))
    normal = up - tangent * up.dot(tangent)
    if normal.length < 1e-6:
        raise ValueError("Sweep up vector is parallel to its first segment")
    normal.normalize()
    if shape["kind"] == "curve":
        count = shape["sides"]
        profile = [(shape["radius"] * math.cos(math.tau*i/count), shape["radius"] * math.sin(math.tau*i/count))
                   for i in range(count)]
    else:
        profile = polygon_ccw(shape["profile"])
    rings = []
    for point, direction in zip(points, tangents):
        normal = tangent.rotation_difference(direction) @ normal
        binormal = direction.cross(normal)
        rings.append([point + x*normal + y*binormal for x, y in profile])
        tangent = direction
    return connect_rings(rings)


def build_mesh(definition, material):
    shape = definition["shape"]
    kind = shape["kind"]
    mesh = bpy.data.meshes.new("Filmie Mesh | " + definition["id"])
    if kind in {"box", "sphere", "cylinder", "cone"}:
        model = bmesh.new()
        try:
            if kind == "box":
                bmesh.ops.create_cube(model, size=1)
                for vertex in model.verts:
                    for i, dimension in enumerate(shape["dimensions"]):
                        vertex.co[i] *= dimension
            elif kind == "sphere":
                bmesh.ops.create_uvsphere(model, u_segments=shape["segments"],
                                         v_segments=shape["rings"], radius=shape["radius"])
                for face in model.faces:
                    face.smooth = True
            else:
                bmesh.ops.create_cone(model, cap_ends=True, cap_tris=False,
                                     segments=shape["segments"], radius1=shape["radius"],
                                     radius2=shape["radius"] if kind == "cylinder" else 0,
                                     depth=shape["height"])
            model.to_mesh(mesh)
        finally:
            model.free()
    else:
        if kind == "extrusion":
            profile = polygon_ccw(shape["polygon"])
            vertices, faces = connect_rings([[(x, y, z) for x, y in profile] for z in (0, shape["depth"])])
        elif kind == "indexed":
            vertices, faces = shape["vertices"], shape["triangles"]
        else:
            vertices, faces = sweep(shape)
        mesh.from_pydata(vertices, [], faces)
    if mesh.validate():
        raise ValueError("Invalid mesh topology in " + definition["id"])
    mesh.update()
    mesh.materials.append(material)
    mesh["filmie_mesh_id"] = definition["id"]
    return mesh
