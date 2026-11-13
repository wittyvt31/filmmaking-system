"""End-to-end Blender-generated GLB -> Filmie library -> reusable world smoke."""
import glob
import hashlib
import json
import shutil
from pathlib import Path
from urllib.request import Request, urlopen

BASE = "http://127.0.0.1:4173/api"
OUT = Path("renders/asset-lab")


def api(path, payload=None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        BASE + path,
        data=body,
        headers={"Content-Type": "application/json"} if body else {},
    )
    try:
        with urlopen(request, timeout=240) as response:
            return json.load(response)
    except Exception:
        print("Failed endpoint", path, "payload", payload)
        raise


def run():
    source = Path(glob.glob("renders/asset-lab/artifacts/*.glb")[0])
    cfg = api("/external-library/config")
    inbox = Path(cfg["inboxDirectory"])
    inbox.mkdir(parents=True, exist_ok=True)
    filename = "filmie-external-crane.glb"
    shutil.copyfile(source, inbox / filename)

    inspected = api("/external-library/inspect", {"filename": filename})
    assert inspected["meshCount"] >= 1, inspected
    assert inspected["character"]["skeletonCount"] == 0

    metadata = {
        "filename": filename,
        "assetId": "props.crane.external",
        "version": "1.0.0",
        "category": "prop",
        "universeId": "cinematic-horror",
        "themes": ["horror"],
        "sourceProvider": "Filmie Blender smoke fixture",
        "license": {"name": "Filmie test fixture", "restrictions": []},
        "preview": True,
    }
    published = api("/external-library/import", metadata)
    assert published["status"] == "published", published
    assert published["preview"]["status"] == "rendered", published
    model = api("/external-library/assets")
    assert any(item["assetId"] == metadata["assetId"] for item in model["assets"])
    glb_bytes = urlopen(
        "http://127.0.0.1:4173" + published["glbUrl"],
        timeout=60,
    ).read()
    assert glb_bytes[:4] == b"glTF"
    assert hashlib.sha256(glb_bytes).hexdigest() == published["contentHash"]

    world = {
        "id": "world.night-test",
        "version": "1.0.0",
        "name": "Night threshold integration test",
        "universeId": "cinematic-horror",
        "theme": "horror",
        "instances": [
            {
                "id": "crane-prop",
                "assetId": metadata["assetId"],
                "version": metadata["version"],
                "transform": {
                    "position": {"x": 1, "y": 0, "z": 0},
                    "rotationDegrees": {"x": 0, "y": 0, "z": 0},
                    "scale": 1,
                },
            },
        ],
    }
    saved = api("/external-library/world", world)
    assert saved["instances"][0]["id"] == "crane-prop"
    found = api("/external-library/world/world.night-test/1.0.0")
    assert found["world"]["id"] == world["id"]

    project = api(
        "/projects",
        {"name": "World reuse smoke", "catalog": "3d-production"},
    )
    applied = api(
        "/external-library/apply-world",
        {
            "projectId": project["id"],
            "worldId": world["id"],
            "version": world["version"],
        },
    )
    assert applied["instanceCount"] == 1
    latest = api(
        "/projects/" + project["id"] +
        "/revisions/" + applied["revisionId"]
    )
    result = json.loads(latest["text"])
    for shot in result["shots"]:
        assert any(
            item["id"] == "crane-prop" and
            item["geometry"]["asset"]["assetId"] == metadata["assetId"]
            for item in shot["scene"]["world"]["entities"]
        )

    registry = json.loads(
        (Path(".filmie/projects") / project["id"] / "assets.json").read_text()
    )
    linked = next(
        item for item in registry if item["assetId"] == metadata["assetId"]
    )
    assert linked["contentHash"] == published["contentHash"]
    assert len([
        item for item in registry if item["assetId"] == metadata["assetId"]
    ]) == 1
    repeated = api("/external-library/import", metadata)
    assert repeated["status"] == "reused"

    summary = {
        "status": "passed",
        "meshCount": inspected["meshCount"],
        "source": str(source),
        "contentHash": published["contentHash"],
        "projectId": project["id"],
        "worldId": world["id"],
        "reused": True,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "external-library-smoke.json").write_text(json.dumps(summary, indent=2))
    print("External asset library: real Blender GLB, publish, reuse and world attachment verified.")


if __name__ == "__main__":
    run()
