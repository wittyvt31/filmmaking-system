"""Create original, deterministic charcoal layers for the preparation proof."""

import hashlib
import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parent
ART = ROOT / "artwork"
REGISTRY = ROOT / "assets.json"
W = H = 640


def paper(seed, size=(W, H), transparent=False):
    rng = random.Random(seed)
    image = Image.new("RGBA", size, (0, 0, 0, 0) if transparent else (54, 50, 45, 255))
    if not transparent:
        pixels = image.load()
        for y in range(size[1]):
            for x in range(size[0]):
                grain = rng.randrange(-8, 9)
                shade = max(0, min(255, 55 + grain + int(9 * math.sin(y / 28))))
                pixels[x, y] = (shade, max(0, shade - 4), max(0, shade - 9), 255)
    return image


def sketch(draw, points, fill=(15, 14, 13, 220), width=4, repeats=2, seed=0):
    rng = random.Random(seed)
    for index in range(repeats):
        offset = index - (repeats - 1) / 2
        jittered = [(x + offset + rng.uniform(-1.4, 1.4), y + rng.uniform(-1.4, 1.4)) for x, y in points]
        draw.line(jittered, fill=fill, width=max(1, width - index), joint="curve")


def save(name, image):
    path = ART / (name + ".png")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError(f"Refusing to replace original proof artwork: {path}")
    image.save(path, format="PNG", optimize=False, compress_level=9)
    return path


def transparent_shape(name, draw_fn, size=(W, H)):
    image = paper(0, size, transparent=True)
    draw_fn(ImageDraw.Draw(image))
    return save(name, image)


def art_record(asset_id, path, description):
    relative = path.relative_to(ROOT).as_posix()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return {
        "assetId": asset_id,
        "version": "1.0.0",
        "type": "image",
        "sourceUri": relative,
        "contentHash": digest,
        "metadata": {"role": "layered-artwork", "description": description},
        "license": {"name": "Original in-house proof artwork", "restrictions": []},
        "provenance": {"source": "Deterministic Pillow drawing in create_artwork.py"},
    }


