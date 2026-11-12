"""Translate Filmie's visual profiles and surface definitions into Blender nodes."""
import math

import bpy


def image_asset(asset, data=False):
    image = bpy.data.images.load(asset["localPath"], check_existing=False)
    if data:
        image.colorspace_settings.name = "Non-Color"
    image.pack()
    return image


def source(tree, socket, destination):
    if socket.is_linked:
        tree.links.new(socket.links[0].from_socket, destination)
    else:
        destination.default_value = socket.default_value


def build_material(spec):
    material = bpy.data.materials.new(spec["id"])
    material["filmie_surface"] = True
    color = (*spec["color"], 1.0)
    material.diffuse_color = (*spec["color"], spec.get("opacity", 1.0))
    material.roughness = spec["roughness"]
    material.metallic = spec["metallic"]
    material.use_nodes = True
    tree = material.node_tree
    shader = tree.nodes.get("Principled BSDF")
    for socket, value in {
        "Base Color": color,
        "Roughness": spec["roughness"],
        "Metallic": spec["metallic"],
        "Alpha": spec.get("opacity", 1.0),
        "IOR": spec.get("ior", 1.5),
        "Transmission Weight": spec.get("transmission", 0.0),
    }.items():
        shader.inputs[socket].default_value = value
    if spec.get("transmission", 0):
        material.use_raytrace_refraction = True
    if "emission" in spec:
        shader.inputs["Emission Color"].default_value = (*spec["emission"]["color"], 1.0)
        shader.inputs["Emission Strength"].default_value = spec["emission"]["strength"]
    procedural = spec.get("procedural")
    if procedural:
        kind = procedural["kind"]
        pattern = tree.nodes.new("ShaderNodeTexNoise" if kind == "noise" else "ShaderNodeTexChecker")
        coordinates = tree.nodes.new("ShaderNodeTexCoord")
        tree.links.new(coordinates.outputs["Generated"], pattern.inputs["Vector"])
        pattern.inputs["Scale"].default_value = procedural["scale"]
        palette = tree.nodes.new("ShaderNodeMixRGB")
        palette.inputs[1].default_value = color
        palette.inputs[2].default_value = (*procedural["color"], 1.0)
        tree.links.new(pattern.outputs["Fac"], palette.inputs[0])
        tree.links.new(palette.outputs[0], shader.inputs["Base Color"])
    for slot, texture in spec.get("textures", {}).items():
        sampler = tree.nodes.new("ShaderNodeTexImage")
        sampler.image = image_asset(texture["asset"], data=slot != "color")
        sampler.projection = "BOX"
        sampler.projection_blend = 0.15
        coords = tree.nodes.new("ShaderNodeTexCoord")
        vector = tree.nodes.new("ShaderNodeVectorMath")
        vector.operation = "SCALE"
        vector.inputs["Scale"].default_value = texture.get("scale", 1.0)
        tree.links.new(coords.outputs["Generated"], vector.inputs[0])
        tree.links.new(vector.outputs[0], sampler.inputs["Vector"])
        if slot == "color":
            destination = shader.inputs["Base Color"]
            tint = tree.nodes.new("ShaderNodeMixRGB")
            tint.blend_type = "MULTIPLY"
            tint.inputs[0].default_value = 1
            source(tree, destination, tint.inputs[1])
            tree.links.new(sampler.outputs["Color"], tint.inputs[2])
            tree.links.new(tint.outputs[0], destination)
        elif slot == "opacity":
            alpha = tree.nodes.new("ShaderNodeMath")
            alpha.operation = "MULTIPLY"
            alpha.inputs[1].default_value = spec.get("opacity", 1.0)
            tree.links.new(sampler.outputs["Color"], alpha.inputs[0])
            tree.links.new(alpha.outputs[0], shader.inputs["Alpha"])
        else:
            tree.links.new(sampler.outputs["Color"], shader.inputs[slot.title()])
    return material


