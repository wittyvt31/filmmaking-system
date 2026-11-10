"""Fixed Blender worker. It accepts JSON data and never evaluates manifest code."""

import json
import hashlib
import math
import os
import random
import sys
import traceback
import struct

import bpy
from mathutils import Euler, Matrix, Vector

RENDER_METRICS = {"constantInterpolationCurves": 0, "constantInterpolationFailures": 0}


def remove_volatile_png_metadata(path):
    """Keep encoded pixels intact; strip Blender's path/date/render-time stamps."""
    with open(path, "rb") as stream:
        source = stream.read()
    if source[:8] != b"\x89PNG\r\n\x1a\n":
        raise RuntimeError("Invalid rendered PNG signature: " + path)
    chunks = [source[:8]]
    offset = 8
    while offset < len(source):
        length = struct.unpack(">I", source[offset:offset + 4])[0]
        end = offset + length + 12
        if end > len(source):
            raise RuntimeError("Truncated rendered PNG: " + path)
        if source[offset + 4:offset + 8] not in (b"tEXt", b"zTXt", b"iTXt"):
            chunks.append(source[offset:end])
        offset = end
    temporary = path + ".metadata-partial"
    with open(temporary, "wb") as stream:
        stream.write(b"".join(chunks))
    os.replace(temporary, path)


def action_fcurves(action):
    """Return FCurves for a Blender 5.x layered action, with a legacy fallback."""
    if hasattr(action, "fcurves"):
        return list(action.fcurves)
    curves = []
    for layer in getattr(action, "layers", []):
        for strip in getattr(layer, "strips", []):
            for channel_bag in getattr(strip, "channelbags", []):
                curves.extend(getattr(channel_bag, "fcurves", []))
    return curves


def set_constant_interpolation(owner, data_path=None):
    """Set CONSTANT interpolation without relying on the removed Action.fcurves."""
    animation = getattr(owner, "animation_data", None)
    if animation is None or animation.action is None:
        RENDER_METRICS["constantInterpolationFailures"] += 1
        print("FILMIE_CONSTANT_INTERPOLATION_MISSING: no animation action for " + str(data_path))
        raise RuntimeError("Cannot apply constant interpolation: no animation curves for " + str(data_path))
    matched = 0
    for curve in action_fcurves(animation.action):
        if data_path is not None and curve.data_path != data_path:
            continue
        matched += 1
        for point in curve.keyframe_points:
            point.interpolation = "CONSTANT"
    if matched == 0:
        RENDER_METRICS["constantInterpolationFailures"] += 1
        print("FILMIE_CONSTANT_INTERPOLATION_MISSING: no matching FCurves for " + str(data_path))
        raise RuntimeError("Cannot apply constant interpolation: no matching FCurves for " + str(data_path))
    RENDER_METRICS["constantInterpolationCurves"] += matched


def read_spec():
    try:
        separator = sys.argv.index("--")
        spec_path = sys.argv[separator + 1]
    except (ValueError, IndexError) as exc:
        raise RuntimeError("Expected -- <worker-spec.json>") from exc
    with open(spec_path, "r", encoding="utf-8") as stream:
        return json.load(stream)