def main():
    if REGISTRY.exists():
        raise FileExistsError(f"Refusing to replace existing registry: {REGISTRY}")
    files = []

    # A hand-drawn moonlit mud-plaster room, separated into paper, window, and floor.
    bg = paper(41)
    d = ImageDraw.Draw(bg, "RGBA")
    d.rectangle((0, 0, 639, 410), fill=(52, 48, 44, 255))
    for y in range(30, 400, 11):
        sketch(d, [(0, y), (180, y + 4), (350, y - 3), (639, y + 2)], (11, 10, 9, 50), 1, 1, y)
    d.rectangle((55, 76, 260, 400), fill=(28, 27, 26, 255), outline=(12, 11, 10, 255), width=12)
    d.rectangle((73, 93, 242, 383), fill=(78, 76, 70, 255))
    d.ellipse((172, 111, 218, 157), fill=(165, 157, 139, 255))
    for k in range(10):
        sketch(d, [(80 + k * 14, 96), (95 + k * 12, 375)], (15, 14, 13, 110), 3, 1, k)
    d.rectangle((0, 0, 639, 44), fill=(19, 18, 17, 255))
    sketch(d, [(0, 47), (230, 53), (412, 43), (639, 49)], (5, 5, 5, 255), 9, 2, 3)
    files.append(("art.room.back", save("environment/room-back", bg), "Moonlit rough plaster wall and recessed window."))

    floor = paper(52, transparent=True)
    d = ImageDraw.Draw(floor, "RGBA")
    d.polygon([(0, 20), (639, 0), (639, 300), (0, 250)], fill=(22, 21, 20, 248))
    for i in range(36):
        y = 30 + i * 7
        sketch(d, [(0, y), (180, y + 10), (360, y + 2), (639, y + 18)], (100, 95, 86, 65), 1, 1, i)
    files.append(("art.room.floor", save("environment/floor", floor), "Scuffed charcoal floor plane."))

    # Father is illustrated as separate torso, head, hair, arms, and swappable facial marks.
    torso = transparent_shape("father/torso", lambda d: (
        d.polygon([(102, 592), (120, 362), (180, 270), (255, 238), (330, 270), (406, 360), (430, 592)], fill=(57, 54, 50, 255), outline=(12, 11, 10, 255), width=12),
        sketch(d, [(160, 330), (230, 385), (296, 340), (370, 420)], (8, 8, 8, 200), 5, 3, 11),
        sketch(d, [(210, 410), (230, 590)], (156, 146, 130, 110), 2, 2, 12),
    ))
    files.append(("art.father.torso", torso, "Original hand-drawn kurta torso layer."))
    torso_graphite = transparent_shape("father/torso-graphite", lambda d: (
        d.polygon([(88, 592), (110, 354), (176, 267), (255, 229), (337, 268), (421, 356), (454, 592)], fill=(132, 124, 111, 255), outline=(9, 8, 8, 255), width=12),
        sketch(d, [(126, 357), (198, 410), (270, 378), (345, 423), (417, 356)], (17, 16, 15, 220), 5, 3, 111),
        sketch(d, [(126, 390), (145, 500), (162, 588)], (25, 23, 21, 190), 3, 2, 112),
        sketch(d, [(405, 390), (400, 490), (382, 589)], (25, 23, 21, 190), 3, 2, 113),
        sketch(d, [(205, 441), (220, 591)], (204, 194, 177, 155), 2, 2, 114),
    ))
    files.append(("art.father.torso.graphite", torso_graphite, "Higher-contrast original kurta torso revision for legible charcoal shading."))
    head = transparent_shape("father/head", lambda d: (
        d.ellipse((148, 95, 500, 530), fill=(111, 103, 91, 255), outline=(10, 9, 9, 255), width=11),
        d.polygon([(188, 313), (252, 438), (382, 483), (468, 367)], fill=(135, 125, 110, 255)),
        sketch(d, [(195, 310), (260, 424), (365, 465), (461, 360)], (31, 29, 27, 200), 4, 2, 18),
        sketch(d, [(220, 155), (258, 124), (325, 119), (400, 152)], (20, 19, 18, 190), 5, 3, 19),
    ))
    files.append(("art.father.head", head, "Original portrait base with shaded face planes."))
    hair = transparent_shape("father/hair", lambda d: (
        d.polygon([(146, 254), (130, 161), (178, 80), (251, 43), (355, 50), (468, 113), (503, 214), (458, 190), (409, 163), (339, 178), (258, 162), (195, 221)], fill=(19, 18, 17, 255), outline=(4, 4, 4, 255), width=8),
        sketch(d, [(162, 176), (234, 89), (322, 75), (432, 132)], (130, 122, 109, 120), 2, 3, 22),
    ))
    files.append(("art.father.hair", hair, "Receding wavy charcoal hair overlay."))
    arm_l = transparent_shape("father/arm-left", lambda d: (
        d.polygon([(366, 88), (514, 102), (489, 293), (383, 473), (301, 435), (387, 258)], fill=(72, 67, 60, 255), outline=(12, 11, 10, 255), width=9),
        sketch(d, [(431, 139), (413, 270), (348, 396)], (12, 11, 10, 190), 3, 2, 27),
    ))
    files.append(("art.father.arm-left", arm_l, "Bent left sleeve and forearm cutout."))
    arm_r = transparent_shape("father/arm-right", lambda d: (
        d.polygon([(104, 91), (255, 91), (286, 287), (201, 449), (119, 423), (193, 257)], fill=(63, 59, 54, 255), outline=(12, 11, 10, 255), width=9),
        sketch(d, [(145, 135), (170, 270), (145, 395)], (12, 11, 10, 180), 3, 2, 28),
    ))
    files.append(("art.father.arm-right", arm_r, "Bent right sleeve and forearm cutout."))
    expressions = {}
    for name, brow_y, mouth_y, mouth_open in [("calm", 252, 372, False), ("alarmed", 237, 370, True)]:
        eyes = transparent_shape("father/eyes-" + name, lambda d, by=brow_y: (
            sketch(d, [(203, by), (238, by - 8), (267, by + 1)], (8, 7, 7, 255), 6, 2, 33),
            sketch(d, [(314, by - 1), (352, by - 10), (385, by + 2)], (8, 7, 7, 255), 6, 2, 34),
            d.ellipse((227, by + 8, 244, by + 24), fill=(7, 7, 7, 255)),
            d.ellipse((342, by + 7, 359, by + 24), fill=(7, 7, 7, 255)),
        ))
        mouth = transparent_shape("father/mouth-" + name, lambda d, my=mouth_y, opened=mouth_open: (
            d.ellipse((272, my, 324, my + (42 if opened else 15)), fill=(21, 18, 17, 255), outline=(7, 6, 6, 255), width=3) if opened else sketch(d, [(266, my), (292, my + 5), (323, my)], (18, 15, 14, 255), 5, 2, 35),
            sketch(d, [(222, 339), (268, 346)], (32, 30, 28, 160), 2, 2, 36),
        ))
        expressions[name] = (eyes, mouth)
        files.append(("art.father.eyes." + name, eyes, "Replaceable " + name + " eye and brow marks."))
        files.append(("art.father.mouth." + name, mouth, "Replaceable " + name + " mouth marks."))

    # Three props: chair, rotary telephone, and kerosene lantern; each assembled from transparent parts.
    chair_back = transparent_shape("props/chair-back", lambda d: (
        d.rounded_rectangle((100, 40, 540, 320), 40, fill=(47, 43, 39, 255), outline=(8, 8, 8, 255), width=12),
        d.rectangle((148, 85, 492, 276), outline=(133, 123, 108, 130), width=5),
        sketch(d, [(170, 115), (464, 245)], (9, 8, 8, 120), 3, 3, 41),
    ))
    chair_seat = transparent_shape("props/chair-seat", lambda d: (
        d.polygon([(82, 112), (540, 112), (590, 250), (22, 250)], fill=(61, 55, 48, 255), outline=(7, 7, 7, 255), width=12),
        sketch(d, [(83, 160), (545, 169)], (10, 9, 8, 150), 3, 3, 42),
    ))
    chair_legs = transparent_shape("props/chair-legs", lambda d: (
        sketch(d, [(114, 90), (146, 610)], (18, 16, 15, 255), 22, 3, 43),
        sketch(d, [(508, 90), (478, 610)], (18, 16, 15, 255), 22, 3, 44),
        sketch(d, [(88, 330), (542, 330)], (24, 22, 20, 255), 12, 2, 45),
    ))
    for ident, path, desc in [("chair-back", chair_back, "Worn woven chair back."), ("chair-seat", chair_seat, "Chair seat plane."), ("chair-legs", chair_legs, "Hand-sketched chair legs and braces.")]: files.append(("art.prop.chair." + ident, path, desc))

    phone = transparent_shape("props/telephone", lambda d: (
        d.ellipse((96, 276, 548, 564), fill=(24, 23, 22, 255), outline=(7, 7, 7, 255), width=13),
        d.ellipse((186, 330, 463, 566), fill=(48, 45, 41, 255), outline=(10, 10, 10, 255), width=9),
        d.ellipse((265, 393, 385, 513), fill=(19, 18, 17, 255), outline=(112, 104, 93, 220), width=8),
        d.arc((78, 46, 566, 354), 188, 352, fill=(9, 9, 9, 255), width=35),
        sketch(d, [(103, 236), (133, 163), (191, 118)], (6, 6, 6, 255), 22, 2, 51),
        sketch(d, [(543, 236), (509, 163), (455, 118)], (6, 6, 6, 255), 22, 2, 52),
        sketch(d, [(132, 589), (214, 620), (418, 616), (505, 586)], (8, 8, 8, 150), 3, 3, 53),
    ))
    files.append(("art.prop.telephone", phone, "Original rotary telephone illustration with base, dial, and handset."))

    lantern = transparent_shape("props/lantern", lambda d: (
        d.arc((164, 38, 474, 290), 180, 360, fill=(9, 9, 9, 255), width=19),
        d.rounded_rectangle((152, 200, 490, 568), 55, fill=(31, 30, 28, 245), outline=(7, 7, 7, 255), width=13),
        d.ellipse((220, 245, 422, 513), fill=(142, 129, 103, 150), outline=(9, 9, 9, 255), width=9),
        sketch(d, [(259, 257), (230, 374), (266, 494)], (8, 8, 8, 255), 8, 2, 61),
        sketch(d, [(382, 257), (416, 374), (381, 494)], (8, 8, 8, 255), 8, 2, 62),
        d.polygon([(286, 447), (326, 350), (364, 447)], fill=(198, 179, 138, 180)),
        sketch(d, [(118, 550), (522, 550)], (8, 8, 8, 255), 18, 2, 63),
    ))
    files.append(("art.prop.lantern", lantern, "Glass kerosene lantern with metal guard and flame."))

    registry = [art_record(asset_id, path, description) for asset_id, path, description in files]
    REGISTRY.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")
    print(f"Created {len(files)} original transparent PNG artwork layers at {ART}")


if __name__ == "__main__":
    main()
