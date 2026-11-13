"""Maya-specific helpers for displaying PRX payloads.

Only the pure-data conversion lives here so this subpackage does NOT need
``maya.cmds`` / ``maya.api`` at import time — the host plugin is free to
import it from any thread.
"""
