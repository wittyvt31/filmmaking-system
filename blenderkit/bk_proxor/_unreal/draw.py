"""Pure-data conversion: PRX payload -> Unreal-space geometry.

Unreal has no Python immediate-mode viewport draw API (unlike Maya's
``MUIDrawManager``), so the host plugin turns these vertex lists into real
scene geometry instead - e.g. a ``LineBatchComponent`` for the wireframe and
a procedural/dynamic mesh component for the hologram fill, on a transient
preview actor that is deleted when the drag ends.

Coordinate conversion mirrors ``bk_proxor._maya.draw``: PRX positions are
Blender Z-up metres stored as ``raw * 100`` (see ``_PRX_TO_METRES``). Unreal
is already Z-up (no Y/Z swap needed, unlike Maya), but is left-handed where
Blender is right-handed, so the Y axis is mirrored. ``world_scale=100``
converts metres to Unreal's internal centimetres. On top of that mirror, a
fixed -90 deg rotation about X is applied (confirmed against a real asset
in-editor) - the raw PRX mesh's own "up" doesn't line up 1:1 with its bbox
axes the way a plain Blender object-space AABB does, so this correction is
proxor-specific and must NOT be applied to the (already-correct) asset bbox.
This must happen HERE, before any bottom-center recentring downstream (see
``placement._prepare_proxor_payload``) - applying it after recentring un-does
the centring and was the cause of a previous "proxor invisible" regression.

The default mirror-axis (``flip_y=True``) is the common Blender-export-to-
Unreal convention (matches most glTF/FBX pipelines). It is exposed as a
parameter rather than hardcoded so it can be flipped in one place if the
in-editor preview turns out mirrored/rotated for this asset library's data.
"""

from __future__ import annotations

import math
from typing import Any, Optional

_DEFAULT_SCALE = 100.0
_PRX_TO_METRES = 0.01
_BASIS_ROTATE_X_DEG = -90.0


def _rotate_x(y: float, z: float, degrees: float) -> tuple[float, float]:
    rad = math.radians(degrees)
    cos_r, sin_r = math.cos(rad), math.sin(rad)
    return y * cos_r - z * sin_r, y * sin_r + z * cos_r


def _scaled(x: float, y: float, z: float, s: float, *, flip_y: bool) -> tuple[float, float, float]:
    x, y, z = x * s, (-y if flip_y else y) * s, z * s
    y, z = _rotate_x(y, z, _BASIS_ROTATE_X_DEG)
    return (x, y, z)


def prx_to_line_segments(
    payload: dict[str, Any],
    *,
    world_scale: float = _DEFAULT_SCALE,
    flip_y: bool = True,
) -> list[list[tuple[float, float, float]]]:
    """Return a list of ``[(ax,ay,az), (bx,by,bz)]`` segments in Unreal space.

    Args:
        payload: A parsed PRX dict (as returned by ``prx_format.read_prx``).
                 Either the full ``{"data": {...}}`` wrapper or the inner
                 data dict is accepted.
        world_scale: Multiplier applied to every coordinate. Default
                     ``100.0`` converts metres to Unreal centimetres.
        flip_y: When ``True`` mirrors the Y axis to convert Blender's
                right-handed frame to Unreal's left-handed one.

    Returns:
        Possibly-empty list of two-point segments, suitable for building a
        ``LineBatchComponent`` (``draw_line`` per segment) or debug lines.
    """
    if not isinstance(payload, dict):
        return []

    data = payload.get("data", payload)
    if not isinstance(data, dict):
        return []

    positions = (data.get("line") or {}).get("pos") or []
    segments: list[list[tuple[float, float, float]]] = []

    # PRX stores polylines as flat pairs: [a0, b0, a1, b1, ...].
    s = float(world_scale) * _PRX_TO_METRES
    for i in range(0, len(positions) - 1, 2):
        try:
            ax, ay, az = (float(v) for v in positions[i][:3])
            bx, by, bz = (float(v) for v in positions[i + 1][:3])
        except (TypeError, ValueError, IndexError):
            continue
        segments.append(
            [
                _scaled(ax, ay, az, s, flip_y=flip_y),
                _scaled(bx, by, bz, s, flip_y=flip_y),
            ]
        )

    return segments


