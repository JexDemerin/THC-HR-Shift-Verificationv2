import argparse
import sys

from screen_bot import config
from screen_bot.pipeline import run


def main():
    parser = argparse.ArgumentParser(description="Scan the currently-visible WellSky schedule and log shifts.")
    parser.add_argument("--yes", action="store_true", help="Don't pause to confirm before each click.")
    parser.add_argument("--dry-run", action="store_true", help="Read everything but don't write to the Sheet.")
    args = parser.parse_args()

    if sys.platform == "win32":
        # Without this, screenshot pixel coordinates and pyautogui's click coordinates
        # can disagree on a scaled display, and every click lands in the wrong place.
        import ctypes

        ctypes.windll.user32.SetProcessDPIAware()

    config.require_config()

    print("Switch to the WellSky schedule window now.")
    input("Press Enter when you're ready (you have a few seconds after that to switch windows)... ")

    run(confirm_each=not args.yes, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
