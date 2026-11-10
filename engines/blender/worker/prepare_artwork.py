"""Package registered transparent artwork as reusable Blender collections."""

import hashlib
import json
import os
import sys
import tempfile
import traceback
from array import array

import bpy


def read_spec():
    try:
        path = sys.argv[sys.argv.index("--") + 1]
    except (ValueError, IndexError) as exc:
        raise RuntimeError("Expected -- <artwork-build-spec.json>") from exc
    with open(path, "r", encoding="utf-8") as stream:
        return json.load(stream)


def object_transform(obj, transform):
    position = transform["position"]
    rotation = transform["rotationDegrees"]
    obj.location = tuple(float(position[axis]) for axis in ("x", "y", "z"))
    obj.rotation_euler = tuple(float(rotation[axis]) * 0.017453292519943295 for axis in ("x", "y", "z"))
    obj.scale = (float(transform["scale"]),) * 3


def charcoal_material(image, opacity, style, name):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    transparent = nodes.new("ShaderNodeBsdfTransparent")
    mix = nodes.new("ShaderNodeMixShader")
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = image
    bw = nodes.new("ShaderNodeRGBToBW")
    ramp = nodes.new("ShaderNodeValToRGB")
    colors = style["palette"]
    ramp.color_ramp.elements[0].color = (*colors["shadow"], 1.0)
    ramp.color_ramp.elements[1].color = (*colors["paper"], 1.0)
    middle = ramp.color_ramp.elements.new(0.48)
    middle.color = (*colors["graphite"], 1.0)
    alpha = nodes.new("ShaderNodeMath")
    alpha.operation = "MULTIPLY"
    alpha.inputs[1].default_value = float(opacity)
    links.new(texture.outputs["Color"], bw.inputs["Color"])
    links.new(bw.outputs["Val"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], emission.inputs["Color"])
    links.new(texture.outputs["Alpha"], alpha.inputs[0])
    manual_matte = image.get("filmie_matte_image")
    if manual_matte:
        matte = nodes.new("ShaderNodeTexImage")
        matte.image = bpy.data.images.get(manual_matte)
        if matte.image is None:
            raise RuntimeError("Manual matte was not loaded: " + str(manual_matte))
        matte.interpolation = "Linear"
        matte_gray = nodes.new("ShaderNodeRGBToBW")
        matte_alpha = nodes.new("ShaderNodeMath")
        matte_alpha.operation = "MULTIPLY"
        links.new(matte.outputs["Color"], matte_gray.inputs["Color"])
        links.new(matte_gray.outputs["Val"], matte_alpha.inputs[0])
        links.new(matte.outputs["Alpha"], matte_alpha.inputs[1])
        links.new(matte_alpha.outputs["Value"], alpha.inputs[1])
    links.new(alpha.outputs["Value"], mix.inputs[0])
    links.new(transparent.outputs["BSDF"], mix.inputs[1])
    links.new(emission.outputs["Emission"], mix.inputs[2])
    links.new(mix.outputs["Shader"], output.inputs["Surface"])
    material.surface_render_method = "DITHERED"
    return material


def box_blur(source, width, height, radius):
    """Separable box blur for alpha, keeping preparation independent of Pillow/OpenCV."""
    if radius <= 0:
        return source
    horizontal = array("f", [0.0]) * len(source)
    vertical = array("f", [0.0]) * len(source)
    span = radius * 2 + 1
    for y in range(height):
        row = y * width
        for x in range(width):
            total = 0.0
            count = 0
            for sample_x in range(max(0, x - radius), min(width, x + radius + 1)):
                total += source[row + sample_x]
                count += 1
            horizontal[row + x] = total / count
    for y in range(height):
        for x in range(width):
            total = 0.0
            count = 0
            for sample_y in range(max(0, y - radius), min(height, y + radius + 1)):
                total += horizontal[sample_y * width + x]
                count += 1
            vertical[y * width + x] = total / count
    return vertical