def color_material(image, style, name, opacity=1.0, seed=0, depth=0.0):
    material = bpy.data.materials.new(name)
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Roughness"].default_value = 1.0
    if hasattr(shader.inputs, 'get') and shader.inputs.get("Metallic") is not None:
        shader.inputs["Metallic"].default_value = float(style.get("graphiteSheen", 0.0))
        shader.inputs["Roughness"].default_value = max(0.38, 1.0 - float(style.get("graphiteSheen", 0.0)) * 0.65)
    emission = nodes.new("ShaderNodeEmission")
    illumination_mix = nodes.new("ShaderNodeMixShader")
    illumination_mix.inputs[0].default_value = float(style["lighting"]["ambientFill"])

    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.interpolation = {"low": "Closest", "medium": "Linear", "high": "Cubic"}.get(style.get("textureQuality", "high"), "Cubic")
    bw = nodes.new("ShaderNodeRGBToBW")
    ramp = nodes.new("ShaderNodeValToRGB")
    palette = ramp.color_ramp
    contrast_curve = style.get("contrastCurve", (0.0, 1.0)) if style.get("version") == "2.0.0" else (0.0, 1.0)
    palette.elements[0].position = float(contrast_curve[0])
    palette.elements[0].color = (*style["palette"]["shadow"], 1.0)
    palette.elements[1].position = float(contrast_curve[1])
    palette.elements[1].color = (*style["palette"]["paper"], 1.0)
    middle = palette.elements.new(0.48)
    middle.color = (*style["palette"]["graphite"], 1.0)

    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = float(style["grainScale"])
    noise.inputs["Detail"].default_value = 2.0
    noise.noise_dimensions = "4D"
    noise.inputs["W"].default_value = 0.0
    multiply = nodes.new("ShaderNodeMixRGB")
    multiply.blend_type = "MULTIPLY"
    multiply.inputs[0].default_value = float(style["grainStrength"])

    uv = nodes.new("ShaderNodeTexCoord")
    links.new(uv.outputs["UV"], texture.inputs["Vector"])
    mapping = nodes.new("ShaderNodeMapping")
    links.new(uv.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    rng = random.Random(int(seed))
    mapping.inputs["Location"].default_value[0] = rng.uniform(-0.025, 0.025)
    stable_offset = int(hashlib.sha256(name.encode("utf-8")).hexdigest()[:8], 16)
    boil_rng = random.Random(int(seed) ^ stable_offset)
    boil_fps = float(style.get("boilFps", 12))
    frame_rate = float(style.get("frameRate", 24.0))
    previous_index = None
    for frame in range(1, int(style.get("durationFrames", 1)) + 1):
        grain_index = math.floor(frame * boil_fps / frame_rate) if boil_fps > 0 else frame
        if grain_index == previous_index:
            continue
        value_rng = random.Random((int(seed) ^ stable_offset ^ grain_index) & 0xFFFFFFFF)
        noise.inputs["W"].default_value = value_rng.random() * 4.0 * float(style.get("lineBoilStrength", 0.12))
        material.node_tree.keyframe_insert(
            data_path='nodes["' + noise.name + '"].inputs["W"].default_value',
            frame=frame,
        )
        previous_index = grain_index
    set_constant_interpolation(
        material.node_tree,
        'nodes["' + noise.name + '"].inputs[' + str(noise.inputs.find("W")) + '].default_value',
    )
    if style.get("version") == "2.0.0":
        # Image textures are scene-linear. The artistic contrast points describe
        # perceptual tones; applying them directly crushed dark graphite detail.
        perceptual = nodes.new("ShaderNodeGamma")
        perceptual.name = "Graphite Perceptual Tone"
        perceptual.inputs["Gamma"].default_value = 1.0 / 2.2
        links.new(texture.outputs["Color"], perceptual.inputs["Color"])
        links.new(perceptual.outputs["Color"], bw.inputs["Color"])
    else:
        links.new(texture.outputs["Color"], bw.inputs["Color"])
    links.new(bw.outputs["Val"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], multiply.inputs[1])
    links.new(noise.outputs["Fac"], multiply.inputs[2])

    # A UV-centered falloff darkens the paper edges without obscuring the panel.
    subtract = nodes.new("ShaderNodeVectorMath")
    subtract.operation = "SUBTRACT"
    subtract.inputs[1].default_value = (0.5, 0.5, 0.0)
    length = nodes.new("ShaderNodeVectorMath")
    length.operation = "LENGTH"
    vignette = nodes.new("ShaderNodeMapRange")
    vignette.clamp = True
    vignette.inputs["From Min"].default_value = 0.12
    vignette.inputs["From Max"].default_value = 0.72
    vignette.inputs["To Min"].default_value = 1.0
    vignette.inputs["To Max"].default_value = 1.0 - float(style["vignetteStrength"])
    shade = nodes.new("ShaderNodeMixRGB")
    shade.blend_type = "MULTIPLY"
    shade.inputs[0].default_value = 1.0
    links.new(uv.outputs["UV"], subtract.inputs[0])
    links.new(subtract.outputs["Vector"], length.inputs[0])
    links.new(length.outputs["Value"], vignette.inputs["Value"])
    links.new(multiply.outputs["Color"], shade.inputs[1])
    links.new(vignette.outputs["Result"], shade.inputs[2])
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    alpha_scale = nodes.new("ShaderNodeMath")
    alpha_scale.operation = "MULTIPLY"
    alpha_scale.inputs[1].default_value = float(opacity)
    mix_shader = nodes.new("ShaderNodeMixShader")
    links.new(shade.outputs["Color"], shader.inputs["Base Color"])
    links.new(shade.outputs["Color"], emission.inputs["Color"])
    links.new(shader.outputs["BSDF"], illumination_mix.inputs[1])
    links.new(emission.outputs["Emission"], illumination_mix.inputs[2])
    alpha_output = alpha_scale.outputs["Value"]
    if style.get("version") == "2.0.0":
        # Perturb alpha only near its boundary. Depth increases the soft transition
        # width, while the noise threshold creates a controlled drawn edge.
        edge_noise = nodes.new("ShaderNodeTexNoise")
        edge_noise.noise_dimensions = "4D"
        edge_noise.inputs["Scale"].default_value = float(style.get("grainScale", 42.0)) * 0.22
        links.new(uv.outputs["UV"], edge_noise.inputs["Vector"])
        edge_previous_index = None
        for frame in range(1, int(style.get("durationFrames", 1)) + 1):
            edge_index = math.floor(frame * boil_fps / frame_rate) if boil_fps > 0 else frame
            if edge_index == edge_previous_index: continue
            edge_rng = random.Random((int(seed) ^ stable_offset ^ (edge_index * 0x45D9F3B)) & 0xFFFFFFFF)
            edge_noise.inputs["W"].default_value = edge_rng.random() * 4.0
            material.node_tree.keyframe_insert(data_path='nodes["' + edge_noise.name + '"].inputs["W"].default_value', frame=frame)
            edge_previous_index = edge_index
        set_constant_interpolation(material.node_tree, 'nodes["' + edge_noise.name + '"].inputs[' + str(edge_noise.inputs.find("W")) + '].default_value')
        center_noise = nodes.new("ShaderNodeMath")
        center_noise.operation = "SUBTRACT"
        center_noise.inputs[1].default_value = 0.5
        noise_amount = nodes.new("ShaderNodeMath")
        noise_amount.operation = "MULTIPLY"
        noise_amount.inputs[1].default_value = float(style.get("edgeBreakup", 0.24)) * 0.24
        eroded_alpha = nodes.new("ShaderNodeMath")
        eroded_alpha.operation = "ADD"
        edge_map = nodes.new("ShaderNodeMapRange")
        edge_map.clamp = True
        edge_map.inputs["From Min"].default_value = 0.12
        edge_map.inputs["From Max"].default_value = 0.35 + min(abs(float(depth)) * float(style.get("edgeSoftness", 0.015)), 0.12)
        edge_map.inputs["To Min"].default_value = 0.0
        edge_map.inputs["To Max"].default_value = 1.0
        links.new(texture.outputs["Alpha"], alpha_scale.inputs[0])
        links.new(edge_noise.outputs["Fac"], center_noise.inputs[0])
        links.new(center_noise.outputs["Value"], noise_amount.inputs[0])
        links.new(texture.outputs["Alpha"], eroded_alpha.inputs[0])
        links.new(noise_amount.outputs["Value"], eroded_alpha.inputs[1])
        links.new(eroded_alpha.outputs["Value"], edge_map.inputs["Value"])
        # Apply layer opacity after erosion so fades retain their intended alpha.
        links.new(edge_map.outputs["Result"], alpha_scale.inputs[0])
        alpha_output = alpha_scale.outputs["Value"]
        # A subdued texture modulation softens shadow masses into graphite smudge.
        if float(style.get("shadowSmudge", 0.0)) > 0:
            smudge_noise = nodes.new("ShaderNodeTexNoise")
            smudge_noise.inputs["Scale"].default_value = 5.0
            smudge_noise.inputs["Detail"].default_value = 3.0
            links.new(uv.outputs["UV"], smudge_noise.inputs["Vector"])
            smudge = nodes.new("ShaderNodeMixRGB")
            smudge.blend_type = "MULTIPLY"
            smudge.inputs[0].default_value = float(style.get("shadowSmudge", 0.18))
            links.new(shade.outputs["Color"], smudge.inputs[1])
            links.new(smudge_noise.outputs["Color"], smudge.inputs[2])
            links.new(smudge.outputs["Color"], shader.inputs["Base Color"])
            links.new(smudge.outputs["Color"], emission.inputs["Color"])
    else:
        links.new(texture.outputs["Alpha"], alpha_scale.inputs[0])
    links.new(alpha_output, mix_shader.inputs[0])
    links.new(transparent.outputs["BSDF"], mix_shader.inputs[1])
    links.new(illumination_mix.outputs["Shader"], mix_shader.inputs[2])
    links.new(mix_shader.outputs["Shader"], output.inputs["Surface"])
    material.surface_render_method = "BLENDED" if style.get("version") == "2.0.0" else "DITHERED"
    return material


def create_sprite_layer(layer, style):
    """Build a pivoted, alpha-aware image plane under a transform root."""
    asset = layer["asset"]
    if asset.get("metadata", {}).get("blenderCollection"):
        raise RuntimeError(
            "Artwork layers must reference a raster image asset, not a Blender collection: "
            + asset["assetId"]
        )
    image = bpy.data.images.load(asset["localPath"], check_existing=True)
    if image.size[0] <= 0 or image.size[1] <= 0:
        raise RuntimeError("Artwork image has invalid dimensions: " + asset["localPath"])
    image.pack()
    aspect = image.size[0] / image.size[1]
    size = layer.get("size") or {"width": aspect * 2.0, "height": 2.0}
    width = float(size["width"])
    height = float(size["height"])
    pivot = layer.get("pivot", {"x": 0.5, "y": 0.5})
    pivot_x = float(pivot["x"])
    pivot_y = float(pivot["y"])
    mesh = bpy.data.meshes.new("ArtworkMesh__" + layer["id"])
    mesh.from_pydata(
        [
            (-pivot_x * width, 0.0, -pivot_y * height),
            ((1.0 - pivot_x) * width, 0.0, -pivot_y * height),
            ((1.0 - pivot_x) * width, 0.0, (1.0 - pivot_y) * height),
            (-pivot_x * width, 0.0, (1.0 - pivot_y) * height),
        ],
        [],
        [(0, 1, 2, 3)],
    )
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="ArtworkUV")
    for loop, uv_coord in zip(
        uv_layer.data, ((0, 0), (1, 0), (1, 1), (0, 1))
    ):
        loop.uv = uv_coord
    sprite = bpy.data.objects.new("ARTWORK__" + layer["id"], mesh)
    bpy.context.scene.collection.objects.link(sprite)
    sprite.data.materials.append(
        color_material(image, style, "ArtworkMaterial__" + layer["id"], layer.get("opacity", 1.0), style.get("seed", 0), layer["transform"]["position"]["y"])
    )

    root = bpy.data.objects.new("LAYER__" + layer["id"], None)
    bpy.context.scene.collection.objects.link(root)
    root.empty_display_type = "PLAIN_AXES"
    root["filmie_entity_id"] = layer["id"]
    root["filmie_asset_id"] = asset["assetId"]
    root["filmie_asset_version"] = asset["version"]
    root["filmie_order"] = int(layer.get("order", 0))
    position = layer["transform"]["position"]
    rotation = layer["transform"]["rotationDegrees"]
    root.location = (
        float(position["x"]),
        float(position["y"]) - int(layer.get("order", 0)) * 0.001,
        float(position["z"]),
    )
    root.rotation_euler = tuple(
        math.radians(float(rotation[axis])) for axis in ("x", "y", "z")
    )
    root.scale = (float(layer["transform"]["scale"]),) * 3
    sprite.parent = root
    sprite.location = (0.0, 0.0, 0.0)
    sprite.rotation_euler = (0.0, 0.0, 0.0)
    sprite.scale = (1.0, 1.0, 1.0)
    sprite["filmie_layer_id"] = layer["id"]
    sprite["filmie_pivot_normalized"] = (pivot_x, pivot_y)
    return root, sprite


def add_contact_shadow(root, layer):
    """Add a soft, deterministic ellipse beneath a cutout character or prop."""
    size = layer.get("size") or {"width": 1.0, "height": 2.0}
    pivot = layer.get("pivot", {"x": 0.5, "y": 0.5})
    width = max(0.12, float(size["width"]) * 0.38)
    height = max(0.045, float(size["height"]) * 0.055)
    bottom = -float(pivot.get("y", 0.5)) * float(size["height"])
    mesh = bpy.data.meshes.new("ContactShadowMesh__" + layer["id"])
    mesh.from_pydata([(-width, 0, -height), (width, 0, -height), (width, 0, height), (-width, 0, height)], [], [(0, 1, 2, 3)])
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for loop, coord in zip(uv_layer.data, ((0, 0), (1, 0), (1, 1), (0, 1))): loop.uv = coord
    shadow = bpy.data.objects.new("ContactShadow__" + layer["id"], mesh)
    bpy.context.scene.collection.objects.link(shadow)
    shadow.parent = root
    shadow.location = (0.0, -0.006, bottom - 0.035)
    material = bpy.data.materials.new("ContactShadowMaterial__" + layer["id"])
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = (0.012, 0.01, 0.009, 1)
    coord = nodes.new("ShaderNodeTexCoord")
    center = nodes.new("ShaderNodeVectorMath")
    center.operation = "DISTANCE"
    center.inputs[1].default_value = (0.5, 0.5, 0.0)
    fade = nodes.new("ShaderNodeMapRange")
    fade.clamp = True
    fade.inputs["From Min"].default_value = 0.12
    fade.inputs["From Max"].default_value = 0.72
    fade.inputs["To Min"].default_value = 0.30
    fade.inputs["To Max"].default_value = 0.0
    mix = nodes.new("ShaderNodeMixShader")
    links.new(coord.outputs["UV"], center.inputs[0])
    links.new(center.outputs["Value"], fade.inputs["Value"])
    links.new(fade.outputs["Result"], mix.inputs[0])
    links.new(transparent.outputs["BSDF"], mix.inputs[1])
    links.new(emission.outputs["Emission"], mix.inputs[2])
    links.new(mix.outputs["Shader"], output.inputs["Surface"])
    material.surface_render_method = "DITHERED"
    shadow.data.materials.append(material)
    shadow["filmie_owner"] = layer["id"]
    return shadow


