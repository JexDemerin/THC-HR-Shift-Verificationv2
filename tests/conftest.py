"""pyautogui needs a real display/OS mouse driver, which this test sandbox doesn't have
(and the bot is meant to run on the user's own Windows machine anyway). Stub it out so the
rest of the package can still be imported and its logic unit-tested with mocks."""

import sys
import types

if "pyautogui" not in sys.modules:
    fake_pyautogui = types.ModuleType("pyautogui")
    fake_pyautogui.FAILSAFE = True
    fake_pyautogui.moveTo = lambda *a, **k: None
    fake_pyautogui.click = lambda *a, **k: None
    sys.modules["pyautogui"] = fake_pyautogui
