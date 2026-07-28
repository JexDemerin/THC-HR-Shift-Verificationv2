// Real shift scanner — calendar-level fields only, so far.
//
// Runs only when injected on demand from popup.js after the user clicks
// "Scan Schedule" — never automatically. Reuses the markup confirmed for the
// original WellSky Shift Scanner: each caregiver is a <tr class="sched_row">,
// and each shift is a <div class="_event STATUS_TOKEN ajSet" data-event-id
// data-event-type data-start data-end> living inside a <td class="day-data">.
//
// actual_time_in / scheduled_time_in / actual_time_out / scheduled_time_out
// are left null here on purpose. Those live in the "Edit Care Log" popup
// (Official start/end plus separate Actual/Scheduled links per side), whose
// real markup hasn't been captured yet -- see inspect-care-log-script.js.
// Guessing at that structure risks silently mis-recording payroll timestamps,
// so real Phase 1b parsing for those four fields waits until a real capture
// comes back.

(function () {
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
      actual_time_in: null, // pending Phase 1b -- see inspect-care-log-script.js
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

    for (const row of rows) {
      const caregiverAnchor = row.querySelector('.person-name a');
      const caregiverName = caregiverAnchor
        ? caregiverAnchor.textContent.replace(/\s+/g, ' ').trim()
        : null;

      const events = Array.from(row.querySelectorAll('.day-data ._event'));
      for (const eventEl of events) {
        records.push(extractRecord(caregiverName, eventEl));
      }
    }

    return { records, rowCount: rows.length };
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

  const { records: allRecords, rowCount } = scan();
  const today = todayIso();
  // Keep anything without a parseable date too (rather than silently dropping
  // it) -- it's already flagged as "unparsed" and needs a human look either way.
  const records = allRecords.filter((r) => !r.shift_date || r.shift_date < today);
  const skippedTodayOrFuture = allRecords.length - records.length;

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
    pageUrl: window.location.href,
    scannedAt: new Date().toISOString(),
  };
})();