def make_image_plane(asset, transform, style, name, width=None, height=None):
    image = bpy.data.images.load(asset["localPath"], check_existing=True)
    image.pack()
    aspect = image.size[0] / image.size[1]
    if width is None or height is None:
        height = 2.0
        width = height * aspect
    width *= float(transform["scale"])
    height *= float(transform["scale"])
    x = float(transform["position"]["x"])
    depth = float(transform["position"]["y"])
    z = float(transform["position"]["z"])
    vertices = [
        (x - width / 2.0, depth, z - height / 2.0),
        (x + width / 2.0, depth, z - height / 2.0),
        (x + width / 2.0, depth, z + height / 2.0),
        (x - width / 2.0, depth, z + height / 2.0),
    ]
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for loop_index, uv_coord in zip(uv_layer.data, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop_index.uv = uv_coord
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(color_material(image, style, name + "Charcoal", seed=style.get("seed", 0), depth=transform["position"]["y"]))
    return obj


def instantiate_asset(asset, transform, style, entity_id):
    """Append one immutable generated Blender collection or load a prepared image."""
    collection_name = asset.get("metadata", {}).get("blenderCollection")
    if not collection_name:
        image_obj = make_image_plane(asset, transform, style, entity_id)
        image_obj["filmie_entity_id"] = entity_id
        return image_obj, {}
    with bpy.data.libraries.load(asset["localPath"], link=False) as (source, destination):
        if collection_name not in source.collections:
            raise RuntimeError(
                "Generated asset collection is missing: " + collection_name
            )
        destination.collections = [collection_name]
    collection = destination.collections[0]
    if collection is None:
        raise RuntimeError("Blender could not append asset collection " + collection_name)
    bpy.context.scene.collection.children.link(collection)
    root = next(
        (obj for obj in collection.objects if obj.get("filmie_asset_id") == asset["assetId"]),
        None,
    )
    if root is None:
        raise RuntimeError("Generated asset has no root object: " + asset["assetId"])
    position = transform["position"]
    rotation = transform["rotationDegrees"]
    root.location = (
        float(position["x"]),
        float(position["y"]),
        float(position["z"]),
    )
    root.rotation_euler = tuple(math.radians(float(rotation[axis])) for axis in ("x", "y", "z"))
    root.scale = (float(transform["scale"]),) * 3
    root.name = entity_id
    root["filmie_entity_id"] = entity_id
    for armature in collection.objects:
        if armature.type == "ARMATURE":
            armature["filmie_character_id"] = entity_id
    for sprite in collection.objects:
        if sprite.type != "MESH" or not sprite.get("filmie_prepared_matte"):
            continue
        source = next(node.image for node in sprite.data.materials[0].node_tree.nodes
                      if node.type == "TEX_IMAGE" and node.image)
        sprite.data.materials[0] = color_material(
            source, style, "EnvironmentCharcoal",
            opacity=float(sprite["filmie_opacity"]), seed=style["seed"],
        )
    controls = {
        obj.get("filmie_semantic_id", obj.get("filmie_control_id", obj.name)): obj
        for obj in collection.objects
        if obj.get("filmie_control_id") or obj.name.startswith("RIG_")
    }
    try:
        semantic_controls = json.loads(root.get("filmie_semantic_controls", "{}"))
    except (TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("Prepared asset has malformed semantic control metadata") from error
    for semantic_id, node_id in semantic_controls.items():
        control = next(
            (obj for obj in collection.objects if obj.get("filmie_node_id") == node_id),
            None,
        )
        if control is None:
            raise RuntimeError(
                "Prepared asset semantic control " + semantic_id + " references missing node " + node_id
            )
        controls[semantic_id] = control
    legacy_semantic_names = {
        "RIG_chest": "chest", "RIG_head": "head",
        "RIG_arm.L": "left-arm", "RIG_arm.R": "right-arm",
        "RIG_leg.L": "left-leg", "RIG_leg.R": "right-leg",
        "RIG_brow.L": "left-brow", "RIG_brow.R": "right-brow",
        "RIG_eye.L": "left-eye", "RIG_eye.R": "right-eye",
        "RIG_hand.L": "left-hand", "RIG_hand.R": "right-hand",
    }
    for legacy_name, semantic_name in legacy_semantic_names.items():
        if legacy_name in controls:
            controls.setdefault(semantic_name, controls[legacy_name])
    return root, controls


def create_haze_plane(spec, camera_distance):
    style = spec["style"]
    """A subtle procedural foreground layer adds depth without altering artwork."""
    mesh = bpy.data.meshes.new("AtmosphereMesh")
    depth = -2.4
    plane_distance = camera_distance + depth
    view_width = plane_distance * 36.0 / 50.0
    view_height = view_width * float(spec["height"]) / float(spec["width"])
    vertices = [
        (-view_width / 2, depth, -view_height / 2),
        (view_width / 2, depth, -view_height / 2),
        (view_width / 2, depth, view_height / 2),
        (-view_width / 2, depth, view_height / 2),
    ]
    mesh.from_pydata(vertices, [], [(0, 1, 2, 3)])
    mesh.update()
    uv_layer = mesh.uv_layers.new(name="UVMap")
    for loop, uv_coord in zip(uv_layer.data, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop.uv = uv_coord
    obj = bpy.data.objects.new("Foreground Atmosphere", mesh)
    bpy.context.scene.collection.objects.link(obj)

    material = bpy.data.materials.new("Charcoal Mist")
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = (0.29, 0.27, 0.24, 1)
    mix = nodes.new("ShaderNodeMixShader")
    uv = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 3.5
    noise.inputs["Detail"].default_value = 4.0
    ramp = nodes.new("ShaderNodeMapRange")
    ramp.clamp = True
    ramp.inputs["From Min"].default_value = 0.58
    ramp.inputs["From Max"].default_value = 0.86
    ramp.inputs["To Min"].default_value = 0.0
    ramp.inputs["To Max"].default_value = float(spec["style"]["hazeStrength"])
    mapping = nodes.new("ShaderNodeMapping")
    links.new(uv.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], noise.inputs["Vector"])
    if spec["style"].get("version") == "2.0.0" and float(spec["style"].get("hazeDrift", 0.0)) > 0:
        rate = float(spec["style"].get("frameRate", 30.0))
        boil_rate = float(spec["style"].get("boilFps", 12.0))
        for frame in range(1, int(spec["durationFrames"]) + 1):
            index = math.floor(frame * boil_rate / rate)
            if frame > 1 and index == math.floor((frame - 1) * boil_rate / rate):
                continue
            mapping.inputs["Location"].default_value = (index * float(spec["style"]["hazeDrift"]), 0.0, 0.0)
            material.node_tree.keyframe_insert(data_path='nodes["' + mapping.name + '"].inputs["Location"].default_value', frame=frame)
        set_constant_interpolation(material.node_tree, 'nodes["' + mapping.name + '"].inputs[' + str(mapping.inputs.find("Location")) + '].default_value')
    links.new(noise.outputs["Fac"], ramp.inputs["Value"])
    links.new(ramp.outputs["Result"], mix.inputs[0])
    links.new(transparent.outputs["BSDF"], mix.inputs[1])
    links.new(emission.outputs["Emission"], mix.inputs[2])
    links.new(mix.outputs["Shader"], output.inputs["Surface"])
    material.surface_render_method = "BLENDED" if style.get("version") == "2.0.0" else "DITHERED"
    obj.data.materials.append(material)
    return obj


def create_screen_paper(scene, camera, style, width, height):
    """Camera-parented procedural paper overlay; UV coordinates stay screen-fixed."""
    distance = 0.2
    lens = float(camera.data.lens)
    plane_width = distance * 36.0 / lens
    plane_height = plane_width * float(height) / float(width)
    mesh = bpy.data.meshes.new("ScreenFixedPaperMesh")
    mesh.from_pydata(
        [(-plane_width / 2, -plane_height / 2, 0), (plane_width / 2, -plane_height / 2, 0),
         (plane_width / 2, plane_height / 2, 0), (-plane_width / 2, plane_height / 2, 0)],
        [], [(0, 1, 2, 3)],
    )
    mesh.uv_layers.new(name="UVMap")
    for loop, uv in zip(mesh.uv_layers.active.data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
        loop.uv = uv
    obj = bpy.data.objects.new("ScreenFixedPaper", mesh)
    scene.collection.objects.link(obj)
    obj.parent = camera
    obj.location = (0, 0, -distance)
    material = bpy.data.materials.new("ScreenFixedPaperMaterial")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    emission = nodes.new("ShaderNodeEmission")
    texcoord = nodes.new("ShaderNodeTexCoord")
    fibers = nodes.new("ShaderNodeTexNoise")
    fibers.inputs["Scale"].default_value = float(style.get("paperFiberScale", 240.0))
    fibers.inputs["Detail"].default_value = 2.0
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.2, 0.18, 0.15, 1)
    paper_value = float(style.get("paperWhitePoint", 0.72)) if style.get("version") == "2.0.0" else 0.72
    ramp.color_ramp.elements[1].color = (paper_value, paper_value * 0.95, paper_value * 0.86, 1)
    mix = nodes.new("ShaderNodeMixShader")
    mix.inputs[0].default_value = float(style.get("paperOpacity", 0.045))
    links.new(texcoord.outputs["UV"], fibers.inputs["Vector"])
    links.new(fibers.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], emission.inputs["Color"])
    links.new(transparent.outputs["BSDF"], mix.inputs[1])
    links.new(emission.outputs["Emission"], mix.inputs[2])
    links.new(mix.outputs["Shader"], output.inputs["Surface"])
    material.surface_render_method = "BLENDED" if style.get("version") == "2.0.0" else "DITHERED"
    obj.data.materials.append(material)
    return obj


def create_dust_motes(scene, camera, style, seed):
    """Seeded world-space camera-facing motes; depth creates visible parallax."""
    count = max(0, min(100, int(float(style.get("dustDensity", 0.0)))))
    if count == 0:
        return []
    rng = random.Random(int(seed) ^ 0xD057C0DE)
    material = bpy.data.materials.new("Seeded Dust Mote")
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = (0.55, 0.50, 0.42, 1)
    uv = nodes.new("ShaderNodeTexCoord")
    radial = nodes.new("ShaderNodeVectorMath")
    radial.operation = "DISTANCE"
    radial.inputs[1].default_value = (0.5, 0.5, 0.0)
    fade = nodes.new("ShaderNodeMapRange")
    fade.clamp = True
    fade.inputs["From Min"].default_value = 0.18
    fade.inputs["From Max"].default_value = 0.5
    fade.inputs["To Min"].default_value = 0.5
    fade.inputs["To Max"].default_value = 0.0
    mix = nodes.new("ShaderNodeMixShader")
    links.new(uv.outputs["UV"], radial.inputs[0])
    links.new(radial.outputs["Value"], fade.inputs["Value"])
    links.new(fade.outputs["Result"], mix.inputs[0])
    links.new(transparent.outputs["BSDF"], mix.inputs[1])
    links.new(emission.outputs["Emission"], mix.inputs[2])
    links.new(mix.outputs["Shader"], output.inputs["Surface"])
    material.surface_render_method = "BLENDED" if style.get("version") == "2.0.0" else "DITHERED"
    forward = camera.matrix_world.to_quaternion() @ Vector((0.0, 0.0, -1.0))
    right = camera.matrix_world.to_quaternion() @ Vector((1.0, 0.0, 0.0))
    up = camera.matrix_world.to_quaternion() @ Vector((0.0, 1.0, 0.0))
    objects = []
    for index in range(count):
        size = rng.uniform(0.008, 0.025)
        mesh = bpy.data.meshes.new("DustBillboardMesh_%03d" % index)
        mesh.from_pydata([(-size, -size, 0), (size, -size, 0), (size, size, 0), (-size, size, 0)], [], [(0, 1, 2, 3)])
        mesh.update()
        layer = mesh.uv_layers.new(name="UVMap")
        for loop, coord in zip(layer.data, ((0, 0), (1, 0), (1, 1), (0, 1))): loop.uv = coord
        obj = bpy.data.objects.new("DustBillboard_%03d" % index, mesh)
        scene.collection.objects.link(obj)
        obj.data.materials.append(material)
        depth = rng.uniform(0.8, 2.6)
        origin = camera.location + forward * depth + right * rng.uniform(-1.0, 1.0) + up * rng.uniform(-0.55, 0.55)
        obj.location = origin
        obj.rotation_euler = camera.rotation_euler
        for frame in range(1, int(style.get("durationFrames", 1)) + 1, 15):
            drift = (frame - 1) / max(1.0, float(style.get("frameRate", 30.0)))
            obj.location = origin + right * (drift * rng.uniform(0.008, 0.02)) + up * (drift * rng.uniform(0.003, 0.009))
            obj.keyframe_insert(data_path="location", frame=frame)
        objects.append(obj)
    return objects


def create_scene(spec):
    scene = bpy.context.scene
    spec["style"]["seed"] = int(spec.get("randomSeed", 0))
    spec["style"]["durationFrames"] = int(spec["durationFrames"])
    spec["style"]["textureQuality"] = spec["renderConfig"].get("textures", "high")
    spec["style"]["frameRate"] = (
        float(spec["frameRate"]["numerator"]) / float(spec["frameRate"]["denominator"])
    )
    spec["style"].setdefault("boilFps", 12.0)
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    config = spec["renderConfig"]
    engine = config["engine"]
    if engine == "BLENDER_EEVEE":
        engine = "BLENDER_EEVEE_NEXT" if hasattr(scene, "eevee_next") else "BLENDER_EEVEE"
    scene.render.engine = engine
    if engine.startswith("BLENDER_EEVEE"):
        eevee = getattr(scene, "eevee_next", None) or getattr(scene, "eevee", None)
        if eevee is not None and hasattr(eevee, "taa_render_samples"):
            eevee.taa_render_samples = int(config["samples"])
        spec["selectedBackend"] = "EEVEE"
    elif engine == "CYCLES":
        scene.cycles.samples = int(config["samples"])
        scene.cycles.use_denoising = bool(config.get("denoising", False))
        preferences = bpy.context.preferences.addons["cycles"].preferences
        requested = config.get("device", "AUTO")
        detected_types = set()
        backends = [requested] if requested not in {"AUTO", "CPU"} else ["OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"]
        for backend in backends:
            try:
                preferences.compute_device_type = backend
                preferences.get_devices()
                if any(device.type == backend for device in preferences.devices):
                    detected_types.add(backend)
            except Exception:
                continue
        if requested not in {"AUTO", "CPU"} and requested not in detected_types:
            raise RuntimeError("Requested Cycles backend is unavailable: " + requested)
        if requested == "AUTO":
            priority = ["OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"]
            requested = next((backend for backend in priority if backend in detected_types), "CPU")
        device = None
        if requested != "CPU":
            preferences.compute_device_type = requested
            preferences.get_devices()
            device = next((candidate for candidate in preferences.devices if candidate.type == requested), None)
        if requested != "CPU" and device is None:
            raise RuntimeError("Blender detected backend but did not expose a usable device: " + requested)
        scene.cycles.device = "GPU" if device else "CPU"
        for candidate in preferences.devices:
            candidate.use = bool(device is not None and candidate == device)
        spec["selectedBackend"] = device.type if device else "CPU"
    elif engine == "BLENDER_WORKBENCH":
        scene.display.shading.light = "STUDIO"
        scene.display.shading.color_type = "TEXTURE"
        scene.display.shading.show_shadows = False
        scene.display.shading.show_cavity = False
        spec["selectedBackend"] = "WORKBENCH"
    else:
        raise RuntimeError("Unsupported Blender engine: " + engine)
    scene.render.resolution_x = int(spec["width"])
    scene.render.resolution_y = int(spec["height"])
    scene.render.resolution_percentage = 100
    scene.render.fps = int(spec["frameRate"]["numerator"])
    scene.render.fps_base = float(spec["renderConfig"].get("frameRate", spec["frameRate"])["denominator"])
    scene.render.fps = int(spec["renderConfig"].get("frameRate", spec["frameRate"])["numerator"])
    scene.frame_start = 1
    scene.frame_end = int(spec["durationFrames"])
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.image_settings.color_depth = "8"
    scene.render.filepath = os.path.join(spec["outputDirectory"], "frames", "frame_######")
    scene.render.use_file_extension = True
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "Medium High Contrast"
    scene.view_settings.exposure = 0.25
    scene.view_settings.gamma = 1.0
    scene.world = bpy.data.worlds.new("Charcoal Horror World")
    scene.world.color = (0.045, 0.04, 0.035)
    shadow_quality = spec.get("renderConfig", {}).get("shadows", "high")

    key_data = bpy.data.lights.new("Soft Sepia Key", type="AREA")
    key_data.energy = float(spec["style"]["lighting"]["keyEnergy"])
    key_data.use_shadow = shadow_quality != "off"
    key_data.shape = "DISK"
    key_data.size = float(spec["style"]["lighting"]["keySize"])
    key_data.color = tuple(float(value) for value in spec["style"]["lighting"]["keyColor"])
    key = bpy.data.objects.new("Soft Sepia Key", key_data)
    scene.collection.objects.link(key)
    key_position = spec["style"]["lighting"]["keyPosition"]
    key.location = tuple(float(value) for value in key_position)
    key.rotation_euler = (Vector((0.0, 0.0, 0.0)) - key.location).to_track_quat("-Z", "Y").to_euler()
    flicker = random.Random(int(spec.get("randomSeed", 0)) ^ 0x5F3759DF)
    for frame in range(1, int(spec["durationFrames"]) + 1, 3):
        key_data.energy = float(spec["style"]["lighting"]["keyEnergy"]) * (1.0 + flicker.uniform(-0.045, 0.045))
        key_data.keyframe_insert(data_path="energy", frame=frame)
    set_constant_interpolation(key_data, "energy")

    fill_data = bpy.data.lights.new("Graphite bounce fill", type="AREA")
    fill_data.energy = float(spec["style"]["lighting"]["keyEnergy"]) * 0.38
    fill_data.use_shadow = shadow_quality == "high"
    fill_data.size = 5.0
    fill_data.color = (0.68, 0.65, 0.6)
    fill = bpy.data.objects.new("Graphite bounce fill", fill_data)
    scene.collection.objects.link(fill)
    fill.location = (2.8, -2.0, 2.0)
    fill.rotation_euler = (Vector((0.0, 0.0, 0.0)) - fill.location).to_track_quat("-Z", "Y").to_euler()

    for light_spec in sorted(spec.get("lights", []), key=lambda item: item["id"]):
        light_type = light_spec["type"].upper()
        light_data = bpy.data.lights.new("Prepared Light | " + light_spec["id"], type=light_type)
        light_data.energy = float(light_spec["energy"])
        light_data.use_shadow = shadow_quality != "off" and shadow_quality == "high"
        light_data.color = tuple(float(value) for value in light_spec["color"])
        if light_type == "AREA":
            light_data.shape = "DISK"
            light_data.size = float(light_spec["size"])
        elif light_type == "POINT":
            light_data.shadow_soft_size = float(light_spec["radius"])
        elif light_type == "SPOT":
            light_data.spot_size = float(light_spec["coneAngleRadians"])
        light_object = bpy.data.objects.new("Prepared Light | " + light_spec["id"], light_data)
        scene.collection.objects.link(light_object)
        light_object.location = tuple(float(light_spec["position"][axis]) for axis in ("x", "y", "z"))
        light_target = Vector(tuple(float(light_spec["target"][axis]) for axis in ("x", "y", "z")))
        light_object.rotation_euler = (light_target - light_object.location).to_track_quat("-Z", "Y").to_euler()
        if spec["style"].get("version") == "2.0.0" and "lantern" in light_spec["id"].lower():
            rate = float(spec["style"].get("frameRate", 30.0))
            boil_rate = float(spec["style"].get("boilFps", 12.0))
            for frame in range(1, int(spec["durationFrames"]) + 1):
                index = math.floor(frame * boil_rate / rate)
                prior = math.floor((frame - 1) * boil_rate / rate)
                if frame > 1 and index == prior: continue
                flicker_rng = random.Random((int(spec.get("randomSeed", 0)) ^ (index * 0x9E3779B1)) & 0xFFFFFFFF)
                light_data.energy = float(light_spec["energy"]) * (1.0 + flicker_rng.uniform(-0.06, 0.06))
                light_data.keyframe_insert(data_path="energy", frame=frame)
            set_constant_interpolation(light_data, "energy")

    environment, _ = instantiate_asset(
        spec["environment"],
        {"position": {"x": 0.0, "y": 0.0, "z": 0.0},
         "rotationDegrees": {"x": 0.0, "y": 0.0, "z": 0.0}, "scale": 1.0},
        spec["style"],
        "Environment",
    )
    environment_collection = spec["environment"].get("metadata", {}).get("blenderCollection")
    camera_distance = float(spec["cameraKeyframes"][0]["distance"])
    initial_focal_length = float(spec["cameraKeyframes"][0].get("focalLength", 50.0))
    if not environment_collection:
        image = bpy.data.images.load(spec["environment"]["localPath"], check_existing=True)
        aspect = image.size[0] / image.size[1]
        view_height = (
            camera_distance
            * 36.0
            / initial_focal_length
            * float(spec["height"])
            / float(spec["width"])
        )
        image.pack()
        frame_scale = view_height * 1.04 / 2.0
        environment.scale = (frame_scale, 1.0, frame_scale)
    if engine != "BLENDER_WORKBENCH":
        create_haze_plane(spec, camera_distance)
    entity_roots = {}
    control_objects = {}
    node_roots = {}
    for group in sorted(spec.get("groups", []), key=lambda item: item["id"]):
        root = bpy.data.objects.new("GROUP__" + group["id"], None)
        scene.collection.objects.link(root)
        root.empty_display_type = "PLAIN_AXES"
        position = group["transform"]["position"]
        rotation = group["transform"]["rotationDegrees"]
        root.location = tuple(float(position[axis]) for axis in ("x", "y", "z"))
        root.rotation_euler = tuple(
            math.radians(float(rotation[axis])) for axis in ("x", "y", "z")
        )
        root.scale = (float(group["transform"]["scale"]),) * 3
        root["filmie_group_id"] = group["id"]
        node_roots[group["id"]] = root
        entity_roots[group["id"]] = root
    for layer in sorted(spec["layers"], key=lambda item: (item.get("order", 0), item["id"])):
        root, sprite = create_sprite_layer(layer, spec["style"])
        node_roots[layer["id"]] = root
        entity_roots[layer["id"]] = root
        control_objects[layer["id"]] = {"sprite": sprite, "root": root}
        if spec["style"].get("version") == "2.0.0" and spec.get("renderConfig", {}).get("shadows") != "off" and layer.get("role") in {"character", "prop"}:
            add_contact_shadow(root, layer)
    for node in [*spec.get("groups", []), *spec["layers"]]:
        parent_id = node.get("parentId")
        if parent_id:
            root = node_roots.get(node["id"])
            parent = node_roots.get(parent_id)
            if root is None or parent is None:
                raise RuntimeError(
                    "Artwork hierarchy references missing node " + str(parent_id)
                )
            root.parent = parent
    for character in spec["characters"]:
        root, controls = instantiate_asset(
            character["artwork"], character["transform"], spec["style"], character["id"]
        )
        entity_roots[character["id"]] = root
        control_objects[character["id"]] = controls
    for prop in spec["props"]:
        root, controls = instantiate_asset(
            prop["artwork"], prop["transform"], spec["style"], prop["id"]
        )
        entity_roots[prop["id"]] = root
        control_objects[prop["id"]] = controls

    camera_data = bpy.data.cameras.new("Cinematic Camera")
    camera_data.type = "PERSP"
    camera_data.lens = initial_focal_length
    camera = bpy.data.objects.new("Cinematic Camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    for keyframe in spec["cameraKeyframes"]:
        frame = int(keyframe["frame"])
        if "position" in keyframe and "target" in keyframe:
            camera.location = tuple(float(keyframe["position"][axis]) for axis in ("x", "y", "z"))
            target = Vector(tuple(float(keyframe["target"][axis]) for axis in ("x", "y", "z")))
        else:
            target = Vector(tuple(float(spec["camera"]["target"][axis]) for axis in ("x", "y", "z")))
            distance = float(keyframe["distance"])
            camera.location = (target.x, target.y - distance, target.z)
        camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.keyframe_insert(data_path="location", frame=frame)
        camera.keyframe_insert(data_path="rotation_euler", frame=frame)
        if "focalLength" in keyframe:
            camera_data.lens = float(keyframe["focalLength"])
            camera_data.keyframe_insert(data_path="lens", frame=frame)
    scene.frame_set(1)
    bpy.context.view_layer.update()
    if spec["style"].get("version") == "2.0.0" and config["engine"] != "BLENDER_WORKBENCH":
        create_dust_motes(scene, camera, spec["style"], int(spec.get("randomSeed", 0)))
    if config["engine"] != "BLENDER_WORKBENCH":
        paper = create_screen_paper(scene, camera, spec["style"], spec["width"], spec["height"])
        for keyframe in spec["cameraKeyframes"]:
            frame = int(keyframe["frame"])
            focal_length = float(keyframe.get("focalLength", initial_focal_length))
            paper.scale = (initial_focal_length / focal_length,) * 3
            paper.keyframe_insert(data_path="scale", frame=frame)
    scene.frame_set(1)
    return scene, environment, entity_roots, control_objects


def bind_authoritative_rig(control_objects):
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
    for character_id, controls in control_objects.items():
        armatures = [
            obj for obj in bpy.context.scene.objects
            if obj.type == "ARMATURE" and obj.get("filmie_rig_type") == "humanoid-semantic-v1"
        ]
        armature = next(
            (candidate for candidate in armatures
             if candidate.get("filmie_character_id") == character_id),
            None,
        )
        if armature is None:
            continue
        for semantic, bone_name in bone_semantics.items():
            control = controls.get(semantic)
            if control is None or bone_name not in armature.pose.bones:
                continue
            bone = armature.pose.bones[bone_name]
            for existing in list(bone.constraints):
                if existing.name.startswith("FILMIE Semantic"):
                    bone.constraints.remove(existing)
            constraint = bone.constraints.new("COPY_TRANSFORMS")
            constraint.name = "FILMIE Semantic " + semantic
            constraint.target = control
            constraint.target_space = "WORLD"
            constraint.owner_space = "WORLD"

        collection = armature.users_collection[0]
        for side, label in (("L", "left"), ("R", "right")):
            hand_control = controls.get(label + "-hand")
            target = next((obj for obj in collection.objects
                           if obj.name == "IK_hand." + side + ".Target"), None)
            if hand_control is not None and target is not None:
                constraint = target.constraints.get("FILMIE Hand Target")
                if constraint is None:
                    constraint = target.constraints.new("COPY_TRANSFORMS")
                    constraint.name = "FILMIE Hand Target"
                    constraint.target = hand_control
                    constraint.target_space = "WORLD"
                    constraint.owner_space = "WORLD"
            ik_target = next((obj for obj in collection.objects
                              if obj.name == "IK_hand." + side + ".Target"), None)
            if ik_target is not None and hand_control is not None:
                ik_target["filmie_drives_from"] = hand_control.name


def apply_facial_variants(actions, scene, entity_roots):
    """Drive declared artwork alternatives as frame-dependent visibility states."""
    schedules = {}
    for instruction in actions:
        action = instruction["action"]
        if action["type"] != "facial-variant":
            continue
        character_id = instruction["characterId"]
        slot_id = action["slotId"]
        root = entity_roots.get(character_id)
        if root is None:
            raise RuntimeError("Facial variant requires a valid character asset")
        try:
            variants = json.loads(root.get("filmie_variant_map_" + slot_id, "[]"))
        except (TypeError, json.JSONDecodeError) as error:
            raise RuntimeError("Character has malformed facial variant metadata") from error
        if action["variantId"] not in variants:
            raise RuntimeError(
                "Character has no declared variant " + slot_id + "=" + action["variantId"]
            )
        default_index = int(root.get("filmie_variant_" + slot_id, -1))
        if default_index < 0 or default_index >= len(variants):
            raise RuntimeError("Character facial variant default is invalid for " + slot_id)
        key = (character_id, slot_id)
        schedules.setdefault(key, {"root": root, "default": variants[default_index], "events": []})["events"].append(
            (int(action["startFrame"]) + 1, int(action["endFrame"]), action["variantId"])
        )

    for (character_id, slot_id), schedule in schedules.items():
        events = sorted(schedule["events"])
        root = schedule["root"]
        descendants = []
        for obj in scene.objects:
            ancestor = obj
            while ancestor is not None and ancestor != root:
                ancestor = ancestor.parent
            if ancestor == root and obj.get("filmie_variant_slot") == slot_id:
                descendants.append(obj)
        if not descendants:
            raise RuntimeError("Character has no rendered artwork for variant slot " + slot_id)
        for obj in descendants:
            variant_id = obj.get("filmie_variant_id")
            conditions = [
                "((frame >= %d and frame <= %d) and %d)"
                % (start, end, int(variant_id != selected))
                for start, end, selected in events
            ]
            conditions.append(
                "((%s) and %d)"
                % (
                    " and ".join("not (frame >= %d and frame <= %d)" % (start, end) for start, end, _selected in events),
                    int(variant_id != schedule["default"]),
                )
            )
            driver = obj.driver_add("hide_render").driver
            driver.type = "SCRIPTED"
            variable = driver.variables.new()
            variable.name = "frame"
            variable.type = "SINGLE_PROP"
            variable.targets[0].id_type = "SCENE"
            variable.targets[0].id = scene
            variable.targets[0].data_path = "frame_current"
            driver.expression = " or ".join(conditions)


def resolve_asset_anchor(target, anchor_id):
    """Resolve prepared child anchors in world space, with legacy metadata fallback."""
    for candidate in bpy.context.scene.objects:
        if candidate.get("filmie_anchor_id") != anchor_id:
            continue
        ancestor = candidate.parent
        while ancestor is not None and ancestor != target:
            ancestor = ancestor.parent
        if ancestor == target:
            bpy.context.view_layer.update()
            return candidate.matrix_world.translation.copy()
    try:
        anchors = json.loads(target.get("filmie_anchors", "{}"))
    except (TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("Target asset has malformed anchor metadata") from error
    anchor = anchors.get(anchor_id)
    if anchor is None:
        raise RuntimeError("Target asset does not define anchor " + anchor_id)
    return target.matrix_world @ Vector(anchor)


def apply_actions(spec, entity_roots, control_objects):
    if spec.get("animationLibraryVersion") != "1.0.0":
        raise RuntimeError("Unsupported semantic animation library version: " + str(spec.get("animationLibraryVersion")))
    scene = bpy.context.scene
    bind_authoritative_rig(control_objects)
    apply_facial_variants(spec["actions"], scene, entity_roots)
    action_priority = {
        "walk": 0, "run": 0, "jump": 0,
        "breathing": 1, "head-turn": 1, "blink": 1, "expression": 1,
        "facial-variant": 1,
        "lip-sync": 1, "celebrate": 1, "sit": 1, "stand": 1,
        "interaction": 2, "kick": 2, "reach": 3, "grasp": 4,
        "lift": 5, "place": 6, "motion-clip": 7,
    }
    for instruction in sorted(
        spec["actions"],
        key=lambda item: (
            item["interval"]["startFrame"],
            item["characterId"],
            action_priority.get(item["action"]["type"], 99),
            item["action"]["id"],
        ),
    ):
        character_id = instruction["characterId"]
        action = instruction["action"]
        if action["type"] == "motion-clip":
            continue
        controls = control_objects.get(character_id, {})
        character_root = entity_roots.get(character_id)
        is_cutout_rig = bool(
            character_root and character_root.get("filmie_semantic_controls")
        )
        start = int(action["startFrame"]) + 1
        end = int(action["endFrame"])
        if action["type"] == "breathing":
            chest = controls.get("chest")
            if chest is None:
                raise RuntimeError("Breathing action requires RIG_chest on " + character_id)
            base = chest.scale.z
            for frame in range(start, end + 1):
                phase = 2.0 * math.pi * (frame - start) / int(action["cycleFrames"])
                chest.scale.z = base * (1.0 + float(action["amplitude"]) * math.sin(phase))
                chest.keyframe_insert(data_path="scale", index=2, frame=frame)
        elif action["type"] == "head-turn":
            head = controls.get("head")
            target = entity_roots.get(action["targetEntityId"])
            character = entity_roots.get(character_id)
            if head is None or target is None or character is None:
                raise RuntimeError("Head turn needs RIG_head and a valid target entity")
            depsgraph = bpy.context.evaluated_depsgraph_get()
            character_position = character.evaluated_get(depsgraph).matrix_world.translation
            target_position = target.evaluated_get(depsgraph).matrix_world.translation
            direction = math.atan2(
                target_position.x - character_position.x,
                -(target_position.y - character_position.y),
            )
            limit = math.radians(float(action["maxYawDegrees"]))
            yaw = max(-limit, min(limit, direction))
            head.rotation_euler.z = 0.0
            head.keyframe_insert(data_path="rotation_euler", index=2, frame=start)
            head.rotation_euler.z = yaw
            head.keyframe_insert(data_path="rotation_euler", index=2, frame=end)
        elif action["type"] == "blink":
            eyes = [controls.get("left-eye"), controls.get("right-eye")]
            if any(eye is None for eye in eyes):
                raise RuntimeError("Blink action requires semantic eye controls on " + character_id)
            interval = int(action["intervalFrames"])
            closure = int(action["closureFrames"])
            for frame in range(start, end + 1, interval):
                for eye in eyes:
                    eye.scale.z = 1.0
                    eye.keyframe_insert(data_path="scale", index=2, frame=frame)
                    eye.scale.z = 0.05
                    eye.keyframe_insert(data_path="scale", index=2, frame=min(end, frame + closure // 2))
                    eye.scale.z = 1.0
                    eye.keyframe_insert(data_path="scale", index=2, frame=min(end, frame + closure))
        elif action["type"] == "expression":
            brows = [controls.get("left-brow"), controls.get("right-brow")]
            if any(brow is None for brow in brows):
                raise RuntimeError("Expression action requires semantic brow controls on " + character_id)
            expression = action["expressionId"]
            angle = {"neutral": 0.0, "worried": 0.14, "stern": -0.12, "fearful": 0.22}[expression]
            for brow in brows:
                axis = 1 if is_cutout_rig else 0
                brow.rotation_euler[axis] = 0.0
                brow.keyframe_insert(data_path="rotation_euler", index=axis, frame=start)
                brow.rotation_euler[axis] = angle
                brow.keyframe_insert(data_path="rotation_euler", index=axis, frame=end)
        elif action["type"] == "facial-variant":
            continue
        elif action["type"] == "lip-sync":
            mouth = controls.get("mouth")
            if mouth is None:
                raise RuntimeError("Lip-sync action requires a semantic mouth control on " + character_id)
            shape_scale = {
                "closed": (0.15, 1.0), "open": (1.8, 1.0),
                "wide": (0.75, 1.35), "round": (1.2, 0.68),
            }
            for viseme in action["visemes"]:
                for frame in (int(viseme["startFrame"]) + 1, int(viseme["endFrame"])):
                    mouth.scale.z, mouth.scale.x = shape_scale[viseme["shape"]]
                    mouth.keyframe_insert(data_path="scale", frame=frame)
        elif action["type"] in ("walk", "run"):
            legs = [controls.get("left-leg"), controls.get("right-leg")]
            if any(leg is None for leg in legs):
                raise RuntimeError("Walk action requires semantic leg controls on " + character_id)
            character_root = entity_roots.get(character_id)
            if character_root is None:
                raise RuntimeError("Walk action requires a character root")
            rig = next((obj for obj in bpy.context.scene.objects
                        if obj.type == "ARMATURE"
                        and obj.get("filmie_character_id") == character_id), None)
            collection = rig.users_collection[0]             if rig is not None else None
            initial_y = float(character_root.location.y)
            initial_x = float(character_root.location.x)
            initial_z = float(character_root.location.z)
            cycle = int(action["cycleFrames"])
            stride = float(action["strideMeters"])
            velocity_scale = 1.0 if action["type"] == "run" else 0.72
            for frame in range(start, end + 1):
                phase = 2.0 * math.pi * (frame - start) / cycle
                progress = (frame - start) / max(1, end - start)
                character_root.location.x = initial_x
                character_root.location.y = initial_y - float(action["distanceMeters"]) * progress
                character_root.location.z = initial_z
                character_root.keyframe_insert(data_path="location", frame=frame)
                for side, leg in enumerate(legs):
                    leg.rotation_euler[1] = math.sin(phase + side * math.pi) * min(0.8, stride) * velocity_scale
                    leg.keyframe_insert(data_path="rotation_euler", index=1, frame=frame)
                    foot_side = "L" if side == 0 else "R"
                    foot_target = next((obj for obj in collection.objects
                                        if obj.name == "IK_foot." + foot_side + ".Target"), None) if collection is not None else None
                    if foot_target is not None:
                        planted = math.sin(phase + side * math.pi) >= -0.05
                        if planted:
                            foot_target.location.z = 0.0
                        else:
                            foot_target.location.z = min(0.12, 0.04 + stride * 0.08) * abs(math.sin(phase + side * math.pi))
                        foot_target.keyframe_insert(data_path="location", frame=frame)
        elif action["type"] == "jump":
            character_root = entity_roots.get(character_id)
            if character_root is None:
                raise RuntimeError("Jump action requires a character root")
            scene.frame_set(start)
            base_z = float(character_root.location.z)
            base_y = float(character_root.location.y)
            height = float(action["heightMeters"])
            character_root.keyframe_insert(data_path="location", frame=start)
            for frame in range(start, end + 1):
                progress = (frame - start) / max(1, end - start)
                character_root.location.z = base_z + height * 4.0 * progress * (1.0 - progress)
                character_root.location.y = base_y - float(action["distanceMeters"]) * progress
                character_root.keyframe_insert(data_path="location", frame=frame)
            character_root.location.z = base_z
            character_root.location.y = base_y - float(action["distanceMeters"])
            character_root.keyframe_insert(data_path="location", frame=end)
        elif action["type"] == "kick":
            leg_key = action["leg"] + "-leg"
            leg = controls.get(leg_key)
            if leg is None:
                raise RuntimeError("Kick action requires semantic " + leg_key + " control")
            target = entity_roots.get(action["targetEntityId"])
            if target is None:
                raise RuntimeError("Kick action requires targetEntityId to resolve a target object")
            angle = math.radians(float(action["angleDegrees"]))
            axis = 1 if is_cutout_rig else 0
            leg.rotation_euler[axis] = 0.0
            leg.keyframe_insert(data_path="rotation_euler", index=axis, frame=start)
            contact_frame = start + min(end - start, int(action["contactFrame"]))
            leg.rotation_euler[axis] = angle
            leg.keyframe_insert(data_path="rotation_euler", index=axis, frame=contact_frame)
            leg.rotation_euler[axis] = 0.0
            leg.keyframe_insert(data_path="rotation_euler", index=axis, frame=end)
            rig = next((obj for obj in bpy.context.scene.objects
                        if obj.type == "ARMATURE"
                        and obj.get("filmie_character_id") == character_id), None)
            collection = rig.users_collection[0] if rig is not None else None
            foot_target = next((obj for obj in collection.objects
                                if obj.name == "IK_foot." + ("L" if action["leg"] == "left" else "R") + ".Target"),
                               None) if collection is not None else None
            if foot_target is None:
                raise RuntimeError("Kick action requires a mapped foot IK target")
            anchor_world = (
                resolve_asset_anchor(target, action["targetAnchorId"])
                if action.get("targetAnchorId")
                else target.matrix_world.translation.copy()
            )
            foot_target.location = (
                foot_target.parent.matrix_world.inverted() @ anchor_world
                if foot_target.parent is not None else anchor_world
            )
            foot_target.keyframe_insert(data_path="location", frame=contact_frame)
            scene.frame_set(contact_frame)
            bpy.context.view_layer.update()
            foot_bone = rig.pose.bones["foot." + ("L" if action["leg"] == "left" else "R")]
            achieved_world = rig.matrix_world @ foot_bone.matrix.translation
            contact_distance = (achieved_world - anchor_world).length
            tolerance = float(action["contactToleranceMeters"])
            if contact_distance > tolerance:
                raise RuntimeError(
                    "Kick contact validation failed at frame %d: foot %.3f m from target"
                    % (contact_frame, contact_distance)
                )
            target.keyframe_insert(data_path="location", frame=contact_frame)
            target.location.x += float(action["targetImpulseMeters"])
            target.keyframe_insert(data_path="location", frame=end)
        elif action["type"] == "celebrate":
            arms = [controls.get("left-arm"), controls.get("right-arm")]
            chest = controls.get("chest")
            if chest is None or any(arm is None for arm in arms):
                raise RuntimeError("Celebration requires semantic arms and chest controls")
            intensity = float(action["intensity"])
            for frame in range(start, end + 1):
                phase = 2.0 * math.pi * (frame - start) / max(2, end - start)
                for side, arm in enumerate(arms):
                    if is_cutout_rig:
                        arm.rotation_euler.y = math.sin(phase) * intensity * (1 if side == 0 else -1)
                        arm.rotation_euler.z = 0.0
                    else:
                        arm.rotation_euler.z = math.sin(phase) * intensity * (1 if side == 0 else -1)
                        arm.rotation_euler.x = -intensity * 0.9
                    arm.keyframe_insert(data_path="rotation_euler", frame=frame)
                axis = 1 if is_cutout_rig else 0
                chest.rotation_euler[axis] = math.sin(phase * 2.0) * intensity * 0.08
                chest.keyframe_insert(data_path="rotation_euler", index=axis, frame=frame)
        elif action["type"] in ("sit", "stand"):
            chest = controls.get("chest")
            legs = [controls.get("left-leg"), controls.get("right-leg")]
            if chest is None or any(leg is None for leg in legs):
                raise RuntimeError("Sit/stand action requires semantic chest and leg controls on " + character_id)
            seated = action["type"] == "sit"
            standing_height = float(chest.location.z)
            chest.keyframe_insert(data_path="location", frame=start)
            chest.location.z = standing_height * (0.82 if seated else 1.0)
            chest.keyframe_insert(data_path="location", frame=min(end, start + int(action["blendFrames"])))
            for side, leg in enumerate(legs):
                leg.rotation_euler.y = (0.35 if seated else 0.0) * (-1 if side else 1)
                leg.keyframe_insert(data_path="rotation_euler", index=1, frame=min(end, start + int(action["blendFrames"])))
        elif action["type"] == "interaction":
            target = entity_roots.get(action["targetEntityId"])
            head = controls.get("head")
            character = entity_roots.get(character_id)
            if head is None or target is None or character is None:
                raise RuntimeError("Look-at interaction needs a semantic head and valid target")
            depsgraph = bpy.context.evaluated_depsgraph_get()
            origin = character.evaluated_get(depsgraph).matrix_world.translation
            destination = target.evaluated_get(depsgraph).matrix_world.translation
            yaw = math.atan2(destination.x - origin.x, -(destination.y - origin.y))
            yaw = max(-math.radians(float(action["maxYawDegrees"])), min(math.radians(float(action["maxYawDegrees"])), yaw))
            head.rotation_euler.z = 0.0
            head.keyframe_insert(data_path="rotation_euler", index=2, frame=start)
            head.rotation_euler.z = yaw
            head.keyframe_insert(data_path="rotation_euler", index=2, frame=end)
        elif action["type"] in ("reach", "grasp", "lift", "place"):
            effector = controls.get(action["effector"])
            target = entity_roots.get(action["targetEntityId"])
            if effector is None or target is None:
                raise RuntimeError("Interaction requires a mapped semantic effector and target entity")
            anchor_world = resolve_asset_anchor(target, action["targetAnchorId"])
            if action["type"] == "reach":
                parent = effector.parent
                if parent is None:
                    raise RuntimeError("Semantic hand control must have a parent rig control")
                scene.frame_set(start)
                bpy.context.view_layer.update()
                effector.keyframe_insert(data_path="location", frame=start)
                scene.frame_set(end)
                bpy.context.view_layer.update()
                depsgraph = bpy.context.evaluated_depsgraph_get()
                target_world = target.evaluated_get(depsgraph).matrix_world
                anchor_world = resolve_asset_anchor(target, action["targetAnchorId"])
                effector.location = parent.matrix_world.inverted() @ anchor_world
                effector.keyframe_insert(data_path="location", frame=end)
                effector.keyframe_insert(data_path="location", frame=end + 1)
                bpy.context.view_layer.update()
            elif action["type"] == "grasp":
                scene.frame_set(start)
                bpy.context.view_layer.update()
                depsgraph = bpy.context.evaluated_depsgraph_get()
                target_world = target.evaluated_get(depsgraph).matrix_world
                anchor_world = resolve_asset_anchor(target, action["targetAnchorId"])
                parent = effector.parent
                if parent is not None:
                    effector.location = parent.matrix_world.inverted() @ anchor_world
                bpy.context.view_layer.update()
                effector.keyframe_insert(data_path="rotation_euler", frame=start)
                effector.rotation_euler.y = -0.25
                effector.keyframe_insert(data_path="rotation_euler", frame=end)
                contact_distance = (effector.matrix_world.translation - anchor_world).length
                if contact_distance > 0.18:
                    raise RuntimeError(
                        "Object grasp contact validation failed: hand is %.3f m from anchor (hand=%s anchor=%s)"
                        % (contact_distance, tuple(round(v, 3) for v in effector.matrix_world.translation), tuple(round(v, 3) for v in anchor_world))
                    )
                world_matrix = target.matrix_world.copy()
                target["filmie_attachment_state"] = "Attached"
                target["filmie_attached_character"] = character_id
                target["filmie_attached_effector"] = action["effector"]
                target["filmie_original_parent"] = target.parent.name if target.parent else ""
                attachment = target.constraints.get("FILMIE Hand Attachment")
                if attachment is None:
                    attachment = target.constraints.new("CHILD_OF")
                    attachment.name = "FILMIE Hand Attachment"
                attachment.influence = 0.0
                attachment.target = effector
                # Child Of evaluates target * inverse * owner; inverse only
                # cancels the target transform (including parent/bone space).
                attachment.inverse_matrix = effector.matrix_world.inverted()
                bpy.context.view_layer.update()
                attachment.influence = 0.0
                attachment.keyframe_insert(data_path="influence", frame=start)
                attachment.influence = 1.0
                attachment.keyframe_insert(data_path="influence", frame=end)
                bpy.context.view_layer.update()
            elif action["type"] == "lift":
                target.keyframe_insert(data_path="location", frame=start)
                target.location.z += float(action["verticalOffset"])
                target.keyframe_insert(data_path="location", frame=end)
                bpy.context.view_layer.update()
                target_anchor = resolve_asset_anchor(target, action["targetAnchorId"])
                parent = effector.parent
                if parent is not None:
                    effector.location = parent.matrix_world.inverted() @ target_anchor
                    effector.keyframe_insert(data_path="location", frame=end)
            else:
                if target.get("filmie_attachment_state") == "Attached":
                    target["filmie_attachment_state"] = "Released"
                attachment = target.constraints.get("FILMIE Hand Attachment")
                if attachment is None or attachment.target != effector:
                    raise RuntimeError("Place requires an object attached to the requested effector")
                scene.frame_set(start)
                bpy.context.view_layer.update()
                parent = effector.parent
                if parent is None:
                    raise RuntimeError("Semantic hand control must have a parent rig control")
                depsgraph = bpy.context.evaluated_depsgraph_get()
                current_hand = effector.evaluated_get(depsgraph).matrix_world.copy()
                current_target = target.evaluated_get(depsgraph).matrix_world.copy()
                relative_transform = current_hand.inverted() @ current_target
                destination = Vector(tuple(
                    float(action["targetPosition"][axis]) for axis in ("x", "y", "z")
                ))
                destination_rotation = (
                    Euler(tuple(
                        math.radians(float(action["targetRotationDegrees"][axis]))
                        for axis in ("x", "y", "z")
                    ))
                    if action.get("targetRotationDegrees") is not None
                    else current_target.to_euler()
                )
                destination_scale = current_target.to_scale()
                destination_transform = (
                    Matrix.Translation(destination)
                    @ destination_rotation.to_matrix().to_4x4()
                    @ Matrix.Diagonal((
                        destination_scale.x,
                        destination_scale.y,
                        destination_scale.z,
                        1.0,
                    ))
                )
                destination_hand = destination_transform @ relative_transform.inverted()
                local_hand = parent.matrix_world.inverted() @ destination_hand
                hand_location, hand_rotation, _hand_scale = local_hand.decompose()
                effector.keyframe_insert(data_path="location", frame=start)
                effector.keyframe_insert(data_path="rotation_euler", frame=start)
                effector.location = hand_location
                effector.rotation_euler = hand_rotation.to_euler()
                effector.keyframe_insert(data_path="location", frame=end)
                effector.keyframe_insert(data_path="rotation_euler", frame=end)

                target_parent = target.parent
                local_target = (
                    target_parent.matrix_world.inverted() @ destination_transform
                    if target_parent is not None
                    else destination_transform
                )
                target_location, target_rotation, target_scale = local_target.decompose()
                target.keyframe_insert(data_path="location", frame=start)
                target.keyframe_insert(data_path="rotation_euler", frame=start)
                target.keyframe_insert(data_path="scale", frame=start)
                if end - 1 > start:
                    target.keyframe_insert(data_path="location", frame=end - 1)
                    target.keyframe_insert(data_path="rotation_euler", frame=end - 1)
                    target.keyframe_insert(data_path="scale", frame=end - 1)
                target.location = target_location
                target.rotation_euler = target_rotation.to_euler()
                target.scale = target_scale
                target.keyframe_insert(data_path="location", frame=end)
                target.keyframe_insert(data_path="rotation_euler", frame=end)
                target.keyframe_insert(data_path="scale", frame=end)
                attachment.influence = 1.0
                attachment.keyframe_insert(data_path="influence", frame=start)
                if end - 1 > start:
                    attachment.keyframe_insert(data_path="influence", frame=end - 1)
                attachment.influence = 0.0
                attachment.keyframe_insert(data_path="influence", frame=end)
        else:
            raise RuntimeError("Unsupported compiled character action: " + action["type"])


def motion_blend(keyframe, progress):
    interpolation = keyframe.get("interpolation", "linear")
    if interpolation == "linear":
        return progress
    if interpolation == "hold":
        return 0.0
    if interpolation == "ease-in":
        return progress * progress
    if interpolation == "ease-out":
        return 1.0 - (1.0 - progress) ** 2
    if interpolation == "ease-in-out":
        return progress * progress * (3.0 - 2.0 * progress)
    if interpolation == "cubic-bezier":
        x1, y1, x2, y2 = keyframe.get("bezier", (0.42, 0.0, 0.58, 1.0))

        def coordinate(t, first, second):
            return 3 * (1 - t) ** 2 * t * first + 3 * (1 - t) * t ** 2 * second + t ** 3

        low, high = 0.0, 1.0
        for _ in range(24):
            mid = (low + high) / 2
            if coordinate(mid, x1, x2) < progress:
                low = mid
            else:
                high = mid
        return coordinate((low + high) / 2, y1, y2)
    raise RuntimeError("Unsupported motion interpolation: " + interpolation)


def apply_motion_curves(spec, control_objects, entity_roots):
    grouped = {}
    for curve in spec.get("motionCurves", []):
        key = (curve["characterId"], curve["control"], curve["channel"])
        grouped.setdefault(key, []).append(curve)
    for key, curves in grouped.items():
        character_id, control_name, channel = key
        blend_modes = {curve.get("blendMode", "replace") for curve in curves}
        if len(blend_modes) > 1:
            raise RuntimeError(
                "Motion curves mix replacement and additive modes for %s/%s/%s"
                % key
            )
        source_frames = [int(curve["frame"]) for curve in curves]
        if len(source_frames) != len(set(source_frames)):
            raise RuntimeError(
                "Overlapping motion curves target the same frame for %s/%s/%s"
                % key
            )
        control = control_objects.get(character_id, {}).get(control_name)
        if control is None and control_name in ("root", "hips"):
            control = entity_roots.get(character_id)
        if control is None:
            raise RuntimeError("Motion clip requires missing semantic control " + control_name)
        curves.sort(key=lambda curve: (
            int(curve["frame"]),
            0 if curve.get("blendMode") == "replace" else 1,
        ))
        property_name = "rotation_euler" if channel == "rotation" else channel
        original = tuple(getattr(control, property_name))
        frames = sorted(set(int(curve["frame"]) + 1 for curve in curves))
        start_frame = frames[0]
        end_frame = frames[-1]
        for frame in range(start_frame, end_frame + 1):
            source_frame = frame - 1
            same_frame = [
                curve for curve in curves
                if int(curve["frame"]) == source_frame
            ]
            if same_frame:
                replace = [curve for curve in same_frame if curve.get("blendMode") == "replace"]
                selected = replace[-1] if replace else same_frame[-1]
                value = tuple(float(component) for component in selected["value"])
            else:
                later = [curve for curve in curves if int(curve["frame"]) >= source_frame]
                prior = [curve for curve in curves if int(curve["frame"]) <= source_frame]
                if later and prior:
                    left = prior[-1]
                    right = later[0]
                    span = max(1, int(right["frame"]) - int(left["frame"]))
                    blend = motion_blend(left, (source_frame - int(left["frame"])) / span)
                    selected = left
                    left_value = tuple(float(component) for component in left["value"])
                    right_value = tuple(float(component) for component in right["value"])
                    value = tuple(a + (b - a) * blend for a, b in zip(left_value, right_value))
                elif prior:
                    selected = prior[-1]
                    value = tuple(float(component) for component in selected["value"])
                else:
                    selected = later[0]
                    value = tuple(float(component) for component in selected["value"])
            if selected.get("blendMode") == "additive":
                value = tuple(base + delta for base, delta in zip(original, value))
            setattr(control, property_name, value)
            control.keyframe_insert(data_path=property_name, frame=frame)


def main():
    spec = read_spec()
    spec.setdefault("renderConfig", {
        "engine": "BLENDER_EEVEE",
        "samples": 4,
        "denoising": False,
        "textures": "high",
        "shadows": "high",
        "compositing": True,
        "frameRate": spec.get("frameRate", {"numerator": 30, "denominator": 1}),
    })
    os.makedirs(os.path.join(spec["outputDirectory"], "frames"), exist_ok=True)
    scene, _environment, entity_roots, control_objects = create_scene(spec)
    apply_actions(spec, entity_roots, control_objects)
    apply_motion_curves(spec, control_objects, entity_roots)
    blend_path = os.path.join(spec["outputDirectory"], "scene.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    frame_dir = os.path.join(spec["outputDirectory"], "frames")
    frame_start = max(1, int(spec.get("frameRange", {}).get("start", 1)))
    frame_end = min(int(spec["durationFrames"]), int(spec.get("frameRange", {}).get("end", spec["durationFrames"])))
    if frame_end < frame_start:
        raise RuntimeError("Worker frame range is empty or reversed")
    chunk_size = max(1, int(spec.get("chunkFrames", 12)))
    rendered = 0
    for chunk_start in range(frame_start, frame_end + 1, chunk_size):
        chunk_end = min(frame_end, chunk_start + chunk_size - 1)
        for frame in range(chunk_start, chunk_end + 1):
            frame_path = os.path.join(frame_dir, "frame_%06d.png" % frame)
            valid = False
            try:
                if os.path.getsize(frame_path) > 24:
                    cached_image = bpy.data.images.load(frame_path, check_existing=False)
                    valid = tuple(cached_image.size) == (int(spec["width"]), int(spec["height"])) and len(cached_image.pixels) > 0
                    bpy.data.images.remove(cached_image)
            except (OSError, RuntimeError):
                valid = False
            if valid:
                continue
            if os.path.exists(frame_path):
                os.remove(frame_path)
            scene.frame_set(frame)
            bpy.context.scene.render.filepath = os.path.join(frame_dir, "frame_%06d" % frame)
            bpy.ops.render.render(write_still=True)
            remove_volatile_png_metadata(frame_path)
            rendered += 1
    result = {
        "status": "success",
        "blenderVersion": bpy.app.version_string,
        "frameCount": frame_end - frame_start + 1,
        "frameStart": frame_start,
        "frameEnd": frame_end,
        "width": int(spec["width"]),
        "height": int(spec["height"]),
        "blendPath": blend_path,
        "engine": bpy.context.scene.render.engine,
        "backend": spec.get("selectedBackend", "unknown"),
        "samples": int(spec["renderConfig"]["samples"]),
        "denoising": bool(spec["renderConfig"].get("denoising", False)),
        "renderedFrames": rendered,
        "metrics": RENDER_METRICS,
    }
    with open(os.path.join(spec["outputDirectory"], "worker-result.json"), "w", encoding="utf-8") as stream:
        json.dump(result, stream, sort_keys=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("FILMIE_WORKER_ERROR: " + str(error), file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        try:
            failed_spec = read_spec()
            output_directory = failed_spec.get("outputDirectory")
            if output_directory:
                os.makedirs(output_directory, exist_ok=True)
                with open(os.path.join(output_directory, "worker-result.json"), "w", encoding="utf-8") as stream:
                    json.dump({"status": "failure", "error": str(error), "metrics": RENDER_METRICS}, stream, sort_keys=True)
        except Exception as receipt_error:
            print("FILMIE_WORKER_FAILURE_RECEIPT_ERROR: " + str(receipt_error), file=sys.stderr)
        sys.exit(1)
