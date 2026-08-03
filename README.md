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
  — into a `note` column, by fetching that marker's `data-ptip-url` (the same same-origin GET the
  page itself makes on hover). Unlike the clock times, this one genuinely *can't* be done by
  simulating a hover: the marker sits at `display:none` until the shift is hovered, and that
  visibility comes from a CSS `:hover` rule, which follows the real pointer and is never triggered
  by dispatched events. A marker with an empty response just means that shift has no note; only a
  real fetch failure is reported.
- Records come out sorted **by date, then caregiver name alphabetically** (all of 7/27 A–Z, then all
  of 7/28 A–Z, …), so that's the order they land in the sheet.

### What lands in the Sheet

Two tabs per month, created automatically and named `2026 - 07 Log (July)` /
`2026 - 07 Payroll (July)` — leading with the zero-padded year and month so the tabs stay in
chronological order, with the month name spelled out for readability.

Which month a row lands in comes from its own `shift_date`, **not** from when the tab was created or
when the scan ran: a 7/31 shift files under July even if scanned in August, and scanning a week that
straddles a month boundary creates both months' tabs and splits the rows correctly. A tab left over
from either earlier naming (`2026-07 Log` or `July 2026 Log`) is **renamed** rather than left orphaned
beside a new one, so already-scanned rows carry over. The rename is skipped if a tab under the
current name already exists, so it can never collide — and nothing is ever deleted.

**Headers are verified on every write, not just when a tab is created.** If a tab's header row was
deleted or edited by hand, it's restored. If a tab predates a column being added, its existing rows
are **remapped by column name** rather than the header row simply being overwritten — otherwise
every value after an inserted column would silently shift one place and end up labelled as the wrong
field, which for payroll timestamps is worse than an outright failure. Values whose column no longer
exists are dropped rather than shifted; genuinely new columns start blank — except for a column that
was *renamed*, which `COLUMN_RENAMES` follows to its new name so its values move with it instead of
being thrown away. The Payroll tab is fully
rebuilt each scan (notes included, since a stale note would strand an old breakdown on a changed
cell), so its date/weekday header rows can't drift.

- **`2026 - 07 Log (July)`** — one row per shift (or per idle caregiver/day, reading `-`), with
  `caregiver_name`, `client_name`, `shift_date`, `official_time_in`, `official_time_out`,
  `duration_minutes`, `label_duration_minutes`, the four actual/scheduled times, `status`,
  `status_raw`, `note`, `event_id`, `row_key`, `scanned_at`. (`duration_minutes` is the payable span
  — zero for a missed clock-in/out — while `label_duration_minutes` keeps the scheduled span
  regardless of status, so the payroll note can show it without it reaching the total.)
  See "Re-scanning" below for how repeat scans merge into it.

  **Three pairs of times, three different facts.** `official_*` is the time on the calendar label —
  what the Edit Care Log dialog itself labels "Official", i.e. the agreed hours the shift is paid on.
  It reads straight off the schedule with no clicking, exists for every shift, and is what
  `duration_minutes` and the payroll hours come from. `actual_*` is the raw clock punch, which can
  differ sharply (one real capture showed Official `9:00 AM` against an actual punch of `1:35:33 PM`).
  `scheduled_*` is the original plan. The last two only exist for completed shifts, since only the
  click-through can read them. The `actual_*`/`scheduled_*` values drop their leading date, which
  `shift_date` already carries — **unless** it differs, so an overnight shift's next-day clock-out
  stays visible rather than reading as a time that runs backwards within one day.
- **`2026 - 07 Payroll (July)`** — caregivers down the left, **every** date in the month across the top as
  `7/1`, `7/2`, … with its weekday (`Mon`, `Tue`, …) beneath, and a shaded spacer column between
  each Saturday and Sunday so weeks read separately. The whole month's grid exists upfront; each
  scan drops data into the right columns, so it fills in progressively as you scan more weeks.

  **Layout** (all of it rewritten on every scan, so hand edits to the tab's formatting won't stick):
  date columns are 45px and the week spacers 20px, so a 31-day month plus its spacers stays on one
  screen. Both header rows are green (`#93c47d` — deliberately a stronger green than the
  completed-shift `#b7e1cd` below, so a header never reads as a data cell), with the spacer columns
  staying grey right through the headers so each week reads as one block. Dates, weekdays and hours
  are centered; caregiver names stay left-aligned, where a column of names is easiest to scan down.

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
incomplete log can never hide behind a completed one. Hover any cell for a per-shift breakdown —
hours first, then the activity note if there is one, with a blank line between shifts:

```
07/27/2026 (Kozuka-Ssenyan, Mia)
9:00am - 4:00pm = 7h
-----------------------------
Activity Note: 07/14/26: On a vacation with their father, July 22-31
```

WellSky pads every note with a bookkeeping parenthetical — `(Added to shift that Occurs once on
07/27/2026 from 06:00 AM PDT ... assigned to caregiver Natalia Williams)`, often twice — which just
repeats the shift, client and caregiver the cell already identifies. Its note text also carries its
own `Activity Note:` label, which the cell would otherwise double up
(`Activity Note: Activity Note: 07/18/26: No Shift as per Mom`). Both are stripped from the grid
notes; the full untouched text stays in the Log tab's `note` column. Only a *leading* label is
removed — a note that happens to mention the phrase mid-sentence is left exactly as written.

An **incomplete** shift's cell reads `0`, but its note line still shows the scheduled span, total,
and client so the office knows what was supposed to happen. Those hours deliberately don't reach the
cell total, since nobody has verified them yet.

