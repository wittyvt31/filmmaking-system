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
