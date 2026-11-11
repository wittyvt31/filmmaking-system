"""Atomic content-addressed storage for reusable, unposed Blender collections."""
import os
import tempfile

import bpy


def read_collection(cache, name):
    if not os.path.isfile(cache["path"]):
        return None
    try:
        with bpy.data.libraries.load(cache["path"], link=False) as (source, destination):
            if name not in source.collections:
                return None
            destination.collections = [name]
        collection = destination.collections[0]
        if collection and collection.get("filmie_collection_cache_key") == cache["key"]:
            return collection
    except (OSError, RuntimeError) as exc:
        print("Could not restore Filmie collection cache:", exc, flush=True)
    return None


def write_collection(cache, collection):
    path = cache["path"]
    parent = os.path.dirname(path)
    collection["filmie_collection_cache_key"] = cache["key"]
    try:
        os.makedirs(parent, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=parent) as scratch:
            temporary = os.path.join(scratch, "collection.blend")
            bpy.data.libraries.write(temporary, {collection}, path_remap="ABSOLUTE", compress=True)
            os.replace(temporary, path)
    except (OSError, RuntimeError) as exc:
        print("Could not store Filmie collection cache:", exc, flush=True)
