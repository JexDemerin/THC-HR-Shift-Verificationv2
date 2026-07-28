# THC-HR-Shift-Verificationv2 — WellSky Screen Bot (prototype)

A screen-reading, mouse-driving bot: it screenshots your WellSky schedule, uses Claude's vision
API to figure out what's on screen, moves your mouse to click/hover through shifts, and logs the
results to a Google Sheet. Unlike the DOM-based Chrome extension approach, this works purely off
what's visibly rendered on your screen.

## Status: first testable version

This covers the workflow scoped out so far:
- Reads whatever's currently visible in the WellSky weekly schedule.
- Skips any day column for today or later — only fully-elapsed days get scanned.
- **Green (Complete)** shifts: clicks the shift, clicks Edit, and reads the Edit Care Log dialog —
  Status, Official start/end, Bill/Pay Hours, Client, Caregiver — then hovers each of the four
  "Actual"/"Scheduled" links (start and end) to read the exact clock-in/out timestamps from their
  tooltips. Values are recorded exactly as WellSky shows them — nothing is recomputed.
- **Red (Missed Clock-in/out)** shifts: never clicked — logged straight away with 0 hours and blank
  time fields.
- Anything else (yellow/in-progress, blue/scheduled, cancelled variants) is currently skipped and
  printed to the console — not yet in scope.
- Writes one row per shift to a **new "ScreenBot Log" tab** in your Sheet (created automatically),
  via an Apps Script Web App — no Google API/OAuth setup needed in Python.
- Never clicks **Save** in the Edit Care Log dialog — only ever the dialog's close (X) button. This
  is a read-only inspection pass; it doesn't change anything in WellSky.
- By default, pauses before every click on a green shift so you can confirm or skip it (`--yes`
  turns this off once you trust it).

## Important limitations

- **This runs on your computer, not in the cloud.** Claude Code built and unit-tested this in an
  isolated container with no access to your screen — you need to download this repo and run it
  locally on the Windows machine where WellSky is open.
- **You log into WellSky and navigate to the schedule yourself.** The bot never logs in and never
  scrolls/pages — it only reads whatever's currently rendered when you run it. Re-run after
  scrolling/changing weeks to cover more.
- **Needs your own Anthropic API key** (billed per screenshot it reads — this makes several vision
  calls per shift, so cost scales with how many shifts are on screen).
- **Coordinate accuracy from vision isn't pixel-perfect.** The confirm-before-click pause exists so
  a misjudged click doesn't land somewhere unintended in a real payroll system. Keep it on until
  you've validated it against your actual screen/resolution.
- **Windows display scaling** can throw off click coordinates if not accounted for; `run.py` calls
  `SetProcessDPIAware()` on startup to line up screenshot pixels with click coordinates, but if
  clicks still land offset, check your display's scaling percentage in Windows settings.

## Setup

1. Install Python 3.11+ on the Windows machine that has WellSky open.
2. `pip install -r requirements.txt`
3. Copy `.env.example` to `.env` and fill in:
   - `ANTHROPIC_API_KEY` — your own Claude API key.
   - `SHEETS_WEBAPP_URL` — see below.
4. In your destination Google Sheet: **Extensions → Apps Script**, paste in
   `apps_script/Code.gs`, then **Deploy → New deployment → Web app** (execute as yourself, access
   per your security needs). Copy the deployment URL into `SHEETS_WEBAPP_URL`.

## Running it

1. Log into WellSky and go to the weekly schedule view yourself.
2. Run:
   ```
   python run.py
   ```
   (add `--dry-run` the first few times to see what it would log without writing to the Sheet;
   add `--yes` once you trust it, to skip the per-click confirmation prompt)
3. Switch to the WellSky window when prompted, then let it run. Every screenshot it takes along
   the way is saved under `screenshots/<run-id>/` for later review if something looks wrong.
4. Scroll/change the WellSky view and run again to cover more of the schedule.

## Testing

`pytest tests/` runs the unit tests — they mock the vision/mouse/network calls and check the
control-flow logic (date filtering, green-vs-red branching, row-building, Sheet payload shape).
They don't require an API key, a display, or WellSky.

## What's not built yet

- In-progress (yellow), scheduled/upcoming (blue), and cancelled (orange/gray) shifts.
- Anything beyond what's visible on one screen (no auto-scroll/paging).
- WellSky login automation (intentionally out of scope for now).
