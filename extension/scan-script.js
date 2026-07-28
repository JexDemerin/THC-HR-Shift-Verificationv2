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

  const CLICK_SETTLE_MS = 1200; // popup/dialog open transitions -- real network/render latency
  const HOVER_SETTLE_MS = 400; // confirmed to be enough in Phase 0 discovery
  const CLOSE_SETTLE_MS = 500;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function parseTimestamp(raw) {
    if (!raw) return null;
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?/);
    if (!m) return null;
    return { date: `${m[1]}-${m[2]}-${m[3]}` };
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

    return {
      caregiver_name: caregiverName || null,
      client_name: clientName,
      shift_date: shiftDate,
      actual_time_in: null,
      scheduled_time_in: null,
      actual_time_out: null,
      scheduled_time_out: null,
      status: finalStatus,
      status_raw: statusToken || eventEl.className,
      event_id: eventEl.getAttribute('data-event-id') || null,
      scanned_at: new Date().toISOString(),
    };
  }

  function scan() {
    const rows = Array.from(document.querySelectorAll('tr.sched_row'));
    const records = [];
    const eventElsByEventId = new Map();

    for (const row of rows) {
      const caregiverAnchor = row.querySelector('.person-name a');
      const caregiverName = caregiverAnchor
        ? caregiverAnchor.textContent.replace(/\s+/g, ' ').trim()
        : null;

      const events = Array.from(row.querySelectorAll('.day-data ._event'));
      for (const eventEl of events) {
        const record = extractRecord(caregiverName, eventEl);
        records.push(record);
        if (record.event_id) eventElsByEventId.set(record.event_id, eventEl);
      }
    }

    return { records, rowCount: rows.length, eventElsByEventId };
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

  function findSmallestMatch(mustContain) {
    if (!document.body) return null;
    const candidates = Array.from(document.body.querySelectorAll('*')).filter((el) =>
      CONTAINER_TAGS.has(el.tagName)
    );
    let best = null;
    let bestSize = Infinity;
    for (const el of candidates) {
      const text = el.textContent || '';
      if (containsAll(text, mustContain)) {
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

  // Hovers one quick-time link and reads the resulting `._ptip` tooltip node
  // that appears elsewhere on the page -- confirmed via a real Phase 0
  // capture. Removes the tooltip node afterward so repeated runs don't leave
  // a growing pile of stray floating timestamp divs on the page.
  async function readQuickTime(dialogEl, linkClass) {
    const link = dialogEl.querySelector(`a.${linkClass}`);
    if (!link) return null;

    const before = new Set(document.querySelectorAll('._ptip'));
    simulateHover(link);
    await sleep(HOVER_SETTLE_MS);
    const after = Array.from(document.querySelectorAll('._ptip'));
    const tooltip = after.find((el) => !before.has(el));
    if (!tooltip) return null;

    const text = (tooltip.textContent || '').trim();
    tooltip.remove();
    return text || null;
  }

  async function readCareLogTimes(dialogEl) {
    return {
      actual_time_in: await readQuickTime(dialogEl, 'actual_start'),
      scheduled_time_in: await readQuickTime(dialogEl, 'scheduled_start'),
      actual_time_out: await readQuickTime(dialogEl, 'actual_end'),
      scheduled_time_out: await readQuickTime(dialogEl, 'scheduled_end'),
    };
  }

  // Never clicks Save. Tries Escape first (closes most modal libraries by
  // convention), then falls back to a control whose text is exactly
  // "Cancel" -- never anything containing "Save".
  async function closeDialog() {
    const escOpts = { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27 };
    document.dispatchEvent(new KeyboardEvent('keydown', escOpts));
    document.dispatchEvent(new KeyboardEvent('keyup', escOpts));
    await sleep(CLOSE_SETTLE_MS);

    if (!findSmallestMatch(SIGNALS.editCareLog)) return true;

    const cancelLink = Array.from(document.querySelectorAll('a, button')).find(
      (el) => (el.textContent || '').trim() === 'Cancel'
    );
    if (cancelLink) {
      cancelLink.click();
      await sleep(CLOSE_SETTLE_MS);
    }

    return !findSmallestMatch(SIGNALS.editCareLog);
  }

  // Real WellSky markup: each shift's clickable label is a
  // `.title` element (client name + time) inside the `._event` wrapper --
  // clicking the wrapper itself was observed opening the calendar's generic
  // "Add Unavailability" popup instead (a real capture caught this), which
  // suggests the shift-specific click handler lives on that inner element,
  // not the outer one.
  function shiftClickTarget(eventEl) {
    return eventEl.querySelector('.title') || eventEl;
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
    shiftClickTarget(eventEl).click();
    await sleep(CLICK_SETTLE_MS);

    const popup = findSmallestMatch(SIGNALS.summaryPopup);
    if (!popup) {
      const newEls = findNewTopLevelElements(before, snapshotAllElements());
      const closedOk = await closeDialog();
      const seen = newEls.length ? textSnippet(newEls[0]) : '(nothing new appeared)';
      return { times: null, closedOk, diagnostic: `Expected summary popup didn't open. Instead: ${seen}` };
    }

    const editLink = findLinkByText(popup, 'Edit');
    if (!editLink) {
      const closedOk = await closeDialog();
      return { times: null, closedOk, diagnostic: `Summary popup opened but no "Edit" link found in it.` };
    }

    editLink.click();
    await sleep(CLICK_SETTLE_MS);

    const dialog = findSmallestMatch(SIGNALS.editCareLog);
    if (!dialog) {
      const closedOk = await closeDialog();
      return { times: null, closedOk, diagnostic: `Clicked Edit but the Edit Care Log dialog never matched.` };
    }

    const times = await readCareLogTimes(dialog);
    const closedOk = await closeDialog();
    const missing = Object.entries(times)
      .filter(([, v]) => !v)
      .map(([k]) => k);
    const diagnostic = missing.length
      ? `Dialog opened but couldn't read: ${missing.join(', ')}`
      : null;
    return { times, closedOk, diagnostic };
  }

  // ---- Run it ----

  const { records: allRecords, rowCount, eventElsByEventId } = scan();
  const today = todayIso();
  // Keep anything without a parseable date too (rather than silently dropping
  // it) -- it's already flagged as "unparsed" and needs a human look either way.
  const records = allRecords.filter((r) => !r.shift_date || r.shift_date < today);
  const skippedTodayOrFuture = allRecords.length - records.length;

  let stoppedEarlyReason = null;
  const enrichmentDiagnostics = [];
  for (const record of records) {
    if (record.status !== 'completed' || !record.event_id) continue;
    const eventEl = eventElsByEventId.get(record.event_id);
    if (!eventEl) continue;

    const { times, closedOk, diagnostic } = await enrichCompletedShift(eventEl);
    if (times) Object.assign(record, times);
    if (diagnostic) {
      enrichmentDiagnostics.push(`${record.caregiver_name}/${record.client_name} (${record.shift_date}): ${diagnostic}`);
    }

    if (!closedOk) {
      // The dialog didn't close the way we expect -- stop rather than risk
      // clicking blindly into whatever state the page is actually in now.
      stoppedEarlyReason = `Could not confirm the Edit Care Log dialog closed after reading ${record.caregiver_name}/${record.client_name} (${record.shift_date}). Stopped early -- reload the WellSky page and re-scan.`;
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
  };

  return {
    records,
    summary,
    rowCount,
    skippedTodayOrFuture,
    stoppedEarlyReason,
    enrichmentDiagnostics,
    pageUrl: window.location.href,
    scannedAt: new Date().toISOString(),
  };
})();
