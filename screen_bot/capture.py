import os
import time

import mss
import mss.tools

SCREENSHOT_DIR = "screenshots"


def _run_dir(run_id: str) -> str:
    path = os.path.join(SCREENSHOT_DIR, run_id)
    os.makedirs(path, exist_ok=True)
    return path


def capture_full_screen(run_id: str, label: str) -> str:
    """Grab the primary monitor and save it as a PNG. Returns the file path.

    Saved to screenshots/<run_id>/ so every read the bot made is auditable later.
    """
    path = os.path.join(_run_dir(run_id), f"{int(time.time() * 1000)}_{label}.png")
    with mss.mss() as sct:
        monitor = sct.monitors[1]  # index 0 is "all monitors combined"; 1 is the primary
        shot = sct.grab(monitor)
        mss.tools.to_png(shot.rgb, shot.size, output=path)
    return path


def capture_region(run_id: str, label: str, x: int, y: int, width: int, height: int) -> str:
    """Grab a small region around a point (e.g. for reading a hover tooltip)."""
    path = os.path.join(_run_dir(run_id), f"{int(time.time() * 1000)}_{label}.png")
    with mss.mss() as sct:
        region = {"left": max(0, x - width // 2), "top": max(0, y - height // 2), "width": width, "height": height}
        shot = sct.grab(region)
        mss.tools.to_png(shot.rgb, shot.size, output=path)
    return path
