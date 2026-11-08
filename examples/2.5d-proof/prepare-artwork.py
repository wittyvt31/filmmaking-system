"""Prepare deterministic alpha cutouts from the supplied storyboard artwork.

Requires Pillow. Source files in examples/they-have-reached remain untouched.
Run once from any working directory with Python.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import shutil

from PIL import Image, ImageDraw


PROJECT = Path(__file__).resolve().parent
SOURCE = PROJECT.parent / "they-have-reached" / "assets"
BACKGROUND_SOURCE = SOURCE / "backgrounds" / "interior-wide.png"
DAUGHTER_SOURCE = SOURCE / "characters" / "daughter-full-body.png"
PHONE_SOURCE = SOURCE / "props" / "telephone.png"
BACKGROUND = PROJECT / "assets" / "backgrounds" / "interior-wide.png"
DAUGHTER = PROJECT / "assets" / "foreground" / "daughter-cutout.png"
PHONE = PROJECT / "assets" / "foreground" / "telephone-cutout.png"
REGISTRY = PROJECT / "assets.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def make_cutout(source: Path, destination: Path, outline: list[tuple[float, float]]) -> None:
    if destination.exists():
        raise FileExistsError(f"Refusing to overwrite prepared artwork: {destination}")
    image = Image.open(source).convert("RGBA")
    scale = 4
    mask_large = Image.new("L", (image.width * scale, image.height * scale), 0)
    ImageDraw.Draw(mask_large).polygon(
        [(round(x * (image.width - 1) * scale), round(y * (image.height - 1) * scale)) for x, y in outline],
        fill=255,
    )
    mask = mask_large.resize(image.size, Image.Resampling.LANCZOS)
    original_alpha = image.getchannel("A")
    from PIL import ImageChops

    image.putalpha(ImageChops.multiply(original_alpha, mask))
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", optimize=False, compress_level=9)


def version(asset_id: str, source_uri: str, path: Path, description: str, provenance: str) -> dict:
    return {
        "assetId": asset_id,
        "version": "1.0.0",
        "type": "graphic",
        "sourceUri": source_uri,
        "contentHash": sha256(path),
        "metadata": {"role": "2.5d-artwork", "description": description},
        "license": {
            "name": "User-supplied approved storyboard artwork",
            "restrictions": ["Use for project They Have Reached"],
        },
        "provenance": {"source": provenance},
    }


def main() -> None:
    for source in (BACKGROUND_SOURCE, DAUGHTER_SOURCE, PHONE_SOURCE):
        if not source.is_file():
            raise FileNotFoundError(f"Required supplied artwork is missing: {source}")
    if BACKGROUND.exists() or REGISTRY.exists():
        raise FileExistsError("Refusing to overwrite existing proof-project assets or registry")
    BACKGROUND.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(BACKGROUND_SOURCE, BACKGROUND)

    # Hand-authored normalized silhouettes; the cutouts preserve the original drawing.
    daughter_outline = [
        (0.49, 0.055), (0.56, 0.065), (0.60, 0.105), (0.61, 0.16),
        (0.66, 0.215), (0.72, 0.245), (0.75, 0.31), (0.73, 0.39),
        (0.69, 0.48), (0.72, 0.61), (0.75, 0.80), (0.72, 0.93),
        (0.67, 0.97), (0.59, 0.965), (0.54, 0.99), (0.47, 0.98),
        (0.39, 0.97), (0.31, 0.95), (0.28, 0.91), (0.31, 0.82),
        (0.33, 0.69), (0.31, 0.57), (0.28, 0.46), (0.25, 0.38),
        (0.26, 0.32), (0.31, 0.28), (0.39, 0.235), (0.40, 0.18),
        (0.43, 0.105),
    ]
    telephone_outline = [
        (0.20, 0.36), (0.19, 0.29), (0.24, 0.23), (0.31, 0.20),
        (0.39, 0.23), (0.45, 0.30), (0.54, 0.30), (0.62, 0.23),
        (0.71, 0.22), (0.79, 0.27), (0.83, 0.35), (0.83, 0.46),
        (0.78, 0.51), (0.77, 0.62), (0.75, 0.72), (0.68, 0.80),
        (0.59, 0.84), (0.49, 0.85), (0.40, 0.84), (0.32, 0.81),
        (0.27, 0.76), (0.24, 0.67), (0.24, 0.57), (0.19, 0.53),
        (0.17, 0.45),
    ]
    make_cutout(DAUGHTER_SOURCE, DAUGHTER, daughter_outline)
    make_cutout(PHONE_SOURCE, PHONE, telephone_outline)

    registry = [
        version(
            "background.interior-wide",
            "assets/backgrounds/interior-wide.png",
            BACKGROUND,
            "Supplied opaque charcoal interior panel used as the back plane.",
            "User-supplied storyboard asset pack; copied byte-for-byte from they-have-reached/assets/backgrounds/interior-wide.png",
        ),
        version(
            "character.daughter-cutout",
            "assets/foreground/daughter-cutout.png",
            DAUGHTER,
            "Supplied full-body daughter artwork with deterministic hand-authored alpha matte.",
            "User-supplied storyboard daughter-full-body.png; 4x antialiased polygon matte defined in prepare-artwork.py",
        ),
        version(
            "prop.telephone-cutout",
            "assets/foreground/telephone-cutout.png",
            PHONE,
            "Supplied telephone drawing with deterministic hand-authored alpha matte.",
            "User-supplied telephone.png; 4x antialiased polygon matte defined in prepare-artwork.py",
        ),
    ]
    REGISTRY.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    for asset in registry:
        print(f"{asset['assetId']}@{asset['version']} {asset['contentHash']}")


if __name__ == "__main__":
    main()
