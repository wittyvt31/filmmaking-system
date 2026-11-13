"""Real Asset Studio HTTP smoke: validate, build, reimport, download and attach.

Run while Filmie web API is listening on 127.0.0.1:4173 with Blender available.
Uses only Python's standard library; no browser automation or hidden mock assets.
"""
import hashlib
import json
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE = "http://127.0.0.1:4173"


def fetch(path, payload=None, timeout=240):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            raw = response.read()
            if response.headers.get("Content-Type", "").startswith("application/json"):
                return json.loads(raw)
            return raw
    except HTTPError as error:
        print(error.read().decode("utf-8", errors="replace"), file=sys.stderr)
        raise


def main():
    for _ in range(60):
        try:
            template = fetch("/api/asset-studio/template", timeout=4)
            break
        except URLError:
            time.sleep(0.2)
    else:
        raise RuntimeError("Filmie web API did not become available")

    html = fetch("/")
    script = fetch("/app.js")
    assert b"Filmie Studio" in html and len(script) > 1000
    assert template["definition"]["assetId"] == "filmie.demo.crane"

    validation = fetch("/api/asset-studio/validate", {"definition": template["definition"]})
    assert validation["valid"] is True, validation
    assert validation["partCount"] == 6 and validation["jointCount"] == 3

    built = fetch("/api/asset-studio/build", {"definition": template["definition"]})
    assert built["status"] == "published", built
    assert built["preview"]["status"] == "rendered", built
    asset = built["asset"]

    glb = fetch(asset["glbUrl"])
    png = fetch(asset["previewUrl"])
    assert glb[:4] == b"glTF" and len(glb) > 1000
    assert png[:8] == b"\x89PNG\r\n\x1a\n" and len(png) > 1000
    assert hashlib.sha256(glb).hexdigest() == asset["contentHash"]

    available = fetch("/api/asset-studio/assets")["assets"]
    assert len(available) == 1 and available[0]["assetId"] == asset["assetId"]

    definition = fetch(
        "/api/asset-studio/definitions/" + asset["assetId"] + "/" + asset["version"]
    )
    assert definition["definition"]["joints"] == template["definition"]["joints"]

    project = fetch(
        "/api/projects", {"name": "Asset Studio smoke project", "catalog": "3d-production"}
    )
    attached = fetch(
        "/api/asset-studio/attach",
        {
            "projectId": project["id"],
            "assetId": asset["assetId"],
            "version": asset["version"],
        },
    )
    assert attached["projectId"] == project["id"]
    project_data = fetch("/api/projects/" + project["id"])
    assert any(
        item["assetId"] == asset["assetId"] and item["version"] == asset["version"]
        for item in project_data["assets"]
    )

    registry_path = Path(".filmie/projects") / project["id"] / "assets.json"
    registry = json.loads(registry_path.read_text())
    published = next(
        entry for entry in registry if entry["assetId"] == asset["assetId"]
    )
    resolved = (Path("examples/3d-production") / published["sourceUri"]).resolve()
    assert resolved.is_file()
    assert hashlib.sha256(resolved.read_bytes()).hexdigest() == asset["contentHash"]

    repeated = fetch("/api/asset-studio/build", {"definition": template["definition"]})
    assert repeated["status"] == "reused" and repeated["preview"]["status"] == "rendered"

    Path("renders/asset-lab").mkdir(parents=True, exist_ok=True)
    Path("renders/asset-lab/web-api-smoke.json").write_text(
        json.dumps(
            {
                "status": "passed",
                "assetId": asset["assetId"],
                "version": asset["version"],
                "sha256": asset["contentHash"],
                "glbBytes": len(glb),
                "pngBytes": len(png),
                "projectId": project["id"],
                "projectAttached": True,
                "reused": True,
            },
            indent=2,
        )
        + "\n"
    )
    print("Filmie Asset Studio: real HTTP build, preview, GLB, library and attach passed.")


if __name__ == "__main__":
    main()
