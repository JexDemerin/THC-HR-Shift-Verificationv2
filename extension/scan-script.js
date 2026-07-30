// Real shift scanner.
//
// Runs only when injected on demand from popup.js after the user clicks
// "Scan Schedule" — never automatically. Calendar-level parsing reuses the
// markup confirmed for the original WellSky Shift Scanner: each caregiver is
// a <tr class="sched_row">, and each shift is a <div class="_event
// STATUS_TOKEN ajSet" data-event-id data-event-type data-start data-end>
// living inside a <td class="day-data">.
//
// For each COMPLETED (green) shift, this also clicks it open, clicks Edit,
// and reads the four Actual/Scheduled clock times -- a real capture (Phase 0
// discovery via inspect-care-log-script.js) confirmed the mechanism: hovering
// a.actual_start / a.scheduled_start / a.actual_end / a.scheduled_end makes
// a brand-new `<div class="_ptip ...">` appear elsewhere on the page with the
// plain timestamp as its text, and it's a fresh element each time rather than
// one that gets reused/updated in place. Everything else (red/incomplete
// shifts, all other statuses) is never clicked -- only completed shifts have
// anything worth reading here, and touching the page for records that don't
// need it is needless risk against a real payroll system.
//
// Only ever closes via Escape or a "Cancel"-labeled control -- never Save.
// This is a read-only inspection pass; it must never alter WellSky's data.

