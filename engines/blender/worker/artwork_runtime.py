"""Small deterministic controls for prepared Blender artwork packages."""

import json


def set_artwork_variant(asset_root, slot_id, variant_id):
    """Select a declared artwork variation on an appended package root."""
    map_key = "filmie_variant_map_" + slot_id
    selection_key = "filmie_variant_" + slot_id
    if map_key not in asset_root or selection_key not in asset_root:
        raise ValueError("Unknown artwork variation slot: " + slot_id)
    variants = json.loads(asset_root[map_key])
    if variant_id not in variants:
        raise ValueError("Unknown artwork variation " + slot_id + "=" + variant_id)
    asset_root[selection_key] = variants.index(variant_id)
    for obj in asset_root.children_recursive:
        if obj.get("filmie_variant_slot") == slot_id:
            obj.hide_render = obj.get("filmie_variant_id") != variant_id
    return variant_id
