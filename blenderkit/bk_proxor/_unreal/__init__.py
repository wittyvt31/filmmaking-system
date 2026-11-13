"""Unreal-specific helpers for displaying PRX payloads.

Only pure-data conversion lives here so this subpackage does NOT need
``unreal`` at import time - the host plugin is free to import it from any
thread, including outside the Unreal process (tests).
"""
