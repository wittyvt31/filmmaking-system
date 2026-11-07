"""Fixed Blender worker. It accepts JSON data and never evaluates manifest code."""

import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector


def read_spec():
    try:
        separator = sys.argv.index("--")
        spec_path = sys.argv[separator + 1]
    except (ValueError, IndexError) as exc:
        raise RuntimeError("Expected -- <worker-spec.json>") from exc
    with open(spec_path, "r", encoding="utf-8") as stream:
        return json.load(stream)


def color_material(image, style, name):
    material = bpy.data.materials.new(name)
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Roughness"].default_value = 1.0
    emission = nodes.new("ShaderNodeEmission")
    illumination_mix = nodes.new("ShaderNodeMixShader")
    illumination_mix.inputs[0].default_value = float(style["lighting"]["ambientFill"])

    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    bw = nodes.new("ShaderNodeRGBToBW")
    ramp = nodes.new("ShaderNodeValToRGB")
    palette = ramp.color_ramp
    palette.elements[0].position = 0.0
    palette.elements[0].color = (*style["palette"]["shadow"], 1.0)
    palette.elements[1].position = 1.0
    palette.elements[1].color = (*style["palette"]["paper"], 1.0)
    middle = palette.elements.new(0.48)
    middle.color = (*style["palette"]["graphite"], 1.0)

    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = float(style["grainScale"])
    noise.inputs["Detail"].default_value = 2.0
    multiply = nodes.new("ShaderNodeMixRGB")
    multiply.blend_type = "MULTIPLY"
    multiply.inputs[0].default_value = float(style["grainStrength"])

    uv = nodes.new("ShaderNodeTexCoord")
    links.new(uv.outputs["UV"], texture.inputs["Vector"])
    links.new(uv.outputs["UV"], noise.inputs["Vector"])
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
    mix_shader = nodes.new("ShaderNodeMixShader")
    links.new(shade.outputs["Color"], shader.inputs["Base Color"])
    links.new(shade.outputs["Color"], emission.inputs["Color"])
    links.new(shader.outputs["BSDF"], illumination_mix.inputs[1])
    links.new(emission.outputs["Emission"], illumination_mix.inputs[2])
    links.new(texture.outputs["Alpha"], mix_shader.inputs[0])
    links.new(transparent.outputs["BSDF"], mix_shader.inputs[1])
    links.new(illumination_mix.outputs["Shader"], mix_shader.inputs[2])
    links.new(mix_shader.outputs["Shader"], output.inputs["Surface"])
    material.surface_render_method = "DITHERED"
    return material


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
    obj.data.materials.append(color_material(image, style, name + "Charcoal"))
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
    controls = {
        obj.get("filmie_semantic_id", obj.get("filmie_control_id", obj.name)): obj
        for obj in collection.objects
        if obj.get("filmie_control_id") or obj.name.startswith("RIG_")
    }
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
    links.new(uv.outputs["UV"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], ramp.inputs["Value"])
    links.new(ramp.outputs["Result"], mix.inputs[0])
    links.new(transparent.outputs["BSDF"], mix.inputs[1])
    links.new(emission.outputs["Emission"], mix.inputs[2])
    links.new(mix.outputs["Shader"], output.inputs["Surface"])
    material.surface_render_method = "DITHERED"
    obj.data.materials.append(material)
    return obj


