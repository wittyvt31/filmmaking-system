"""Fixed Blender worker. It accepts JSON data and never evaluates manifest code."""

import json
import math
import os
import random
import sys
import traceback
import struct

import bpy
from mathutils import Euler, Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from world_builder import build_world
from character_runtime import apply_poses, prepare_character
from semantic_rig import RigCapabilityError, discover_controls, foot_ik, preflight_actions

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

def instantiate_asset(asset, transform, entity_id, parent_collection=None, root_marker=None):
    """Append one immutable Blender model collection and apply its scene transform."""
    collection_name = asset.get("metadata", {}).get("blenderCollection")
    if not collection_name:
        raise RuntimeError(
            "Scene assets must be prepared Blender model collections: " + asset["assetId"]
        )
    with bpy.data.libraries.load(asset["localPath"], link=False) as (source, destination):
        if collection_name not in source.collections:
            raise RuntimeError(
                "Generated asset collection is missing: " + collection_name
            )
        destination.collections = [collection_name]
    collection = destination.collections[0]
    if collection is None:
        raise RuntimeError("Blender could not append asset collection " + collection_name)
    if parent_collection is None:
        parent_collection = bpy.context.scene.collection
    parent_collection.children.link(collection)
    root = next(
        (obj for obj in collection.all_objects if obj.get("filmie_asset_id") == asset["assetId"]
         or (root_marker and obj.get(root_marker))),
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
    for armature in collection.all_objects:
        if armature.type == "ARMATURE":
            armature["filmie_character_id"] = entity_id
    return root, discover_controls(collection, asset["metadata"], entity_id)

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

    world_entities = {}
    if "world" in spec:
        world = build_world(scene, spec["world"], instantiate_asset, spec.get("worldCache"))
        world_entities = {obj["filmie_entity_id"]: obj for obj in world.all_objects if obj.get("filmie_entity_id")}
    else:
        instantiate_asset(
            spec["environment"],
            {"position": {"x": 0.0, "y": 0.0, "z": 0.0},
             "rotationDegrees": {"x": 0.0, "y": 0.0, "z": 0.0}, "scale": 1.0},
            "Environment",
        )
    initial_focal_length = float(spec["cameraKeyframes"][0].get("focalLength", 50.0))
    entity_roots = {}
    control_objects = {}
    scene["filmie_character_cache_hits"] = 0
    for character in spec["characters"]:
        if "source" in character:
            root, rig, cache_hit = prepare_character(scene, character, instantiate_asset, world_entities)
            apply_poses(character, root, rig, action_fcurves)
            entity_roots[character["id"]] = root
            scene["filmie_character_cache_hits"] += int(cache_hit)
            continue
        root, controls = instantiate_asset(
            character["asset"], character["transform"], character["id"]
        )
        entity_roots[character["id"]] = root
        control_objects[character["id"]] = controls
    for prop in spec["props"]:
        root, controls = instantiate_asset(
            prop["asset"], prop["transform"], prop["id"]
        )
        entity_roots[prop["id"]] = root
        control_objects[prop["id"]] = controls

    for track in spec.get("objectMotion", []):
        object_id = track["objectId"]
        root = world_entities.get(object_id) or entity_roots[object_id]
        root.rotation_mode = "QUATERNION"
        previous_rotation = None
        for frame, pose in enumerate(track["poses"], start=1):
            root.location = pose["position"]
            rotation = pose["rotation"]
            if previous_rotation and sum(a * b for a, b in zip(previous_rotation, rotation)) < 0:
                rotation = [-value for value in rotation]
            root.rotation_quaternion = rotation
            previous_rotation = rotation
            root.keyframe_insert(data_path="location", frame=frame)
            root.keyframe_insert(data_path="rotation_quaternion", frame=frame)
        for curve in action_fcurves(root.animation_data.action):
            for point in curve.keyframe_points:
                point.interpolation = "LINEAR"

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
    scene.frame_set(1)
    return scene, entity_roots, control_objects

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
    action_priority = {
        "walk": 0, "run": 0, "jump": 0,
        "breathing": 1, "head-turn": 1, "blink": 1, "expression": 1,
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
        start = int(action["startFrame"]) + 1
        end = int(action["endFrame"])
        if action["type"] == "breathing":
            chest = controls.get("chest")
            if chest is None:
                raise RuntimeError("Breathing requires a semantic chest control on " + character_id)
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
                raise RuntimeError("Head turn needs a semantic head control and a valid target entity")
            depsgraph = bpy.context.evaluated_depsgraph_get()
            target_position = target.evaluated_get(depsgraph).matrix_world.translation
            local_target = character.evaluated_get(depsgraph).matrix_world.inverted() @ target_position
            direction = math.atan2(local_target.x, -local_target.y)
            limit = math.radians(float(action["maxYawDegrees"]))
            yaw = max(-limit, min(limit, direction))
            base_yaw = head.rotation_euler.z
            head.keyframe_insert(data_path="rotation_euler", index=2, frame=start)
            head.rotation_euler.z = base_yaw + yaw
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
                axis = 0
                brow.rotation_euler[axis] = 0.0
                brow.keyframe_insert(data_path="rotation_euler", index=axis, frame=start)
                brow.rotation_euler[axis] = angle
                brow.keyframe_insert(data_path="rotation_euler", index=axis, frame=end)
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
            feet = [foot_ik(character_root, controls, side)[1] for side in ("left", "right")]
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
                    foot_target = feet[side]
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
            axis = 0
            leg.rotation_euler[axis] = 0.0
            leg.keyframe_insert(data_path="rotation_euler", index=axis, frame=start)
            contact_frame = start + min(end - start, int(action["contactFrame"]))
            leg.rotation_euler[axis] = angle
            leg.keyframe_insert(data_path="rotation_euler", index=axis, frame=contact_frame)
            leg.rotation_euler[axis] = 0.0
            leg.keyframe_insert(data_path="rotation_euler", index=axis, frame=end)
            rig, foot_target, foot_bone_name = foot_ik(character_root, controls, action["leg"])
            if rig is None or foot_target is None:
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
            foot_bone = rig.pose.bones[foot_bone_name]
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
                axis = 0
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
    scene, entity_roots, control_objects = create_scene(spec)
    preflight_actions(spec, entity_roots, control_objects)
    try:
        apply_actions(spec, entity_roots, control_objects)
        apply_motion_curves(spec, control_objects, entity_roots)
    except RuntimeError as error:
        raise RigCapabilityError("Could not prepare semantic animation: " + str(error)) from error
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
        "worldCacheHit": scene.get("filmie_world_cache_hit", False),
        "characterCacheHits": scene["filmie_character_cache_hits"],
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
                    result = {"status": "failure", "error": str(error), "metrics": RENDER_METRICS}
                    if isinstance(error, RigCapabilityError):
                        result["errorCode"] = "INVALID_INSTRUCTIONS"
                    json.dump(result, stream, sort_keys=True)
        except Exception as receipt_error:
            print("FILMIE_WORKER_FAILURE_RECEIPT_ERROR: " + str(receipt_error), file=sys.stderr)
        sys.exit(1)
