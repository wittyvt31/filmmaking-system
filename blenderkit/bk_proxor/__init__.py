"""bk_proxor - lightweight PRX viewer and generator, shared across DCC plugins.

Top-level only re-exports DCC-agnostic format I/O so that
``import bk_proxor`` never imports ``bpy`` or ``maya.cmds``.

DCC-specific code lives under guarded subpackages:
  * ``bk_proxor._blender.draw``     - Blender GPU draw pipeline
  * ``bk_proxor._blender.generate`` - Blender mesh sampler
  * ``bk_proxor._maya.draw``        - Maya line-segment conversion
  * ``bk_proxor._unreal.draw``      - Unreal line/mesh vertex conversion

Each subpackage is imported lazily by the host plugin; missing host deps
in one DCC never break the others.
"""

from . import prx_format  # noqa: F401  (re-export)

__all__ = ["prx_format"]