**Sibling care** is detected and counted once: one caregiver looking after two siblings over the
same hours shows up as two shifts with identical start and end times, and those hours were only
worked once. So `1:00pm-4:00pm` for two siblings totals **3 hours, not 6**. Both clients still get
their own note line. Only exactly-identical times count — back-to-back or partially overlapping
shifts are both counted in full. (This is the one place the Client Hours tab deliberately disagrees
— see below.)

A date with no record at all (not yet scanned, or still in the future) is left **blank** rather than
`-`, since `-` specifically means "scanned, and they didn't work".

- **`2026 - 07 Client Hours (July)`** — the same grid pivoted onto **clients**, built from the same
  Log tab. Identical layout, colors, rounding and hover notes; the only differences are that the left
  column lists clients and each note names the **caregiver** rather than the client (naming the row's
  own subject would just repeat the row label).

**Payroll answers "how many hours did this caregiver work?"; Client Hours answers "how many hours of
care did this client receive?"** Those are the same number except for sibling care, where they
legitimately differ:

| | Payroll | Client Hours |
|---|---|---|
| One caregiver, two siblings, both `1:00pm-4:00pm` | **3h** on the caregiver | **3h** on *each* child |

The caregiver worked three hours and must not be paid for six; each child received three hours of
care and neither should show half of it. Pivoting the axis produces this on its own — the
"identical times count once" rule is scoped within a cell, and two siblings are two different cells
on the client axis. So a day's totals across the two tabs won't always match, and that's correct
rather than a bug.

Two things follow from clients having no equivalent of WellSky's caregiver column:

- **There is no client roster**, so a client only appears if they had a shift. A client with no
  visits in a scanned week has no row at all, which means blank cells are more common here than in
  Payroll and `-` appears less often.
- **The idle-caregiver placeholder rows are excluded.** Those carry `client_name` of `-`, which
  pivoted naively would collapse into a phantom client called `-` spanning the whole month.

Scanning a shift with a click-through takes a few seconds each (open, read, close), so a schedule
with many completed shifts visible at once will take a while to finish — that's expected. Since each
scan only sees one visible week, a full month's grid tabs fill in over several scans.

### Re-scanning: what changes and what doesn't

WellSky shows one week at a time, so building up a month means scanning several weeks, and
re-scanning a week you've already done (e.g. today, to pick up yesterday's now-finished shifts).
That's expected and safe:

- **Other weeks go to the right place.** Every row is filed by its own `shift_date`, so a week
  spanning a month boundary splits correctly across both months' tabs, and rows always land in date
  order with caregivers alphabetical within each date.
- **The sheet mirrors WellSky.** A re-scan's result wins, blanks included — if a value was cleared
  in WellSky, the cell gets cleared too, because anything else stops it being a faithful copy.
- **…except for a field the scan couldn't actually read.** The Edit Care Log click-through
  occasionally fails to open, and that blank isn't an observation about WellSky — it's "we didn't
  manage to look". Blanking a cell on that basis would put a claim in the sheet that was never seen,
  so the scanner reports exactly which fields it couldn't determine and those keep their previous
  value. Every such shift is named in the popup's log, so a preserved value is never silent. Fields
  it *did* read always overwrite, including a genuinely-absent scheduled time.
- **Deleted shifts don't linger.** Each scan emits a row for every caregiver on screen × every past
  visible date, so the caregiver/date pairs it sends are exactly what it had authoritative knowledge
  of. Within those pairs its result is treated as the truth, so a shift that was deleted or
  recreated in WellSky (new `event_id`) doesn't leave a ghost row behind. Rows for any *other*
  caregiver/date — a different week, or a caregiver scrolled out of view — are left completely
  untouched.

## Setup

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select the
   `extension/` folder.
2. In your destination Google Sheet: **Extensions → Apps Script**, paste in
   `apps_script/Code.gs`, then **Deploy → New deployment → Web app** (execute as yourself, access
   per your security needs). Copy the deployment URL.
3. Click the extension icon → **Settings** → paste the Web App URL → **Save**.

### Updating the Apps Script (this is the #1 thing that goes wrong)

**Saving the script does NOT change what a published Web App serves.** A live Web App keeps serving
the last *deployed version*, so pasting new code and hitting Save leaves the extension talking to
the old code — which quietly produces no monthly Log/Payroll tabs at all, since older versions don't
know how to build them. To actually update it:

1. Sheet → **Extensions → Apps Script**, replace all the code with `apps_script/Code.gs`, **Save**.
2. **Deploy → Manage deployments →** the **pencil icon** on the existing deployment →
   Version: **New version** → **Deploy**.

Use the pencil on the *existing* deployment — creating a separate "New deployment" mints a
different URL that the extension isn't pointed at.

**To check what's actually live:** open your Web App URL in a browser. It returns the deployed
version, e.g. `{"ok":true,"script_version":4,...}`. Both sides also check this automatically —
`Code.gs` reports its `SCRIPT_VERSION` on every write, and the popup names the mismatch and the fix
if it doesn't match what the extension expects, rather than letting a stale deployment look like a
successful scan.

## Using it

Clicking the toolbar icon opens the control panel in Chrome's **side panel** — docked beside
WellSky, staying open while you click around the page, closed with the X in its own header.

It deliberately isn't the usual dropdown popup, and that isn't a preference: Chrome closes an action
popup the instant it loses focus and there is no way to prevent that from inside it. Since the scan
is driven from that page, a stray click used to kill a scan mid-run and lose everything it had
gathered. (On Chrome older than 114, where side panels don't exist, it falls back to a standalone
window — which survives losing focus too.)

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
