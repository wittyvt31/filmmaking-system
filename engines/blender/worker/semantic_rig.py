"""Discover semantic rig capabilities from Blender data and preflight action tracks."""
import re


class RigCapabilityError(RuntimeError):
    pass


# Older prepared assets wrote these values into filmie_control_id. They are
# serialized identifiers, independent of Blender's object names and suffixes.
CONTROL_ALIASES = {
    "RIG_chest": "chest", "RIG_head": "head",
    "RIG_arm.L": "left-arm", "RIG_arm.R": "right-arm",
    "RIG_leg.L": "left-leg", "RIG_leg.R": "right-leg",
    "RIG_brow.L": "left-brow", "RIG_brow.R": "right-brow",
    "RIG_eye.L": "left-eye", "RIG_eye.R": "right-eye",
    "RIG_hand.L": "left-hand", "RIG_hand.R": "right-hand",
}
ACTION_CONTROLS = {
    "breathing": ("chest",), "head-turn": ("head",),
    "blink": ("left-eye", "right-eye"), "expression": ("left-brow", "right-brow"),
    "lip-sync": ("mouth",), "walk": ("left-leg", "right-leg"),
    "run": ("left-leg", "right-leg"), "jump": (), "kick": (),
    "celebrate": ("chest", "left-arm", "right-arm"),
    "sit": ("chest", "left-leg", "right-leg"), "stand": ("chest", "left-leg", "right-leg"),
    "interaction": ("head",), "reach": (), "grasp": (), "lift": (), "place": (),
    "motion-clip": (),
}


def discover_controls(collection, metadata, entity_id):
    tagged = {}
    for obj in collection.all_objects:
        tag = obj.get("filmie_control_id")
        if not isinstance(tag, str) or not tag:
            continue
        if tag in tagged:
            raise RigCapabilityError(f'Character "{entity_id}" has duplicate control tag "{tag}".')
        tagged[tag] = obj
    controls = {}
    for tag, obj in tagged.items():
        semantic = CONTROL_ALIASES.get(tag, tag)
        if semantic in controls:
            raise RigCapabilityError(f'Character "{entity_id}" has ambiguous semantic control "{semantic}".')
        controls[semantic] = obj
    bindings = metadata.get("semanticControls", {})
    if not isinstance(bindings, dict):
        raise RigCapabilityError(f'Character "{entity_id}" has invalid semanticControls metadata.')
    for semantic, tag in bindings.items():
        if not isinstance(tag, str) or tag not in tagged:
            raise RigCapabilityError(
                f'Character "{entity_id}" maps "{semantic}" to missing control tag "{tag}". '
                'Map semanticControls to a filmie_control_id in the Blender collection.'
            )
        controls[semantic] = tagged[tag]
    return controls


def foot_ik(root, controls, side):
    armatures = [obj for obj in root.children_recursive if obj.type == "ARMATURE"]
    bone = "foot." + ("L" if side == "left" else "R")
    rig = next((obj for obj in armatures if bone in obj.pose.bones), None)
    target = controls.get(side + "-foot-ik")
    if target is None and rig is not None and rig.get("filmie_rig_type") == "humanoid-semantic-v1":
        # Compatibility with older rigs that explicitly opt into the legacy IK layout.
        legacy = "IK_" + bone + ".Target"
        target = next((obj for obj in root.children_recursive
                       if re.sub(r"\.\d{3}$", "", obj.name) == legacy), None)
    return rig, target, bone


def preflight_actions(spec, roots, controls_by_entity):
    def require(character, label, names):
        controls = controls_by_entity.get(character, {})
        missing = [name for name in names if name not in controls]
        if missing:
            raise RigCapabilityError(
                f'{label} on character "{character}" requires semantic control(s): {", ".join(missing)}. '
                'Add the corresponding filmie_control_id tags to the prepared Blender rig.'
            )
        return controls

    for instruction in spec["actions"]:
        action = instruction["action"]
        character = instruction["characterId"]
        label = f'Action "{action["id"]}" ({action["type"]})'
        kind = action["type"]
        if kind not in ACTION_CONTROLS:
            raise RigCapabilityError(f'{label} is unsupported by the Blender worker.')
        if character not in roots or character not in controls_by_entity:
            raise RigCapabilityError(f'{label} requires a character with a semantic rig.')
        target = action.get("targetEntityId")
        if target is not None and target not in roots:
            raise RigCapabilityError(f'{label} targets missing entity "{target}".')
        names = ACTION_CONTROLS[kind]
        if kind == "kick":
            names = (action["leg"] + "-leg",)
        elif kind in ("reach", "grasp", "lift", "place"):
            names = (action["effector"],)
        controls = require(character, label, names)
        if kind in ("reach", "place") and controls[action["effector"]].parent is None:
            raise RigCapabilityError(f'{label} requires a parented hand control.')
        if kind == "kick":
            rig, foot, bone = foot_ik(roots[character], controls, action["leg"])
            if rig is None or foot is None:
                raise RigCapabilityError(f'{label} requires bone "{bone}" and a tagged {action["leg"]}-foot-ik target.')

    for curve in spec["motionCurves"]:
        character = curve["characterId"]
        control = curve["control"]
        if control == "root" and character in roots:
            continue
        require(character, "Motion clip", (control,))
