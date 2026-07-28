# THC-HR-Shift-Verificationv2 — WellSky Shift Log

A Chrome extension that mirrors WellSky shift records — caregiver, client, date, status, and
exact actual/scheduled clock-in/out times — into a Google Sheet, one row per shift.

## Current approach: DOM-based extension (`extension/`)

Earlier in this project a screenshot + AI-vision + mouse-automation bot was prototyped (still in
`screen_bot/`/`run.py`, kept for reference). We pivoted away from it: WellSky's "Actual"/
"Scheduled" clock times and every other field on its Edit Care Log popup are real DOM elements,
so a Chrome extension's content script can read them directly and exactly — no OCR, no AI vision
calls, no simulated mouse movement, no per-call cost, and no risk of a misjudged click coordinate
in a real payroll system.

### Status: Phase 0 (discovery) + calendar-level scanning

What's working now:
- **"Scan Schedule"** reads every shift currently visible in the WellSky weekly calendar (built on
  the markup already confirmed in the original WellSky Shift Scanner project: one
  `<tr class="sched_row">` per caregiver, one `<div class="_event STATUS" data-event-id
  data-start data-end>` per shift) and reports, per shift: `caregiver_name`, `client_name`,
  `shift_date`, `status`, `status_raw`, `event_id`, `scanned_at`.
- Skips any shift dated today or later — only fully-elapsed days get scanned (a shift with no
  parseable date is kept as `unparsed` rather than silently dropped, since it can't be judged
  past/future either way).
- **"Export Care Log HTML"** is a Phase 0 discovery tool — open a shift's Edit Care Log popup (or
  the summary popup) yourself, click this button, and it downloads that popup's real markup.
- Sends scanned records to a new **"Shift Log" tab** (created automatically) in your Sheet, via an
  Apps Script Web App. Re-scanning the same shift updates its existing row (matched by
  `event_id`) instead of duplicating it.

What's **not built yet, on purpose**: `actual_time_in`, `scheduled_time_in`, `actual_time_out`,
and `scheduled_time_out` are currently always blank. WellSky exposes those four values via
"Actual"/"Scheduled" links under the Official start/end fields in the Edit Care Log dialog — but
nobody has captured that dialog's real markup yet, so the exact selectors (and whether the tooltip
values live in a `title` attribute already in the DOM, or only appear once triggered) aren't known.
Guessing here risks silently mis-recording payroll timestamps — exactly what the original project's
spec warned against — so the real parser for those four fields waits until a real capture comes
back from "Export Care Log HTML".

### Next step to unblock actual/scheduled times

1. Load the extension (see Setup below).
2. On the WellSky schedule, open a **completed (green)** shift → click **Edit** to open the Edit
   Care Log dialog.
3. Click the extension icon → **Export Care Log HTML** → send the downloaded file back here.
4. That markup gets used to write the real Phase 1b parser for the four time fields, and to
   confirm whether reading them needs a simulated hover event or if they're already present as an
   attribute.

## Setup

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the
   `extension/` folder.
2. In your destination Google Sheet: **Extensions → Apps Script**, paste in
   `apps_script/Code.gs`, then **Deploy → New deployment → Web app** (execute as yourself, access
   per your security needs). Copy the deployment URL.
3. Click the extension icon → **Settings** → paste the Web App URL → **Save**.

## Using it

1. Log into WellSky and go to the weekly schedule view.
2. Click the extension icon → **Scan Schedule**. Records get written to the "Shift Log" tab.
3. Scroll/change the view (different week, different caregiver group) and scan again to cover
   more — it only reads what's currently on screen, same as the original scanner.

## Testing

`npm test` (needs `npm install` once first) runs `tests/*.test.js` — these use `jsdom` to build
fixture HTML matching WellSky's confirmed markup and check `scan-script.js` and
`inspect-care-log-script.js`'s parsing/discovery logic, without needing a browser or real WellSky
access.

## The earlier screen-bot prototype (`screen_bot/`, `run.py`)

Kept for reference in case the DOM approach hits a wall WellSky's markup can't support (e.g. a
value that's genuinely only ever rendered, never present in the DOM). Not the active approach —
see `pytest tests/` if you want to run its own test suite. Ask if you'd like this removed instead
of kept around unused.

## What's not built yet

- The four actual/scheduled time fields (see "Next step" above).
- Since today/future shifts are already skipped, in-progress (yellow) and scheduled/upcoming
  (blue) statuses shouldn't normally appear in scan results at all — if one ever does (e.g. an
  overnight shift spanning midnight), it's still included rather than dropped, so it's visible for
  a human to check.
- Cancelled (orange/gray) shift variants aren't specially handled yet — they'll come through
  whatever their raw status maps to.
- Anything beyond what's visible on one screen (no auto-scroll/paging).
- WellSky login automation (intentionally out of scope).
