import time

import pyautogui

pyautogui.FAILSAFE = True  # slam the mouse into a screen corner to abort


def move_to(x: int, y: int, duration: float = 0.3):
    pyautogui.moveTo(x, y, duration=duration)


def click(x: int, y: int, duration: float = 0.3, settle: float = 0.8):
    """Move to a point and left-click it, then pause for the page to react."""
    pyautogui.moveTo(x, y, duration=duration)
    pyautogui.click()
    time.sleep(settle)


def hover(x: int, y: int, duration: float = 0.2, settle: float = 0.6):
    """Move to a point WITHOUT clicking, then pause for a tooltip to appear."""
    pyautogui.moveTo(x, y, duration=duration)
    time.sleep(settle)
