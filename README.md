# THC-HR-Shift-Verificationv2 — WellSky Shift Log

A Chrome extension that mirrors WellSky shift records — caregiver, client, date, status, exact
actual/scheduled clock-in/out times, and activity notes — into a Google Sheet, as a per-month
**Log** tab (one row per shift) plus a per-month **Payroll** tab (caregiver × date grid of hours).

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
- For every **completed (green)** shift, it also clicks the shift's `a.name` link open — the
  client-name/time link nested two levels inside `.title` (`.title` also contains a "send email"
  link that comes first, and clicking the wrapper or `.title` itself both land on WellSky's generic
  "Add Unavailability" popup instead, confirmed via the click-target debug tool) — clicks **Edit**,
  and reads the four real clock times off the Edit Care Log dialog — `actual_time_in`,
  `scheduled_time_in`, `actual_time_out`, `scheduled_time_out` — then closes the dialog (Escape, or
  a "Cancel" control; **never Save**) before moving to the next shift. Every click uses the
  element's real on-screen position, not just which element it targets — the plain `.click()` DOM
  method always dispatches at 0,0, and WellSky's calendar appears to use click position for more
  than just hit-testing. A real capture confirmed the time-reading mechanism: hovering
  `a.actual_start` / `a.scheduled_start` / `a.actual_end` / `a.scheduled_end` makes a brand-new
  `<div class="_ptip ...">` tooltip node appear elsewhere on the page with the plain timestamp as
  its text (not a `title` attribute, which is what the first two attempts guessed and got stuck
  on) — the extension simulates that hover itself, no mouse movement needed.
- Waits for the summary popup, its Edit link, and the Edit Care Log dialog by **polling**, not a
  fixed delay — the shift element's own markup showed a follow-up AJAX fetch (`data-ptip-url`) for
  at least some of its content, so a fixed wait would be fragile against real network latency.
- Closes the dialog by trying, in order: Escape dispatched both broadly and directly on the dialog
  itself (this site uses jQuery UI Dialog widgets, whose Escape handling may be bound to the widget
  rather than the document), the dialog's standard jQuery UI titlebar close (X) button
  (`.ui-dialog-titlebar-close`), then a control whose text is exactly "Cancel" — never anything
  containing "Save".
- Treats a **hidden** dialog as closed. jQuery UI closes a dialog by setting `display:none` and
  leaving it in the DOM, so an is-it-still-in-the-page check can't tell "closed" from "never
  closed" — that's what made a real run read all four times successfully and *still* stop early
  every time, skipping every later shift. Visibility is determined by walking the ancestor chain's
  computed `display`/`visibility` rather than `offsetParent`/`getBoundingClientRect`, since those
  need real layout and would report everything as hidden in a test environment.
- If the dialog doesn't visibly close the way expected after reading a shift, scanning **stops
  early** rather than continuing to click on a page that might not be in the state it expects, and
  says why in the popup's log.
- Some shifts genuinely have no scheduled time — their dialog shows "Set to: Actual" with no
  "| Scheduled" link at all. Those record **`only had actual hours`** in the two scheduled columns,
  which is a real property of the shift rather than a failure, so it isn't reported as one. A
  scheduled link that *is* present but produces nothing when hovered still gets flagged.
- If any shift's click-through doesn't behave as expected (wrong popup opens, no Edit link found,
  dialog never matches, a time that should be readable comes back blank), that's reported as a
  per-shift diagnostic line in the popup's log instead of just leaving the four fields silently
  blank.
- **Every caregiver in the left-hand column gets a row for every visible past date**, not just the
  ones who worked. A caregiver with no shift that day reads `-` across the row, so the log shows
  who was idle instead of silently omitting them. Column dates are derived by counting from any
  column whose date is known, so a day where *nobody* worked still gets its `-` rows.
- Reads each shift's **activity note** — the text behind the small marker in a shift label's corner
  (`._pop_note.note_exists`) — into a `note` column, via the same simulated-hover mechanism.
- Records come out sorted **by date, then caregiver name alphabetically** (all of 7/27 A–Z, then all
  of 7/28 A–Z, …), so that's the order they land in the sheet.

### What lands in the Sheet

Two tabs per month, created automatically, keyed off each record's own `shift_date` — so a scan
spanning a month boundary files each row in the right month:

