bl_info = {
    "name": "Filmie Asset Bridge",
    "author": "Filmie",
    "version": (1, 0, 0),
    "blender": (5, 2, 0),
    "location": "View3D > Sidebar > Filmie",
    "description": "Publish the selected Blender/Blendkit asset into Filmie's private asset library",
    "category": "Import-Export",
}

import json
import os
import queue
import threading
import uuid
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import bpy
from bpy.props import BoolProperty, EnumProperty, PointerProperty, StringProperty
from bpy.types import Operator, Panel, PropertyGroup

_PENDING = queue.Queue()


def endpoint(server, path, payload=None):
    base = server.rstrip("/")
    if base not in ("http://127.0.0.1:4173", "http://localhost:4173"):
        raise RuntimeError("Filmie Bridge accepts only the local Filmie server on port 4173.")
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        base + path,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    try:
        with urlopen(request, timeout=240) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError("Filmie API " + str(error.code) + ": " + detail) from error


def apply_status():
    processed = False
    while not _PENDING.empty():
        processed = True
        status = _PENDING.get_nowait()
        try:
            for scene in bpy.data.scenes:
                if hasattr(scene, "filmie_bridge"):
                    scene.filmie_bridge.status = status
        except ReferenceError:
            pass
    if processed:
        for window in bpy.context.window_manager.windows:
            for area in window.screen.areas:
                if area.type == "VIEW_3D":
                    area.tag_redraw()
    return 0.5


def publish_in_thread(server, payload):
    try:
        result = endpoint(server, "/api/external-library/import", payload)
        if result.get("status") not in ("published", "reused"):
            raise RuntimeError("Filmie did not confirm publication.")
        _PENDING.put(
            "Published " + result["assetId"] + "@" + result["version"]
            + " (" + result["status"] + "). Check Filmie Library."
        )
    except Exception as error:
        _PENDING.put("Publish failed: " + str(error)[:450])


class FilmieBridgeSettings(PropertyGroup):
    server: StringProperty(
        name="Filmie server",
        default="http://127.0.0.1:4173",
        description="Local Filmie Studio server",
    )
    asset_id: StringProperty(name="Asset ID", default="characters.daughter.horror")
    version: StringProperty(name="Immutable version", default="1.0.0")
    category: EnumProperty(
        name="Asset category",
        items=[
            ("character", "Character", "Rigged or static character"),
            ("environment", "Environment", "House or complete 3D set"),
            ("prop", "Prop", "Furniture, phone, key and other objects"),
            ("vehicle", "Vehicle", "Car or other vehicle"),
        ],
        default="character",
    )
    universe: StringProperty(name="Visual universe", default="cinematic-horror")
    themes: StringProperty(name="Themes (comma separated)", default="horror")
    family_id: StringProperty(name="Variant family (optional)", default="")
    provider: StringProperty(name="Source provider", default="Blendkit")
    source_url: StringProperty(name="Source asset URL (optional)", default="")
    license_name: StringProperty(
        name="Actual license",
        default="",
        description="Enter the license applicable to this exact source asset.",
    )
    license_url: StringProperty(name="License URL (optional)", default="")
    render_preview: BoolProperty(name="Render Blender preview", default=False)
    status: StringProperty(name="Status", default="Ready to export selected objects")


class FILMIE_OT_publish(Operator):
    bl_idname = "filmie.publish_selected"
    bl_label = "Publish Selection to Filmie"
    bl_description = "Export selected Blender assets as self-contained GLB and publish via localhost"
    bl_options = {"REGISTER"}

    def execute(self, context):
        settings = context.scene.filmie_bridge
        if not context.selected_objects:
            self.report({"ERROR"}, "Select a model, its armature and required meshes.")
            return {"CANCELLED"}
        if not settings.license_name.strip():
            self.report({"ERROR"}, "Enter and verify the asset's actual license first.")
            return {"CANCELLED"}
        try:
            config = endpoint(settings.server, "/api/external-library/config")
            inbox = config["inboxDirectory"]
            os.makedirs(inbox, exist_ok=True)
            filename = uuid.uuid4().hex + ".glb"
            path = os.path.join(inbox, filename)
            result = bpy.ops.export_scene.gltf(
                filepath=path,
                export_format="GLB",
                use_selection=True,
                export_apply=False,
                export_animations=True,
                export_skins=True,
                export_morph=True,
                export_extras=True,
            )
            if "FINISHED" not in result or not os.path.isfile(path):
                raise RuntimeError("Blender failed to export the selected models.")
            payload = {
                "filename": filename,
                "assetId": settings.asset_id.strip(),
                "version": settings.version.strip(),
                "category": settings.category,
                "universeId": settings.universe.strip(),
                "themes": [
                    term.strip().lower().replace(" ", "-")
                    for term in settings.themes.split(",") if term.strip()
                ],
                "sourceProvider": settings.provider.strip(),
                "license": {"name": settings.license_name.strip(), "restrictions": []},
                "preview": bool(settings.render_preview),
            }
            if settings.family_id.strip():
                payload["familyId"] = settings.family_id.strip()
            if settings.source_url.strip():
                payload["sourceUrl"] = settings.source_url.strip()
            if settings.license_url.strip():
                payload["license"]["url"] = settings.license_url.strip()
            settings.status = "Exported selected objects; publishing in the background…"
            threading.Thread(
                target=publish_in_thread,
                args=(settings.server, payload),
                daemon=True,
            ).start()
            self.report({"INFO"}, "GLB exported. Filmie publication is running.")
            return {"FINISHED"}
        except Exception as error:
            settings.status = "Export failed: " + str(error)[:350]
            self.report({"ERROR"}, str(error)[:180])
            return {"CANCELLED"}


class VIEW3D_PT_filmie_bridge(Panel):
    bl_label = "Filmie Asset Bridge"
    bl_idname = "VIEW3D_PT_filmie_bridge"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Filmie"

    def draw(self, context):
        layout = self.layout
        props = context.scene.filmie_bridge
        layout.prop(props, "server")
        layout.label(text="Selected: " + str(len(context.selected_objects)))
        layout.prop(props, "asset_id")
        layout.prop(props, "version")
        layout.prop(props, "category")
        layout.prop(props, "universe")
        layout.prop(props, "themes")
        layout.prop(props, "family_id")
        layout.separator()
        layout.label(text="Provenance and license")
        layout.prop(props, "provider")
        layout.prop(props, "source_url")
        layout.prop(props, "license_name")
        layout.prop(props, "license_url")
        layout.prop(props, "render_preview")
        layout.operator("filmie.publish_selected", icon="EXPORT")
        layout.label(text=props.status[:85])


_CLASSES = (FilmieBridgeSettings, FILMIE_OT_publish, VIEW3D_PT_filmie_bridge)


def register():
    for item in _CLASSES:
        bpy.utils.register_class(item)
    bpy.types.Scene.filmie_bridge = PointerProperty(type=FilmieBridgeSettings)
    if not bpy.app.timers.is_registered(apply_status):
        bpy.app.timers.register(apply_status, persistent=True)


def unregister():
    if bpy.app.timers.is_registered(apply_status):
        bpy.app.timers.unregister(apply_status)
    del bpy.types.Scene.filmie_bridge
    for item in reversed(_CLASSES):
        bpy.utils.unregister_class(item)


if __name__ == "__main__":
    register()
