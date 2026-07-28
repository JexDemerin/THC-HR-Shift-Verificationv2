# THC-HR-Shift-Verificationv2 — WellSky Shift Log

A Chrome extension that mirrors WellSky shift records — caregiver, client, date, status, and
exact actual/scheduled clock-in/out times — into a Google Sheet, one row per shift.

## Approach: DOM-based extension (`extension/`)

An earlier screenshot + AI-vision + mouse-automation prototype was scrapped in favor of this:
WellSky's "Actual"/"Scheduled" clock times and every other field on its Edit Care Log popup are
real DOM elements, so a Chrome extension's content script can read them directly and exactly — no
OCR, no AI vision API calls (so no API key or per-call cost, and no Python install needed), no
simulated mouse movement, and no risk of a misjudged click coordinate in a real payroll system.

### Status: full scan, including actual/scheduled clock times

What's working now:
- **"Scan Schedule"** reads every shift currently visible in the WellSky weekly calendar (built on
  the markup already confirmed in the original WellSky Shift Scanner project: one
  `<tr class="sched_row">` per caregiver, one `<div class="_event STATUS" data-event-id
  data-start data-end>` per shift).
- Skips any shift dated today or later — only fully-elapsed days get scanned (a shift with no
  parseable date is kept as `unparsed` rather than silently dropped, since it can't be judged
  past/future either way).
- For every **completed (green)** shift, it also clicks the shift's `.title` label open (a real run
  showed clicking the outer shift wrapper opens WellSky's generic "Add Unavailability" popup
  instead — the shift-specific click handler lives on the inner label, not the wrapper), clicks
  **Edit**, and reads the four real clock times off the Edit Care Log dialog —
  `actual_time_in`, `scheduled_time_in`, `actual_time_out`, `scheduled_time_out` — then closes the
  dialog (Escape, or a "Cancel" control; **never Save**) before moving to the next shift. A real
  capture confirmed the mechanism: hovering `a.actual_start` / `a.scheduled_start` /
  `a.actual_end` / `a.scheduled_end` makes a brand-new `<div class="_ptip ...">` tooltip node
  appear elsewhere on the page with the plain timestamp as its text (not a `title` attribute,
  which is what the first two attempts guessed and got stuck on) — the extension simulates that
  hover itself, no mouse movement needed.
- If the dialog doesn't visibly close the way expected after reading a shift, scanning **stops
  early** rather than continuing to click on a page that might not be in the state it expects, and
  says why in the popup's log.
- If any shift's click-through doesn't behave as expected (wrong popup opens, no Edit link found,
  dialog never matches, a time comes back blank), that's reported as a per-shift diagnostic line in
  the popup's log instead of just leaving the four fields silently blank.
- Sends every scanned record — `caregiver_name`, `client_name`, `shift_date`, the four time
  fields, `status`, `status_raw`, `event_id`, `scanned_at` — to a **"Shift Log" tab** (created
  automatically) in your Sheet, via an Apps Script Web App. Re-scanning the same shift updates its
  existing row (matched by `event_id`) instead of duplicating it.

Scanning a shift with a click-through now takes a few seconds each (open, read, close), so a
schedule with many completed shifts visible at once will take a while to finish — that's expected.

## Setup

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the
   `extension/` folder.
2. In your destination Google Sheet: **Extensions → Apps Script**, paste in
   `apps_script/Code.gs`, then **Deploy → New deployment → Web app** (execute as yourself, access
   per your security needs). Copy the deployment URL.
3. Click the extension icon → **Settings** → paste the Web App URL → **Save**.

**If you already deployed an earlier version of `Code.gs`** (e.g. from before this project switched
from the Python screen-bot to the extension), re-paste the current `apps_script/Code.gs` and use
**Deploy → Manage deployments → Edit (pencil icon) → Version: New version → Deploy**. Just saving
the script does *not* update an already-published Web App URL — the extension will keep talking to
whatever code was live at the last deployed version until you publish a new one. The popup will
warn you if the Sheet's response doesn't look like it came from the current script.

## Using it

1. Log into WellSky and go to the weekly schedule view.
2. Click the extension icon → **Scan Schedule**. Records get written to the "Shift Log" tab.
   Completed shifts take a few seconds each while it clicks through and reads their times — watch
   the popup's log for progress, and don't touch the WellSky tab while it's running.
3. Scroll/change the view (different week, different caregiver group) and scan again to cover
   more — it only reads what's currently on screen, same as the original scanner.

If a scan stops early with a message about not being able to confirm the dialog closed, reload the
WellSky page before re-scanning — better to stop than keep clicking on a page that might not be in
the state the script expects.

## Debugging tools

- **"Export Care Log HTML"** — captures whatever the Edit Care Log (or summary) popup currently
  looks like, plus a per-link probe of what changes when each Actual/Scheduled link is hovered.
  Useful if WellSky's markup ever changes and the real scanner stops finding what it expects.
- **Ctrl+Shift+E** — same idea, but captured exactly as-is with nothing simulated, for physically
  hovering a link with the real mouse and triggering the export via keyboard (since a mouse can't
  hover and click at the same time).

## Testing

`npm test` (needs `npm install` once first) runs `tests/*.test.js` — these use `jsdom` to build
fixture HTML matching WellSky's confirmed markup (including a full simulated click-through: open a
shift, click Edit, hover each time link, read the resulting tooltip, close the dialog) and check
`scan-script.js` and the discovery tools' logic, without needing a browser or real WellSky access.

## What's not built yet

- Since today/future shifts are already skipped, in-progress (yellow) and scheduled/upcoming
  (blue) statuses shouldn't normally appear in scan results at all — if one ever does (e.g. an
  overnight shift spanning midnight), it's still included rather than dropped, so it's visible for
  a human to check.
- Cancelled (orange/gray) shift variants aren't specially handled yet — they'll come through
  whatever their raw status maps to.
- Anything beyond what's visible on one screen (no auto-scroll/paging).
- WellSky login automation (intentionally out of scope).