def alpha_components(alpha, width, height, threshold):
    """Connected components over thresholded alpha, using compact integer arrays."""
    count = width * height
    labels = array("i", [0]) * count
    component_sizes = [0]
    component_touches_border = [False]
    label = 0
    for start in range(count):
        foreground = alpha[start] >= threshold
        if labels[start] != 0 or not foreground:
            continue
        label += 1
        queue = array("I", [start])
        labels[start] = label
        head = 0
        size = 0
        border = False
        while head < len(queue):
            index = queue[head]
            head += 1
            size += 1
            x = index % width
            y = index // width
            border = border or x == 0 or y == 0 or x == width - 1 or y == height - 1
            for neighbor in (index - 1 if x else -1, index + 1 if x + 1 < width else -1,
                             index - width if y else -1, index + width if y + 1 < height else -1):
                if neighbor >= 0 and labels[neighbor] == 0 and (alpha[neighbor] >= threshold) == foreground:
                    labels[neighbor] = label
                    queue.append(neighbor)
        component_sizes.append(size)
        component_touches_border.append(border)
    return labels, component_sizes, component_touches_border


def prepare_pixels(image, matte_path, processing):
    width, height = int(image.size[0]), int(image.size[1])
    pixels = array("f", [0.0]) * (width * height * 4)
    image.pixels.foreach_get(pixels)
    alpha = array("f", (pixels[index] for index in range(3, len(pixels), 4)))
    if matte_path:
        matte = bpy.data.images.load(matte_path, check_existing=False)
        matte_pixels = array("f", [0.0]) * (int(matte.size[0]) * int(matte.size[1]) * 4)
        matte.pixels.foreach_get(matte_pixels)
        mw, mh = int(matte.size[0]), int(matte.size[1])
        if (mw, mh) != (width, height):
            bpy.data.images.remove(matte)
            raise RuntimeError("Manual matte dimensions must match its source artwork")
        for index in range(width * height):
            m = index * 4
            alpha[index] *= matte_pixels[m + 3] * (sum(matte_pixels[m:m + 3]) / 3.0)
        bpy.data.images.remove(matte)
    threshold = float(processing.get("alphaThreshold", 0.01))
    remove_below = int(processing.get("removeIslandsBelowPixels", 0))
    fill_below = int(processing.get("fillHolesBelowPixels", 0))
    if remove_below or fill_below:
        labels, sizes, borders = alpha_components(alpha, width, height, threshold)
        for index, label in enumerate(labels):
            if label == 0:
                continue
            size = sizes[label]
            if alpha[index] >= threshold and remove_below and size < remove_below:
                alpha[index] = 0.0
            elif alpha[index] < threshold and fill_below and not borders[label] and size < fill_below:
                alpha[index] = 1.0
    smoothing = int(processing.get("smoothingPasses", 0))
    for _ in range(smoothing):
        alpha = box_blur(alpha, width, height, 1)
    feather = int(processing.get("featherPixels", 0))
    if feather:
        alpha = box_blur(alpha, width, height, feather)
    if processing.get("decontaminateEdges"):
        original_alpha = array("f", alpha)
        for y in range(height):
            for x in range(width):
                index = y * width + x
                if not (threshold < alpha[index] < 0.98):
                    continue
                r = g = b = n = 0.0
                for ny in range(max(0, y - 1), min(height, y + 2)):
                    for nx in range(max(0, x - 1), min(width, x + 2)):
                        neighbor = ny * width + nx
                        if original_alpha[neighbor] >= 0.98:
                            p = neighbor * 4
                            r += pixels[p]; g += pixels[p + 1]; b += pixels[p + 2]; n += 1
                if n:
                    p = index * 4
                    pixels[p] = r / n; pixels[p + 1] = g / n; pixels[p + 2] = b / n
    nonzero = [index for index, value in enumerate(alpha) if value >= threshold]
    if nonzero:
        bounds = [min(i % width for i in nonzero), min(i // width for i in nonzero),
                  max(i % width for i in nonzero) + 1, max(i // width for i in nonzero) + 1]
    else:
        bounds = [0, 0, 0, 0]
    for index, value in enumerate(alpha):
        pixels[index * 4 + 3] = max(0.0, min(1.0, value))
    image.pixels.foreach_set(pixels)
    image.update()
    return {"width": width, "height": height, "alphaCoverage": len(nonzero) / max(1, width * height), "alphaBounds": bounds}


def create_layer(layer, collection, parent, style, variant_values):
    path = layer["source"]["localPath"]
    if not os.path.isfile(path):
        raise RuntimeError("Artwork source does not exist: " + path)
    image = bpy.data.images.load(path, check_existing=False)
    if image.size[0] <= 0 or image.size[1] <= 0:
        raise RuntimeError("Artwork source has invalid dimensions: " + path)
    if image.size[0] > 8192 or image.size[1] > 8192:
        raise RuntimeError("Artwork source exceeds the 8192-pixel preparation limit: " + path)
    if image.channels != 4 and not layer.get("manualMatte"):
        bpy.data.images.remove(image)
        raise RuntimeError("Artwork source must be RGBA PNG with transparency: " + path)
    matte = layer.get("manualMatte")
    processing = layer.get("processing", {})
    if matte or any(processing.get(key) for key in (
        "featherPixels", "smoothingPasses", "fillHolesBelowPixels",
        "removeIslandsBelowPixels", "decontaminateEdges",
    )):
        report = prepare_pixels(image, matte["localPath"] if matte else None, processing)
        if report["alphaCoverage"] == 0:
            raise RuntimeError("Prepared artwork layer is empty: " + layer["id"])
        with tempfile.TemporaryDirectory() as temporary:
            image.filepath_raw = os.path.join(temporary, "prepared.png")
            image.file_format = "PNG"
            image.save()
            image.pack()
    else:
        image.pack()
    image.filepath = "//embedded/" + layer["id"] + ".png" if matte else "//embedded/" + layer["source"]["contentHash"] + ".png"
    width = float(layer["size"]["width"])
    height = float(layer["size"]["height"])
    pivot = layer["pivot"]
    mesh = bpy.data.meshes.new("Mesh__" + layer["id"])
    mesh.from_pydata(
        [
            (-pivot["x"] * width, 0.0, -pivot["y"] * height),
            ((1.0 - pivot["x"]) * width, 0.0, -pivot["y"] * height),
            ((1.0 - pivot["x"]) * width, 0.0, (1.0 - pivot["y"]) * height),
            (-pivot["x"] * width, 0.0, (1.0 - pivot["y"]) * height),
        ],
        [],
        [(0, 1, 2, 3)],
    )
    mesh.update()
    uv = mesh.uv_layers.new(name="ArtworkUV")
    for loop, coordinate in zip(uv.data, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop.uv = coordinate
    sprite = bpy.data.objects.new("SPRITE__" + layer["id"], mesh)
    collection.objects.link(sprite)
    sprite.data.materials.append(charcoal_material(image, layer["opacity"], style, "Material__" + layer["id"]))
    sprite.parent = parent
    sprite["filmie_layer_id"] = layer["id"]
    sprite["filmie_order"] = int(layer["order"])
    if matte:
        sprite["filmie_prepared_matte"] = True
        sprite["filmie_opacity"] = float(layer["opacity"])
    sprite["filmie_source_hash"] = layer["source"]["contentHash"]
    parent["filmie_pivot"] = json.dumps(pivot, sort_keys=True)
    parent["filmie_layer_id"] = layer["id"]
    parent["filmie_order"] = int(layer["order"])
    source = layer["source"]
    parent["filmie_source_asset"] = source["assetId"] + "@" + source["version"]
    parent["filmie_source_hash"] = source["contentHash"]
    if layer.get("variantSlot"):
        slot = layer["variantSlot"]
        variant_id = layer["variantId"]
        variant_index = variant_values[slot]["index"][variant_id]
        sprite["filmie_variant_slot"] = slot
        sprite["filmie_variant_id"] = variant_id
        sprite.hide_render = variant_index != int(variant_values[slot]["root"]["filmie_variant_" + slot])


def build_asset(asset, output_directory, style):
    collection_name = "ASSET__" + asset["assetId"].replace(".", "_").replace("-", "_")
    collection = bpy.data.collections.new(collection_name)
    bpy.context.scene.collection.children.link(collection)
    root = bpy.data.objects.new("ASSET_ROOT__" + asset["assetId"], None)
    collection.objects.link(root)
    root.empty_display_type = "PLAIN_AXES"
    root["filmie_asset_id"] = asset["assetId"]
    root["filmie_asset_version"] = asset["version"]
    root["filmie_asset_kind"] = asset["kind"]
    root["filmie_display_name"] = asset["displayName"]
    root["filmie_anchors"] = json.dumps({
        anchor["id"]: [float(anchor["position"][axis]) for axis in ("x", "y", "z")]
        for anchor in asset["anchors"]
    }, separators=(",", ":"))
    root["filmie_semantic_controls"] = json.dumps(
        asset.get("semanticControls", {}), separators=(",", ":")
    )
    nodes = {root.name: root}
    node_ids = {"$root": root}
    for group in asset["groups"]:
        obj = bpy.data.objects.new("GROUP__" + group["id"], None)
        collection.objects.link(obj)
        obj.empty_display_type = "PLAIN_AXES"
        obj["filmie_node_id"] = group["id"]
        node_ids[group["id"]] = obj
        nodes[group["id"]] = obj
    for layer in asset["layers"]:
        obj = bpy.data.objects.new("PIVOT__" + layer["id"], None)
        collection.objects.link(obj)
        obj.empty_display_type = "CIRCLE"
        obj["filmie_node_id"] = layer["id"]
        node_ids[layer["id"]] = obj
        nodes[layer["id"]] = obj
    # Parent before assigning local transforms so the spec remains local-space deterministic.
    for group in asset["groups"]:
        obj = node_ids[group["id"]]
        obj.parent = node_ids.get(group.get("parentId"), root)
        object_transform(obj, group["transform"])
    for layer in asset["layers"]:
        obj = node_ids[layer["id"]]
        obj.parent = node_ids.get(layer.get("parentId"), root)
        object_transform(obj, layer["transform"])
        # Keep declared draw order visible to EEVEE's depth buffer even when
        # two artwork planes share the same authored depth.
        obj.location.y -= int(layer["order"]) * 0.001
    variant_values = {}
    for slot in asset["variantSlots"]:
        variants = [variant["id"] for variant in slot["variants"]]
        variant_values[slot["id"]] = {"root": root, "index": {value: index for index, value in enumerate(variants)}}
        root["filmie_variant_" + slot["id"]] = variants.index(slot["defaultVariant"])
        root["filmie_variant_map_" + slot["id"]] = json.dumps(variants, separators=(",", ":"))
    for layer in sorted(asset["layers"], key=lambda item: (item["order"], item["id"])):
        create_layer(layer, collection, node_ids[layer["id"]], style, variant_values)
    for control, node_id in asset.get("semanticControls", {}).items():
        control_object = node_ids[node_id]
        control_object["filmie_control_id"] = control
        control_object["filmie_semantic_id"] = control
    for anchor in asset["anchors"]:
        obj = bpy.data.objects.new("ANCHOR__" + anchor["id"], None)
        collection.objects.link(obj)
        obj.parent = node_ids[anchor["parentId"]]
        obj.location = tuple(float(anchor["position"][axis]) for axis in ("x", "y", "z"))
        obj.empty_display_type = "SPHERE"
        obj.empty_display_size = 0.04
        obj["filmie_anchor_id"] = anchor["id"]
    output_path = os.path.join(output_directory, asset["assetId"], asset["version"], "asset.blend")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.data.libraries.write(output_path, {collection}, fake_user=True, compress=True)
    with open(output_path, "rb") as stream:
        digest = hashlib.sha256(stream.read()).hexdigest()
    return {"assetId": asset["assetId"], "version": asset["version"], "kind": asset["kind"], "displayName": asset["displayName"], "sourcePath": output_path, "collection": collection_name, "sha256": digest, "bytes": os.path.getsize(output_path)}


def main():
    spec = read_spec()
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for collection in list(bpy.data.collections):
        bpy.data.collections.remove(collection)
    os.makedirs(spec["outputDirectory"], exist_ok=True)
    results = [build_asset(asset, spec["outputDirectory"], spec["style"]) for asset in sorted(spec["assets"], key=lambda value: value["assetId"])]
    with open(os.path.join(spec["outputDirectory"], "worker-result.json"), "w", encoding="utf-8") as stream:
        json.dump({"status": "success", "assets": results}, stream, sort_keys=True)


try:
    main()
except Exception as error:
    print("FILMIE_ARTWORK_WORKER_ERROR: " + str(error), file=sys.stderr)
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)