def create_scene(spec):
    scene = bpy.context.scene
    for obj in list(scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    scene.render.engine = "BLENDER_EEVEE"
    scene.eevee.taa_render_samples = int(spec["samples"])
    scene.render.resolution_x = int(spec["width"])
    scene.render.resolution_y = int(spec["height"])
    scene.render.resolution_percentage = 100
    scene.render.fps = int(spec["frameRate"]["numerator"])
    scene.render.fps_base = float(spec["frameRate"]["denominator"])
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

    key_data = bpy.data.lights.new("Soft Sepia Key", type="AREA")
    key_data.energy = float(spec["style"]["lighting"]["keyEnergy"])
    key_data.shape = "DISK"
    key_data.size = float(spec["style"]["lighting"]["keySize"])
    key_data.color = tuple(float(value) for value in spec["style"]["lighting"]["keyColor"])
    key = bpy.data.objects.new("Soft Sepia Key", key_data)
    scene.collection.objects.link(key)
    key_position = spec["style"]["lighting"]["keyPosition"]
    key.location = tuple(float(value) for value in key_position)
    key.rotation_euler = (Vector((0.0, 0.0, 0.0)) - key.location).to_track_quat("-Z", "Y").to_euler()

    fill_data = bpy.data.lights.new("Graphite bounce fill", type="AREA")
    fill_data.energy = float(spec["style"]["lighting"]["keyEnergy"]) * 0.38
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

    environment, _ = instantiate_asset(
        spec["environment"],
        {"position": {"x": 0.0, "y": 0.0, "z": 0.0},
         "rotationDegrees": {"x": 0.0, "y": 0.0, "z": 0.0}, "scale": 1.0},
        spec["style"],
        "Environment",
    )
    environment_collection = spec["environment"].get("metadata", {}).get("blenderCollection")
    if not environment_collection:
        image = bpy.data.images.load(spec["environment"]["localPath"], check_existing=True)
        aspect = image.size[0] / image.size[1]
        view_height = (
            float(spec["camera"]["fromDistance"])
            * 36.0
            / float(camera_data_lens := 50.0)
            * float(spec["height"])
            / float(spec["width"])
        )
        image.pack()
        environment.scale = (view_height * 1.04 / 2.0, view_height * 1.04 / 2.0, 1.0)
    else:
        camera_data_lens = 50.0
    create_haze_plane(spec, float(spec["camera"]["fromDistance"]))
    entity_roots = {}
    control_objects = {}
    # Add authored scene layers as separate planes. Their depth controls parallax.
    for layer in spec["layers"]:
        root, controls = instantiate_asset(
            layer["asset"],
            layer["transform"],
            spec["style"],
            layer["id"],
        )
        entity_roots[layer["id"]] = root
        control_objects[layer["id"]] = controls
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
    camera_data.lens = camera_data_lens
    camera = bpy.data.objects.new("Cinematic Camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    target = Vector((
        float(spec["camera"]["target"]["x"]),
        float(spec["camera"]["target"]["y"]),
        float(spec["camera"]["target"]["z"]),
    ))
    for keyframe in spec["cameraKeyframes"]:
        frame = int(keyframe["frame"])
        distance = float(keyframe["distance"])
        camera.location = (target.x, target.y - distance, target.z)
        camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.keyframe_insert(data_path="location", frame=frame)
        camera.keyframe_insert(data_path="rotation_euler", frame=frame)
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