def apply_material_style(scene, shading, settings):
    if shading not in {"stylized", "cel"}:
        return
    materials = {slot.material for obj in scene.objects for slot in obj.material_slots
                 if slot.material and slot.material.get("filmie_surface")}
    for material in sorted(materials, key=lambda item: item.name):
        tree = material.node_tree
        pbr = tree.nodes.get("Principled BSDF")
        base = pbr.inputs["Base Color"]
        if shading == "stylized":
            tone = tree.nodes.new("ShaderNodeHueSaturation")
            tone.inputs["Saturation"].default_value = settings.get("saturation", 1.45)
            source(tree, base, tone.inputs["Color"])
            tree.links.new(tone.outputs["Color"], base)
            roughness = tree.nodes.new("ShaderNodeMath")
            roughness.operation = "MULTIPLY"
            roughness.use_clamp = True
            roughness.inputs[1].default_value = settings.get("roughnessScale", 0.7)
            source(tree, pbr.inputs["Roughness"], roughness.inputs[0])
            tree.links.new(roughness.outputs[0], pbr.inputs["Roughness"])
            continue
        diffuse = tree.nodes.new("ShaderNodeBsdfDiffuse")
        diffuse.inputs["Color"].default_value = (1, 1, 1, 1)
        light = tree.nodes.new("ShaderNodeShaderToRGB")
        tree.links.new(diffuse.outputs[0], light.inputs[0])
        ramp = tree.nodes.new("ShaderNodeValToRGB")
        ramp.color_ramp.interpolation = "CONSTANT"
        bands = settings.get("celBands", 3)
        for i in range(bands):
            position = i * 0.7 / (bands - 1)
            element = ramp.color_ramp.elements[i] if i < 2 else ramp.color_ramp.elements.new(position)
            element.position = position
            level = 0.24 + 0.76 * i / (bands - 1)
            element.color = (level, level, level, 1)
        tree.links.new(light.outputs[0], ramp.inputs[0])
        tint = tree.nodes.new("ShaderNodeMixRGB")
        tint.blend_type = "MULTIPLY"
        tint.inputs[0].default_value = 1
        source(tree, base, tint.inputs[1])
        tree.links.new(ramp.outputs[0], tint.inputs[2])
        emission = tree.nodes.new("ShaderNodeEmission")
        tree.links.new(tint.outputs[0], emission.inputs["Color"])
        glow = tree.nodes.new("ShaderNodeEmission")
        source(tree, pbr.inputs["Emission Color"], glow.inputs["Color"])
        source(tree, pbr.inputs["Emission Strength"], glow.inputs["Strength"])
        surface = tree.nodes.new("ShaderNodeAddShader")
        tree.links.new(emission.outputs[0], surface.inputs[0])
        tree.links.new(glow.outputs[0], surface.inputs[1])
        opacity = tree.nodes.new("ShaderNodeMixShader")
        source(tree, pbr.inputs["Alpha"], opacity.inputs[0])
        transparent = tree.nodes.new("ShaderNodeBsdfTransparent")
        tree.links.new(transparent.outputs[0], opacity.inputs[1])
        tree.links.new(surface.outputs[0], opacity.inputs[2])
        tree.links.new(opacity.outputs[0], tree.nodes.get("Material Output").inputs["Surface"])


def configure_environment(scene, shading, settings):
    charcoal = shading == "charcoal"
    scene.view_settings.view_transform = "AgX" if shading == "physical" else "Standard"
    scene.view_settings.look = "Medium High Contrast" if charcoal else "None"
    scene.view_settings.exposure = settings.get("exposure", 0.25 if charcoal else 0)
    scene.view_settings.gamma = 1
    scene.world = bpy.data.worlds.new("Filmie Environment")
    environment = settings.get("environment")
    if charcoal and not environment:
        scene.world.color = (0.045, 0.04, 0.035)
        return
    environment = environment or {"kind": "color", "color": (0.24, 0.28, 0.35), "strength": 0.4}
    scene.world.use_nodes = True
    tree = scene.world.node_tree
    background = tree.nodes.get("Background")
    background.inputs["Strength"].default_value = environment["strength"]
    if environment["kind"] == "color":
        background.inputs["Color"].default_value = (*environment["color"], 1)
    else:
        sampler = tree.nodes.new("ShaderNodeTexEnvironment")
        sampler.image = image_asset(environment["asset"])
        coords = tree.nodes.new("ShaderNodeTexCoord")
        rotation = tree.nodes.new("ShaderNodeVectorRotate")
        rotation.rotation_type = "Z_AXIS"
        rotation.inputs["Angle"].default_value = -math.radians(environment.get("rotationDegrees", 0))
        tree.links.new(coords.outputs["Generated"], rotation.inputs["Vector"])
        tree.links.new(rotation.outputs[0], sampler.inputs["Vector"])
        tree.links.new(sampler.outputs["Color"], background.inputs["Color"])