def prx_to_mesh_triangles(
    payload: dict[str, Any],
    *,
    world_scale: float = _DEFAULT_SCALE,
    flip_y: bool = True,
) -> list[tuple[float, float, float]]:
    """Return mesh vertices as a flat list of ``(x, y, z)`` triples.

    The PRX ``data['mesh']['pos']`` array stores triangle vertices
    consecutively (3 vertices per triangle, no index buffer). Chunk the
    returned list into 3-tuples to build triangles for a
    ``ProceduralMeshComponent``/``DynamicMeshComponent`` (winding order may
    need reversing there - Unreal's mirror-Y flip also reverses winding,
    which is usually what a left-handed target wants, but verify visually).

    Returns an empty list when the payload contains no mesh section.
    """
    if not isinstance(payload, dict):
        return []
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        return []
    positions = (data.get("mesh") or {}).get("pos") or []
    s = float(world_scale) * _PRX_TO_METRES
    out: list[tuple[float, float, float]] = []
    for p in positions:
        try:
            x, y, z = (float(v) for v in p[:3])
        except (TypeError, ValueError, IndexError):
            continue
        out.append(_scaled(x, y, z, s, flip_y=flip_y))
    # Round triangle count: discard any trailing 1 or 2 dangling verts.
    n_tris = len(out) // 3
    return out[: n_tris * 3]


def prx_to_mesh_normals(
    payload: dict[str, Any],
    *,
    flip_y: bool = True,
) -> list[tuple[float, float, float]]:
    """Return mesh normals (mirrored to match :func:`prx_to_mesh_triangles`).

    Length matches the vertex count of the mesh; pass to a
    ``ProceduralMeshComponent.create_mesh_section`` normals array.
    """
    if not isinstance(payload, dict):
        return []
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        return []
    normals = (data.get("mesh") or {}).get("nrm") or []
    out: list[tuple[float, float, float]] = []
    for n in normals:
        try:
            x, y, z = (float(v) for v in n[:3])
        except (TypeError, ValueError, IndexError):
            continue
        y = -y if flip_y else y
        y, z = _rotate_x(y, z, _BASIS_ROTATE_X_DEG)
        out.append((x, y, z))
    return out


def _collect_raw_bounds(
    data: dict[str, Any],
) -> Optional[tuple[tuple[float, float, float], tuple[float, float, float]]]:
    """Return ``((min_x, min_y, min_z), (max_x, max_y, max_z))`` over raw verts.

    Bounds are computed in the untransformed PRX frame (before any axis flip
    or scale).  Prefers the mesh section; falls back to line then point
    positions so an arrow can still be produced for point/line-only payloads.
    Returns ``None`` when no usable geometry exists.
    """
    for key in ("mesh", "line", "points"):
        positions = (data.get(key) or {}).get("pos") or []
        mins: Optional[list[float]] = None
        maxs: Optional[list[float]] = None
        for p in positions:
            try:
                x, y, z = (float(v) for v in p[:3])
            except (TypeError, ValueError, IndexError):
                continue
            if mins is None or maxs is None:
                mins = [x, y, z]
                maxs = [x, y, z]
            else:
                mins = [min(mins[0], x), min(mins[1], y), min(mins[2], z)]
                maxs = [max(maxs[0], x), max(maxs[1], y), max(maxs[2], z)]
        if mins is not None and maxs is not None:
            return ((mins[0], mins[1], mins[2]), (maxs[0], maxs[1], maxs[2]))
    return None


def prx_to_arrow_segments(
    payload: dict[str, Any],
    *,
    world_scale: float = _DEFAULT_SCALE,
    flip_y: bool = True,
) -> list[list[tuple[float, float, float]]]:
    """Return the floor-level forward-pointing arrow as two line segments.

    Mirrors the default green bounding-box arrow drawn by the Blender proxor
    handler: two lines from the two front-bottom corners of the shape's
    bounding box to a tip in front of it, at floor height.

    Returns an empty list when the payload has no usable geometry.
    """
    if not isinstance(payload, dict):
        return []
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        return []

    bounds = _collect_raw_bounds(data)
    if bounds is None:
        return []
    (rx_min, ry_min, rz_min), (rx_max, _ry_max, _rz_max) = bounds
    # Raw PRX frame: x = width axis, z = up (floor = min z), y = front (front = min y).
    width = rx_max - rx_min
    if width <= 0:
        return []

    cx = (rx_min + rx_max) / 2.0
    # Tip sits in front of the shape (-y) by half the width, at floor height.
    p_left = (rx_min, ry_min, rz_min)
    p_right = (rx_max, ry_min, rz_min)
    tip = (cx, ry_min - width / 2.0, rz_min)

    s = float(world_scale) * _PRX_TO_METRES
    return [
        [_scaled(*p_left, s, flip_y=flip_y), _scaled(*tip, s, flip_y=flip_y)],
        [_scaled(*p_right, s, flip_y=flip_y), _scaled(*tip, s, flip_y=flip_y)],
    ]