- **`2026-07 Log`** — one row per shift (or per idle caregiver/day, reading `-`), with
  `caregiver_name`, `client_name`, `shift_date`, `time_in`, `time_out`, `duration_minutes`, the four
  actual/scheduled times, `status`, `status_raw`, `note`, `event_id`, `row_key`, `scanned_at`.
  Re-scanning updates an existing row rather than duplicating it, and a caregiver/day that gains a
  real shift has its stale `-` row removed.
- **`2026-07 Payroll`** — caregivers down the left, **every** date in the month across the top as
  `7/1`, `7/2`, … with its weekday (`Mon`, `Tue`, …) beneath, and a shaded spacer column between
  each Saturday and Sunday so weeks read separately. The whole month's grid exists upfront; each
  scan drops data into the right columns, so it fills in progressively as you scan more weeks.

Each payroll cell holds that caregiver's **total hours for the day** as a decimal, using payroll's
quarter-hour rounding applied to the day's total (0–7 leftover minutes → `.00`, 8–22 → `.25`,
23–37 → `.50`, 38–52 → `.75`, 53+ → next full hour), colored to match the WellSky legend:

| Status | Cell | Color |
|---|---|---|
| completed | rounded decimal hours | green |
| incomplete (missed clock in/out) | `0` | red |
| ongoing | `ongoing` | yellow |
| upcoming/scheduled | *(blank)* | dark blue |
| cancelled by caregiver | `0` | orange |
| cancelled by office | `0` | darker orange |
| cancelled by client | `0` | sky blue |
| no shift that day | `-` | none |

If a caregiver had more than one shift that day, the **most urgent status wins** the color, so an
incomplete log can never hide behind a completed one. Hover any cell for a per-client breakdown,
one line each: `1:00pm - 5:05pm = 4h5m (Chiang, Ryan)`. Incomplete shifts get no note line — their
start/end times are WellSky placeholders, not hours anyone actually worked.

A date with no record at all (not yet scanned, or still in the future) is left **blank** rather than
`-`, since `-` specifically means "scanned, and they didn't work".

Scanning a shift with a click-through takes a few seconds each (open, read, close), so a schedule
with many completed shifts visible at once will take a while to finish — that's expected. Since each
scan only sees one visible week, a full month's Payroll tab fills in over several scans.

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
2. Click the extension icon → **Scan Schedule**. Records get written to that month's Log and
   Payroll tabs. Completed shifts take a few seconds each while it clicks through and reads their
   times — watch the popup's log for progress, and don't touch the WellSky tab while it's running.
3. Scroll/change the view (different week, different caregiver group) and scan again to cover
   more — it only reads what's currently on screen, same as the original scanner. Repeat across the
   weeks of a month to fill in that month's Payroll grid.

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
- **"Debug: Inspect Shift Click"** — for the still-unsolved part of this: a real run showed
  clicking the outer shift wrapper opens WellSky's generic "Add Unavailability" popup instead of
  the shift's own summary, and clicking `.title` produced nothing detectable. This tool tries
  several candidate click targets on one completed shift (the wrapper, `.title`, the name/time
  spans inside it, any nested link) using a real click position — not the plain `.click()` method,
  which always dispatches at 0,0 — and reports, for each, whether anything new appeared anywhere on
  the page, including a pre-rendered element that was hidden and became visible instead of a brand
  new node being created. **This is diagnostic only — reload the WellSky tab afterward regardless
  of the result**, since it may leave something open if Escape didn't close it.

## Testing

`npm test` (needs `npm install` once first) runs `tests/*.test.js`, none of which need a browser,
an API key, or real WellSky access:

- **Scanner tests** use `jsdom` against fixture HTML matching WellSky's confirmed markup —
  including a full simulated click-through (open a shift, click Edit, hover each time link, read the
  resulting tooltip, close the dialog), the `-` rows for idle caregivers, date/name sort order,
  overnight shifts, and activity-note reading.
- **Apps Script tests** load `apps_script/Code.gs` directly in Node (it's plain ES5) with the Sheets
  globals stubbed, and check the pure logic: quarter-hour rounding, month lengths, the payroll
  column layout and Sat/Sun spacer placement, most-urgent-status-wins, cell values, and per-client
  note aggregation.

## What's not built yet

- Since today/future shifts are skipped, in-progress (yellow) and scheduled/upcoming (blue)
  statuses shouldn't normally appear at all — if one ever does (e.g. an overnight shift spanning
  midnight), it's still included rather than dropped, so it's visible for a human to check.
- Anything beyond what's visible on one screen (no auto-scroll/paging) — so covering a full month
  means scanning each week and re-running.
- WellSky login automation (intentionally out of scope).