def apply_actions(spec, entity_roots, control_objects):
    if spec.get("animationLibraryVersion") != "1.0.0":
        raise RuntimeError("Unsupported semantic animation library version: " + str(spec.get("animationLibraryVersion")))
    scene = bpy.context.scene
    bind_authoritative_rig(control_objects)
    for instruction in sorted(
        spec["actions"],
        key=lambda item: (item["interval"]["startFrame"], item["characterId"], item["action"]["id"]),
    ):
        character_id = instruction["characterId"]
        action = instruction["action"]
        if action["type"] == "motion-clip":
            continue
        controls = control_objects.get(character_id, {})
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
                brow.rotation_euler.x = 0.0
                brow.keyframe_insert(data_path="rotation_euler", index=0, frame=start)
                brow.rotation_euler.x = angle
                brow.keyframe_insert(data_path="rotation_euler", index=0, frame=end)
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
            leg.rotation_euler.x = 0.0
            leg.keyframe_insert(data_path="rotation_euler", index=0, frame=start)
            contact_frame = start + min(end - start, int(action["contactFrame"]))
            leg.rotation_euler.x = angle
            leg.keyframe_insert(data_path="rotation_euler", index=0, frame=contact_frame)
            leg.rotation_euler.x = 0.0
            leg.keyframe_insert(data_path="rotation_euler", index=0, frame=end)
            rig = next((obj for obj in bpy.context.scene.objects
                        if obj.type == "ARMATURE"
                        and obj.get("filmie_character_id") == character_id), None)
            collection = rig.users_collection[0] if rig is not None else None
            foot_target = next((obj for obj in collection.objects
                                if obj.name == "IK_foot." + ("L" if action["leg"] == "left" else "R") + ".Target"),
                               None) if collection is not None else None
            if foot_target is None:
                raise RuntimeError("Kick action requires a mapped foot IK target")
            anchor_world = target.matrix_world.translation
            if action.get("targetAnchorId"):
                anchors = json.loads(target.get("filmie_anchors", "{}"))
                anchor = anchors.get(action["targetAnchorId"])
                if anchor is None:
                    raise RuntimeError("Kick target does not define targetAnchorId " + action["targetAnchorId"])
                anchor_world = target.matrix_world @ Vector(anchor)
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
                    arm.rotation_euler.z = math.sin(phase) * intensity * (1 if side == 0 else -1)
                    arm.rotation_euler.x = -intensity * 0.9
                    arm.keyframe_insert(data_path="rotation_euler", frame=frame)
                chest.rotation_euler.x = math.sin(phase * 2.0) * intensity * 0.08
                chest.keyframe_insert(data_path="rotation_euler", index=0, frame=frame)
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
            try:
                anchors = json.loads(target.get("filmie_anchors", "{}"))
            except (TypeError, json.JSONDecodeError) as error:
                raise RuntimeError("Target asset has malformed anchor metadata") from error
            anchor = anchors.get(action["targetAnchorId"])
            if anchor is None:
                raise RuntimeError("Target asset does not define anchor " + action["targetAnchorId"])
            anchor_world = target.matrix_world @ Vector(anchor)
            if action["type"] == "reach":
                parent = effector.parent
                if parent is None:
                    raise RuntimeError("Semantic hand control must have a parent rig control")
                start_world = effector.matrix_world.copy()
                effector.matrix_world = start_world
                effector.keyframe_insert(data_path="location", frame=start)
                effector.location = parent.matrix_world.inverted() @ anchor_world
                bpy.context.view_layer.update()
                effector.keyframe_insert(data_path="location", frame=end)
                effector.keyframe_insert(data_path="location", frame=end + 1)
                scene.frame_set(end)
                bpy.context.view_layer.update()
            elif action["type"] == "grasp":
                scene.frame_set(start)
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
                target.parent = effector
                target.matrix_world = world_matrix
                target.keyframe_insert(data_path="location", frame=end)
                target.keyframe_insert(data_path="rotation_euler", frame=end)
            elif action["type"] == "lift":
                target.keyframe_insert(data_path="location", frame=start)
                target.location.z += float(action["verticalOffset"])
                target.keyframe_insert(data_path="location", frame=end)
                bpy.context.view_layer.update()
                target_anchor = target.matrix_world @ Vector(anchor)
                parent = effector.parent
                if parent is not None:
                    effector.location = parent.matrix_world.inverted() @ target_anchor
                    effector.keyframe_insert(data_path="location", frame=end)
            else:
                if target.get("filmie_attachment_state") == "Attached":
                    target_matrix = target.matrix_world.copy()
                    target.parent = None
                    target.matrix_world = target_matrix
                    target["filmie_attachment_state"] = "Released"
                target.keyframe_insert(data_path="location", frame=start)
                target.location = tuple(float(action["targetPosition"][axis]) for axis in ("x", "y", "z"))
                target.keyframe_insert(data_path="location", frame=end)
                bpy.context.view_layer.update()
                target_anchor = target.matrix_world @ Vector(anchor)
                parent = effector.parent
                if parent is not None:
                    effector.location = parent.matrix_world.inverted() @ target_anchor
                    effector.keyframe_insert(data_path="location", frame=end)
        else:
            raise RuntimeError("Unsupported compiled character action: " + action["type"])


def apply_motion_curves(spec, control_objects, entity_roots):
    grouped = {}
    for curve in spec.get("motionCurves", []):
        key = (curve["characterId"], curve["control"], curve["channel"])
        grouped.setdefault(key, []).append(curve)
    for key, curves in grouped.items():
        character_id, control_name, channel = key
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
                    blend = (source_frame - int(left["frame"])) / span
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
    os.makedirs(os.path.join(spec["outputDirectory"], "frames"), exist_ok=True)
    scene, _environment, entity_roots, control_objects = create_scene(spec)
    apply_actions(spec, entity_roots, control_objects)
    apply_motion_curves(spec, control_objects, entity_roots)
    blend_path = os.path.join(spec["outputDirectory"], "scene.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)
    bpy.ops.render.render(animation=True)
    result = {
        "status": "success",
        "frameCount": int(spec["durationFrames"]),
        "width": int(spec["width"]),
        "height": int(spec["height"]),
        "blendPath": blend_path,
    }
    with open(os.path.join(spec["outputDirectory"], "worker-result.json"), "w", encoding="utf-8") as stream:
        json.dump(result, stream, sort_keys=True)


try:
    main()
except Exception as error:
    print("FILMIE_WORKER_ERROR: " + str(error), file=sys.stderr)
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)