(async function () {
  const STATUS_MAP = {
    SCHEDULED: 'upcoming',
    IN_PROGRESS: 'ongoing',
    COMPLETED: 'completed',
    MISSED_CLOCK_IN: 'incomplete',
    MISSED_CLOCK_OUT: 'incomplete',
    CANCELLED_BY_CAREGIVER: 'cancelled_by_caregiver',
    CANCELLED_BY_CLIENT: 'cancelled_by_client',
    CANCELLED_BY_OFFICE: 'cancelled_by_office',
  };

  const CLICK_SETTLE_MS = 4000; // max time to poll for a popup/dialog/link to appear after a click
  const HOVER_SETTLE_MS = 400; // confirmed to be enough in Phase 0 discovery
  const CLOSE_SETTLE_MS = 500;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // The shift's summary popup and Edit Care Log dialog can load some of
  // their content via a follow-up AJAX call (a real capture showed a
  // `data-ptip-url` fetch on the shift element itself) -- a fixed delay is
  // fragile against that, so this polls until the condition is true instead
  // of assuming a fixed wait was long enough.
  async function waitFor(conditionFn, { timeoutMs = 3000, intervalMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let result = conditionFn();
    while (!result && Date.now() < deadline) {
      await sleep(intervalMs);
      result = conditionFn();
    }
    return result || null;
  }

  function parseTimestamp(raw) {
    if (!raw) return null;
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?/);
    if (!m) return null;
    return {
      date: `${m[1]}-${m[2]}-${m[3]}`,
      hour: parseInt(m[4], 10),
      minute: parseInt(m[5], 10),
    };
  }

  // Lowercase am/pm to match the format asked for in the payroll cell notes
  // (e.g. "1:00pm - 5:05pm = 4h5m (Client Name)").
  function formatTime12h(t) {
    if (!t) return null;
    const h12 = ((t.hour + 11) % 12) + 1;
    const ampm = t.hour < 12 ? 'am' : 'pm';
    return `${h12}:${String(t.minute).padStart(2, '0')}${ampm}`;
  }

  function minutesBetween(start, end) {
    if (!start || !end) return null;
    const startMinutes = start.hour * 60 + start.minute;
    let endMinutes = end.hour * 60 + end.minute;
    // An end date after the start date means the shift crossed midnight.
    if (end.date > start.date) endMinutes += 24 * 60;
    const diff = endMinutes - startMinutes;
    return diff >= 0 ? diff : null;
  }

  function extractClientName(eventEl) {
    const nameAnchor = eventEl.querySelector('.title .name');
    if (!nameAnchor) return null;
    const clone = nameAnchor.cloneNode(true);
    const timeSpan = clone.querySelector('.time');
    if (timeSpan) timeSpan.remove();
    const text = clone.textContent.replace(/\s+/g, ' ').trim();
    return text || null;
  }

  // The Activity Note behind the small marker in a shift label's corner.
  // Confirmed markup:
  //   <div class="_pop_note note_exists"
  //        data-ptip-url="/scheduling/note/get/?carelog=846292420&..."
  //        style="display:none">
  //
  // Read by fetching that `data-ptip-url` -- the same same-origin GET the page
  // itself makes when the marker is hovered -- rather than by simulating a
  // hover like the Actual/Scheduled times are.
  //
  // Hovering genuinely cannot work for this one: the marker sits at
  // display:none until the shift is hovered, and that visibility is driven by
  // a CSS :hover rule. CSS :hover follows the real pointer and is NOT
  // triggered by dispatched events, so no synthetic hover can ever reveal the
  // marker -- which is why an earlier hover-based attempt reported "couldn't
  // be read" for every single shift on the schedule. The note text also
  // arrives over the network here, unlike the clock times which are already
  // local by the time the tooltip appears.
  function noteUrlFor(eventEl) {
    const noteEl = eventEl.querySelector('._pop_note[data-ptip-url]');
    return noteEl ? noteEl.getAttribute('data-ptip-url') : null;
  }

  function htmlToPlainText(html) {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function readActivityNote(eventEl) {
    const url = noteUrlFor(eventEl);
    if (!url) return { present: false, value: null };

    try {
      const response = await window.fetch(url, { credentials: 'same-origin' });
      if (!response.ok) {
        return { present: true, value: null, error: `HTTP ${response.status}` };
      }
      const text = htmlToPlainText(await response.text());
      // Plenty of shifts carry the marker element with nothing behind it, so
      // an empty response means "no note", not a failure.
      return { present: true, value: text || null, empty: !text };
    } catch (err) {
      return { present: true, value: null, error: err.message };
    }
  }

  function extractRecord(caregiverName, eventEl) {
    const statusToken =
      Array.from(eventEl.classList).find((c) => c !== '_event' && c !== 'ajSet') || null;
    const mappedStatus = statusToken ? STATUS_MAP[statusToken] : undefined;

    const start = parseTimestamp(eventEl.getAttribute('data-start'));
    const end = parseTimestamp(eventEl.getAttribute('data-end'));
    const clientName = extractClientName(eventEl);
    const shiftDate = (start && start.date) || (end && end.date) || null;

    const isConfident = Boolean(caregiverName && clientName && mappedStatus && shiftDate);
    const finalStatus = isConfident ? mappedStatus : 'unparsed';

    // The span the label shows, whatever the status -- kept even for a missed
    // clock-in/out, where it's the *scheduled* span rather than hours worked,
    // so the payroll cell's hover note can still show what was supposed to
    // happen while the cell total itself stays zero.
    const labelDurationMinutes = minutesBetween(start, end);

    // A missed clock-in/out earns no hours regardless of what WellSky's
    // placeholder start/end times say -- it's zero until someone verifies the
    // real hours with the client, which is the whole point of flagging it.
    const durationMinutes = finalStatus === 'incomplete' ? 0 : labelDurationMinutes;

    return {
      caregiver_name: caregiverName || null,
      client_name: clientName,
      shift_date: shiftDate,
      time_in: formatTime12h(start),
      time_out: formatTime12h(end),
      duration_minutes: durationMinutes,
      label_duration_minutes: labelDurationMinutes,
      actual_time_in: null,
      scheduled_time_in: null,
      actual_time_out: null,
      scheduled_time_out: null,
      status: finalStatus,
      status_raw: statusToken || eventEl.className,
      note: null,
      event_id: eventEl.getAttribute('data-event-id') || null,
      row_key: eventEl.getAttribute('data-event-id') || null,
      scanned_at: new Date().toISOString(),
      // Fields this scan could not determine -- as opposed to ones it read and
      // found genuinely empty. The Sheet mirrors WellSky, so an observed blank
      // SHOULD blank the cell; but a field we simply failed to look at tells us
      // nothing about WellSky, and blanking on that basis would assert
      // something untrue. Those get left as they were instead.
      unread_fields: [],
    };
  }

  // A caregiver with no shift at all on a given date still gets a row, so the
  // log shows "-" rather than silently omitting them.
  function buildNoShiftRecord(caregiverName, date) {
    return {
      caregiver_name: caregiverName,
      client_name: '-',
      shift_date: date,
      time_in: '-',
      time_out: '-',
      duration_minutes: null,
      label_duration_minutes: null,
      unread_fields: [],
      actual_time_in: '-',
      scheduled_time_in: '-',
      actual_time_out: '-',
      scheduled_time_out: '-',
      status: 'no_shift',
      status_raw: '-',
      note: '-',
      event_id: null,
      // Placeholder rows have no event id to dedup on, so they get a
      // deterministic synthetic key instead.
      row_key: `no-shift:${caregiverName}:${date}`,
      scanned_at: new Date().toISOString(),
    };
  }

  function addDays(isoDate, days) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  // Which date does each day column represent? The visible columns are
  // consecutive days in order, so it's enough to learn ONE column's date from
  // any shift sitting in it and derive the rest by offset. Deriving dates from
  // shift data alone (rather than parsing column headers, whose markup isn't
  // confirmed) means a day where nobody worked still gets its date -- which is
  // exactly the case that needs "-" rows the most.
  function mapColumnsToDates(rows) {
    let columnCount = 0;
    const knownDateByColumn = new Map();

    for (const row of rows) {
      const dayCells = Array.from(row.querySelectorAll('td.day-data'));
      columnCount = Math.max(columnCount, dayCells.length);

      dayCells.forEach((cell, index) => {
        if (knownDateByColumn.has(index)) return;
        const eventEl = cell.querySelector('._event');
        if (!eventEl) return;
        const start = parseTimestamp(eventEl.getAttribute('data-start'));
        const end = parseTimestamp(eventEl.getAttribute('data-end'));
        const date = (start && start.date) || (end && end.date);
        if (date) knownDateByColumn.set(index, date);
      });
    }

    if (knownDateByColumn.size === 0) return [];

    const anchorIndex = Math.min(...knownDateByColumn.keys());
    const anchorDate = knownDateByColumn.get(anchorIndex);
    const dates = [];
    for (let i = 0; i < columnCount; i++) {
      dates.push(knownDateByColumn.get(i) || addDays(anchorDate, i - anchorIndex));
    }
    return dates;
  }

  function scan() {
    const rows = Array.from(document.querySelectorAll('tr.sched_row'));
    const records = [];
    const eventElsByEventId = new Map();
    const columnDates = mapColumnsToDates(rows);

    for (const row of rows) {
      const caregiverAnchor = row.querySelector('.person-name a');
      const caregiverName = caregiverAnchor
        ? caregiverAnchor.textContent.replace(/\s+/g, ' ').trim()
        : null;

      const events = Array.from(row.querySelectorAll('.day-data ._event'));
      const datesWithShifts = new Set();
      for (const eventEl of events) {
        const record = extractRecord(caregiverName, eventEl);
        records.push(record);
        if (record.shift_date) datesWithShifts.add(record.shift_date);
        if (record.event_id) eventElsByEventId.set(record.event_id, eventEl);
      }

      // Every caregiver on screen gets a row for every visible date, so a
      // caregiver with no shift that day shows "-" instead of being missing.
      if (caregiverName) {
        for (const date of columnDates) {
          if (!datesWithShifts.has(date)) {
            records.push(buildNoShiftRecord(caregiverName, date));
          }
        }
      }
    }

    return { records, rowCount: rows.length, eventElsByEventId, columnDates };
  }

  // Date first (chronological), then caregiver name (alphabetical) within each
  // date -- so the log reads as all of 7/27 A-Z, then all of 7/28 A-Z, etc.
  function sortRecords(records) {
    return records.slice().sort((a, b) => {
      const dateA = a.shift_date || '';
      const dateB = b.shift_date || '';
      if (dateA !== dateB) return dateA < dateB ? -1 : 1;
      const nameA = (a.caregiver_name || '').toLowerCase();
      const nameB = (b.caregiver_name || '').toLowerCase();
      if (nameA !== nameB) return nameA < nameB ? -1 : 1;
      // Same caregiver, same day, two clients -- keep a stable, predictable
      // order rather than leaving it to scan order.
      return (a.client_name || '').toLowerCase() < (b.client_name || '').toLowerCase() ? -1 : 1;
    });
  }

  // Today/future days are still in progress or haven't happened -- only
  // fully-elapsed days get scanned. Each shift already carries its own date
  // (from data-start/data-end), so this is a straight per-record filter, no
  // day-column boundaries need to be found.
  function todayIso() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // ---- Reading a completed shift's Edit Care Log times ----

  const CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'FORM', 'ARTICLE']);
  const SIGNALS = {
    summaryPopup: ['Care Log', 'Summary', 'Notes', 'Edit', 'Copy'],
    editCareLog: ['Official', 'Bill Hours', 'Pay Hours', 'Status', 'Client', 'Caregiver'],
  };

  function containsAll(text, phrases) {
    return phrases.every((p) => text.includes(p));
  }

  // jQuery UI dialogs (which this site uses) stay in the DOM when closed and
  // are merely hidden -- so a text-only match would still "find" a dialog
  // that's already been dismissed, which is exactly what made a successful
  // close look like a failure to close.
  //
  // Walks the ancestor chain checking computed display/visibility rather than
  // using offsetParent or getBoundingClientRect: those depend on real layout,
  // which means they'd also be the only thing standing between this working
  // and silently treating everything as hidden in any non-layout environment.
  // display:none doesn't cascade into a child's own computed style, hence the
  // walk instead of a single check.
  function isVisible(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      node = node.parentElement;
    }
    return true;
  }

  function findSmallestMatch(mustContain, { requireVisible = true } = {}) {
    if (!document.body) return null;
    const candidates = Array.from(document.body.querySelectorAll('*')).filter((el) =>
      CONTAINER_TAGS.has(el.tagName)
    );
    let best = null;
    let bestSize = Infinity;
    for (const el of candidates) {
      const text = el.textContent || '';
      if (containsAll(text, mustContain)) {
        if (requireVisible && !isVisible(el)) continue;
        const size = el.outerHTML.length;
        if (size < bestSize) {
          bestSize = size;
          best = el;
        }
      }
    }
    return best;
  }

  function simulateHover(el) {
    const rect = el.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY };
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    el.dispatchEvent(new MouseEvent('pointerover', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
  }

  // The plain `.click()` DOM method dispatches a click with clientX/clientY
  // stuck at 0,0 -- if WellSky's calendar uses the click's screen position
  // for anything (not just which element was clicked), that alone could make
  // a synthetic click behave differently from a real one. Matches the
  // coordinate-aware approach already confirmed to matter for hover.
  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function findLinkByText(container, text) {
    const candidates = Array.from(container.querySelectorAll('a, span, button, [role="button"]'));
    return candidates.find((el) => (el.textContent || '').trim() === text) || null;
  }

  function snapshotAllElements() {
    return new Set(document.querySelectorAll('*'));
  }

  // Only the outermost new nodes -- skips a new element's children, which
  // are also "new" but just noise for a short diagnostic text snippet.
  function findNewTopLevelElements(before, after) {
    const isNew = (el) => !before.has(el);
    return Array.from(after)
      .filter(isNew)
      .filter((el) => !el.parentElement || !isNew(el.parentElement));
  }

  // Recorded in place of a scheduled time when the shift genuinely has no
  // scheduled time to read -- confirmed against a real shift whose dialog
  // showed "Set to: Actual" with no "| Scheduled" link beside it at all.
  // That's a real property of the shift, not a read failure, so it gets its
  // own explicit value rather than being left blank (which would be
  // indistinguishable from something having gone wrong).
  const NO_SCHEDULED_VALUE = 'only had actual hours';

  // The four fields that only the Edit Care Log click-through can supply.
  // If that click-through never got far enough to look, all four are unread.
  const TIME_FIELDS = [
    'actual_time_in',
    'scheduled_time_in',
    'actual_time_out',
    'scheduled_time_out',
  ];

  // Hovers one quick-time link and reads the resulting `._ptip` tooltip node
  // that appears elsewhere on the page -- confirmed via a real Phase 0
  // capture. Removes the tooltip node afterward so repeated runs don't leave
  // a growing pile of stray floating timestamp divs on the page.
  //
  // Returns { present: false } when the link isn't in the dialog at all
  // (nothing to read -- expected for a shift with no scheduled time), versus
  // { present: true, value: null } when the link IS there but hovering it
  // didn't produce a tooltip (a real problem worth reporting).
  async function readQuickTime(dialogEl, linkClass) {
    const link = dialogEl.querySelector(`a.${linkClass}`);
    if (!link) return { present: false, value: null };

    const before = new Set(document.querySelectorAll('._ptip'));
    simulateHover(link);
    await sleep(HOVER_SETTLE_MS);
    const after = Array.from(document.querySelectorAll('._ptip'));
    const tooltip = after.find((el) => !before.has(el));
    if (!tooltip) return { present: true, value: null };

    const text = (tooltip.textContent || '').trim();
    tooltip.remove();
    return { present: true, value: text || null };
  }

  // Returns the four time values plus the list of fields that failed to read
  // for a reason worth flagging -- a genuinely-absent scheduled time isn't
  // one of those, it's recorded as NO_SCHEDULED_VALUE instead.
  async function readCareLogTimes(dialogEl) {
    const reads = {
      actual_time_in: await readQuickTime(dialogEl, 'actual_start'),
      scheduled_time_in: await readQuickTime(dialogEl, 'scheduled_start'),
      actual_time_out: await readQuickTime(dialogEl, 'actual_end'),
      scheduled_time_out: await readQuickTime(dialogEl, 'scheduled_end'),
    };

    const times = {};
    const unreadable = [];
    for (const [field, read] of Object.entries(reads)) {
      const isScheduledField = field.startsWith('scheduled_');
      if (read.value) {
        times[field] = read.value;
      } else if (!read.present && isScheduledField) {
        times[field] = NO_SCHEDULED_VALUE;
      } else {
        times[field] = null;
        unreadable.push(field);
      }
    }

    return { times, unreadable };
  }

  // Never clicks Save. Tries, in order: Escape (dispatched both broadly and
  // directly on the dialog itself, since a real run showed this site uses
  // jQuery UI Dialog widgets -- seen on the "Add Unavailability" popup,
  // class="ui-dialog ui-widget..." -- and jQuery UI's own keydown handling
  // for Escape may be bound to the dialog widget rather than the document,
  // which a document-only dispatch would never reach); the dialog's
  // standard jQuery UI titlebar close (X) button, `.ui-dialog-titlebar-close`
  // -- confirmed present on this site's dialogs; then a control whose text
  // is exactly "Cancel" -- never anything containing "Save".
  async function closeDialog(dialogEl) {
    const escOpts = { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27 };
    document.dispatchEvent(new KeyboardEvent('keydown', escOpts));
    document.dispatchEvent(new KeyboardEvent('keyup', escOpts));
    if (dialogEl) {
      dialogEl.dispatchEvent(new KeyboardEvent('keydown', escOpts));
      dialogEl.dispatchEvent(new KeyboardEvent('keyup', escOpts));
    }
    await sleep(CLOSE_SETTLE_MS);

    if (!findSmallestMatch(SIGNALS.editCareLog)) return true;

    // Scope to THIS dialog's own .ui-dialog wrapper where possible -- the page
    // can hold several jQuery UI dialogs at once (closed ones stay in the DOM,
    // merely hidden), so an unscoped lookup could grab a different dialog's
    // close button. Falling back to a document-wide search, only visible
    // controls are considered, for the same reason.
    const dialogWrapper = dialogEl && dialogEl.closest('.ui-dialog');
    const titlebarClose = dialogWrapper
      ? dialogWrapper.querySelector('.ui-dialog-titlebar-close')
      : Array.from(document.querySelectorAll('.ui-dialog-titlebar-close')).find(isVisible);
    if (titlebarClose) {
      simulateClick(titlebarClose);
      await sleep(CLOSE_SETTLE_MS);
    }

    if (!findSmallestMatch(SIGNALS.editCareLog)) return true;

    const cancelScope = dialogWrapper || document;
    const cancelLink = Array.from(cancelScope.querySelectorAll('a, button')).find(
      (el) => (el.textContent || '').trim() === 'Cancel' && isVisible(el)
    );
    if (cancelLink) {
      simulateClick(cancelLink);
      await sleep(CLOSE_SETTLE_MS);
    }

    return !findSmallestMatch(SIGNALS.editCareLog);
  }

  // Confirmed via inspect-shift-click-script.js's debug tool against a real
  // shift: `.title` contains TWO links -- a "send email" link first, then
  // `a.name` (the client name + time) -- and only clicking `a.name`
  // (with real click coordinates) opens the shift's own summary bubble.
  // Clicking the wrapper, or `.title` itself, or the first link, all open
  // something else entirely ("Add Unavailability" or a send-email form).
  function shiftClickTarget(eventEl) {
    return eventEl.querySelector('.title .name') || eventEl.querySelector('.title') || eventEl;
  }

  function textSnippet(el, maxLength = 120) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  // Returns the four time fields for one completed shift, or null if any
  // step of the click-through didn't find what it expected -- never guesses
  // a value it isn't sure about. Always reports a diagnostic string
  // explaining what actually happened, so a failure is visible and
  // debuggable instead of just silently leaving the four fields blank.
  async function enrichCompletedShift(eventEl) {
    const before = snapshotAllElements();

    // Clicked up to twice: on a real run a handful of shifts out of ~60 saw
    // nothing at all appear, with no wrong popup either -- the signature of a
    // click that simply didn't land (the row still settling, or the previous
    // shift's popup only just finished tearing down) rather than a wrong
    // target, which would have opened something. One retry costs a second and
    // fixes a transient miss; anything still failing after it gets reported.
    let popup = null;
    for (let attempt = 0; attempt < 2 && !popup; attempt++) {
      if (attempt > 0) await sleep(CLOSE_SETTLE_MS);
      simulateClick(shiftClickTarget(eventEl));
      popup = await waitFor(() => findSmallestMatch(SIGNALS.summaryPopup), { timeoutMs: CLICK_SETTLE_MS });
    }

    if (!popup) {
      const newEls = findNewTopLevelElements(before, snapshotAllElements());
      const closedOk = await closeDialog();
      const seen = newEls.length ? textSnippet(newEls[0]) : '(nothing new appeared)';
      return { times: null, closedOk, unreadable: TIME_FIELDS, diagnostic: `Expected summary popup didn't open. Instead: ${seen}` };
    }

    // Re-query rather than trust the first `popup` reference -- some of its
    // content (like the Edit link) may load in via a follow-up AJAX call
    // after the popup shell itself already matched.
    const editLink = await waitFor(() => {
      const current = findSmallestMatch(SIGNALS.summaryPopup) || popup;
      return findLinkByText(current, 'Edit');
    }, { timeoutMs: CLICK_SETTLE_MS });
    if (!editLink) {
      const closedOk = await closeDialog();
      return { times: null, closedOk, unreadable: TIME_FIELDS, diagnostic: `Summary popup opened but no "Edit" link found in it.` };
    }

    simulateClick(editLink);

    const dialog = await waitFor(() => findSmallestMatch(SIGNALS.editCareLog), { timeoutMs: CLICK_SETTLE_MS });
    if (!dialog) {
      const closedOk = await closeDialog();
      return { times: null, closedOk, unreadable: TIME_FIELDS, diagnostic: `Clicked Edit but the Edit Care Log dialog never matched.` };
    }

    const { times, unreadable } = await readCareLogTimes(dialog);
    const closedOk = await closeDialog(dialog);
    const diagnostic = unreadable.length
      ? `Dialog opened but couldn't read: ${unreadable.join(', ')}`
      : null;
    return { times, closedOk, unreadable, diagnostic };
  }

  // ---- Run it ----

  const { records: allRecords, rowCount, eventElsByEventId, columnDates } = scan();
  const today = todayIso();
  // Keep anything without a parseable date too (rather than silently dropping
  // it) -- it's already flagged as "unparsed" and needs a human look either way.
  const records = sortRecords(allRecords.filter((r) => !r.shift_date || r.shift_date < today));
  const skippedTodayOrFuture = allRecords.length - records.length;

  let stoppedEarlyReason = null;
  const enrichmentDiagnostics = [];

  // Activity notes first: reading one only needs hovers, no dialogs, so doing
  // this pass separately keeps it clear of the click-through's popup state.
  for (const record of records) {
    if (!record.event_id) continue;
    const eventEl = eventElsByEventId.get(record.event_id);
    if (!eventEl) continue;

    const note = await readActivityNote(eventEl);
    if (note.value) {
      record.note = note.value;
    } else if (note.error) {
      // Only a genuine failure is worth reporting -- and the note field is
      // marked unread so the Sheet keeps whatever it already had rather than
      // blanking it on the strength of a failed request. A marker with nothing
      // behind it is a real empty note and is left to blank the cell.
      record.unread_fields.push('note');
      enrichmentDiagnostics.push(
        `${record.caregiver_name}/${record.client_name} (${record.shift_date}): couldn't read its activity note (${note.error}).`
      );
    }
  }

  for (const record of records) {
    if (record.status !== 'completed' || !record.event_id) continue;
    const eventEl = eventElsByEventId.get(record.event_id);
    if (!eventEl) continue;

    const { times, closedOk, diagnostic, unreadable } = await enrichCompletedShift(eventEl);
    if (times) Object.assign(record, times);
    // Whatever the click-through couldn't determine is marked unread, so the
    // Sheet keeps its existing value for those fields instead of being told
    // WellSky has nothing there. Everything it DID read -- including a
    // genuinely absent scheduled time -- overwrites as normal.
    for (const field of unreadable || TIME_FIELDS) {
      if (record.unread_fields.indexOf(field) === -1) record.unread_fields.push(field);
    }
    if (diagnostic) {
      enrichmentDiagnostics.push(`${record.caregiver_name}/${record.client_name} (${record.shift_date}): ${diagnostic}`);
    }

    if (!closedOk) {
      // The dialog didn't close the way we expect -- stop rather than risk
      // clicking blindly into whatever state the page is actually in now.
      // Include what's actually still matching, so a repeat of this is
      // diagnosable from the log alone instead of needing another debug run.
      const stillOpen = findSmallestMatch(SIGNALS.editCareLog);
      const stillOpenDesc = stillOpen
        ? `still matching: <${stillOpen.tagName.toLowerCase()} class="${stillOpen.className}">`
        : 'nothing visible still matches (so this may be a false alarm)';
      stoppedEarlyReason =
        `Could not confirm the Edit Care Log dialog closed after reading ${record.caregiver_name}/` +
        `${record.client_name} (${record.shift_date}) -- ${stillOpenDesc}. ` +
        `Stopped early -- reload the WellSky page and re-scan.`;
      break;
    }
  }

  const summary = {
    total: records.length,
    completed: records.filter((r) => r.status === 'completed').length,
    incomplete: records.filter((r) => r.status === 'incomplete').length,
    upcoming: records.filter((r) => r.status === 'upcoming').length,
    ongoing: records.filter((r) => r.status === 'ongoing').length,
    cancelled: records.filter((r) => r.status.startsWith('cancelled_')).length,
    unparsed: records.filter((r) => r.status === 'unparsed').length,
    no_shift: records.filter((r) => r.status === 'no_shift').length,
  };

  return {
    records,
    summary,
    rowCount,
    columnDates,
    skippedTodayOrFuture,
    stoppedEarlyReason,
    enrichmentDiagnostics,
    pageUrl: window.location.href,
    scannedAt: new Date().toISOString(),
  };
})();
