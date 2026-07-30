const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SCAN_SCRIPT_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'scan-script.js'),
  'utf8'
);

// Mirrors the real markup confirmed against WellSky in the original project:
// one <tr class="sched_row"> per caregiver, each shift a
// <div class="_event STATUS ajSet" data-event-id data-start data-end>.
function buildFixture({ status, dataStart, dataEnd, clientName, caregiverName, eventId, id }) {
  return `
    <table>
      <tr class="sched_row">
        <td class="person-name"><a href="#">${caregiverName}</a></td>
        <td class="day-data">
          <div ${id ? `id="${id}"` : ''} class="_event ${status} ajSet" data-event-id="${eventId}" data-start="${dataStart}" data-end="${dataEnd}">
            <div class="title"><span class="name">${clientName}</span><span class="time">1p-4p</span></div>
          </div>
        </td>
      </tr>
    </table>
  `;
}

async function runScanScript(bodyHtml, { runScripts = false, fetchImpl, breakDocument = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://togetherhomecare.clearcareonline.com/dashboard/live/weekly/caregivers/',
    pretendToBeVisual: true,
    runScripts: runScripts ? 'dangerously' : undefined,
  });
  // Activity notes are read by fetching the marker's data-ptip-url, so tests
  // supply their own fetch. Defaults to one that always fails, so a test that
  // doesn't opt in can't accidentally depend on real network access.
  dom.window.fetch =
    fetchImpl || (() => Promise.reject(new Error('fetch not stubbed in this test')));
  global.document = dom.window.document;
  global.window = dom.window;
  global.MouseEvent = dom.window.MouseEvent;
  global.KeyboardEvent = dom.window.KeyboardEvent;
  if (breakDocument) {
    // Make a call the run section relies on throw, standing in for whatever
    // real breakage (markup change, browser quirk) would take it down.
    dom.window.document.querySelectorAll = () => { throw new Error('kaboom'); };
  }
  try {
    // eslint-disable-next-line no-eval
    return await eval(SCAN_SCRIPT_SOURCE);
  } finally {
    delete global.document;
    delete global.window;
    delete global.MouseEvent;
    delete global.KeyboardEvent;
  }
}

test('completed shift is parsed with caregiver/client/date/status/event_id', async () => {
  const html = buildFixture({
    status: 'COMPLETED',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Kozuka-Ssenyan, Mia',
    caregiverName: 'Barberi, Miku',
    eventId: 'evt-123',
  });

  const result = await runScanScript(html);

  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.caregiver_name, 'Barberi, Miku');
  assert.equal(record.client_name, 'Kozuka-Ssenyan, Mia');
  assert.equal(record.shift_date, '2026-07-27');
  assert.equal(record.status, 'completed');
  assert.equal(record.status_raw, 'COMPLETED');
  assert.equal(record.event_id, 'evt-123');
  // No Edit Care Log popup exists in this minimal fixture, so the
  // click-through finds nothing to read -- fields stay null, not guessed.
  assert.equal(record.actual_time_in, null);
  assert.equal(record.scheduled_time_in, null);
  assert.equal(record.actual_time_out, null);
  assert.equal(record.scheduled_time_out, null);
  assert.equal(result.stoppedEarlyReason, null);
});

test('missed clock-in/out maps to the "incomplete" status', async () => {
  const html = buildFixture({
    status: 'MISSED_CLOCK_IN',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Joyner, Yusuf',
    caregiverName: 'Amato, Savani',
    eventId: 'evt-456',
  });

  const result = await runScanScript(html);

  assert.equal(result.records[0].status, 'incomplete');
  assert.equal(result.summary.incomplete, 1);
});

test('an unrecognized status token is reported as unparsed, not dropped', async () => {
  const html = buildFixture({
    status: 'SOME_NEW_STATUS_WELLSKY_ADDED',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Someone, Client',
    caregiverName: 'Someone, Caregiver',
    eventId: 'evt-789',
  });

  const result = await runScanScript(html);

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].status, 'unparsed');
  assert.equal(result.summary.unparsed, 1);
});

test('no shifts on the page returns an empty, not throwing, result', async () => {
  const result = await runScanScript('<table></table>');

  assert.equal(result.records.length, 0);
  assert.equal(result.rowCount, 0);
  assert.equal(result.summary.total, 0);
});

// "2026-07-29" -> "07/29/2026", the form WellSky's own quick-time tooltips use.
// Fixtures that build their shift date relative to today need their tooltip
// dates built the same way, or the shift date and the tooltip date disagree and
// the fixture stops representing a real shift.
function mmDdYyyy(isoDate) {
  const [year, month, day] = isoDate.split('-');
  return `${month}/${day}/${year}`;
}

function isoDateOffsetFromToday(dayOffset) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('today and future shifts are skipped -- only past days get scanned', async () => {
  const yesterday = isoDateOffsetFromToday(-1);
  const today = isoDateOffsetFromToday(0);
  const tomorrow = isoDateOffsetFromToday(1);

  const html = [
    buildFixture({
      status: 'COMPLETED', dataStart: `${yesterday}T09:00:00.000000`, dataEnd: `${yesterday}T16:00:00.000000`,
      clientName: 'Past Client', caregiverName: 'Past Caregiver', eventId: 'evt-past',
    }),
    buildFixture({
      status: 'IN_PROGRESS', dataStart: `${today}T09:00:00.000000`, dataEnd: `${today}T16:00:00.000000`,
      clientName: 'Today Client', caregiverName: 'Today Caregiver', eventId: 'evt-today',
    }),
    buildFixture({
      status: 'SCHEDULED', dataStart: `${tomorrow}T09:00:00.000000`, dataEnd: `${tomorrow}T16:00:00.000000`,
      clientName: 'Future Client', caregiverName: 'Future Caregiver', eventId: 'evt-future',
    }),
  ].join('\n');

  const result = await runScanScript(html);

  assert.equal(result.rowCount, 3, 'all three caregiver rows were on screen');
  assert.equal(result.skippedTodayOrFuture, 2, 'the today and future shifts are dropped');

  // The past-dated shift survives as a real record...
  const realShifts = result.records.filter((r) => r.status !== 'no_shift');
  assert.equal(realShifts.length, 1);
  assert.equal(realShifts[0].event_id, 'evt-past');

  // ...and the other two caregivers, who had nothing on that past date, each
  // get a "-" row rather than being left out of the log entirely.
  const noShiftRows = result.records.filter((r) => r.status === 'no_shift');
  assert.equal(noShiftRows.length, 2);
  assert.deepEqual(
    noShiftRows.map((r) => r.caregiver_name).sort(),
    ['Future Caregiver', 'Today Caregiver']
  );
});

test('an unparsed shift with no discoverable date is kept, not silently dropped', async () => {
  // No data-start/data-end at all -> shift_date stays null -> must not be
  // swept away by the today/future filter just because it has no date.
  const html = `
    <table>
      <tr class="sched_row">
        <td class="person-name"><a href="#">Mystery Caregiver</a></td>
        <td class="day-data">
          <div class="_event WEIRD_STATUS ajSet" data-event-id="evt-mystery">
            <div class="title"><span class="name">Mystery Client</span></div>
          </div>
        </td>
      </tr>
    </table>
  `;

  const result = await runScanScript(html);

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].status, 'unparsed');
  assert.equal(result.records[0].shift_date, null);
});

// ---- Full click-through: green shift -> summary popup -> Edit -> read times -> close ----

// `tooltipDate` must be the same day the fixture's shift sits on, or the fixture
// stops describing a real shift: the scanner drops a clock punch's date only when
// it matches shift_date, so a mismatched default would silently exercise the
// overnight path instead of the ordinary one.
function buildClickThroughScript({ closable, scheduledLinks = 'present', tooltipDate = '07/27/2026' }) {
  // closable === true: document-level Escape handling (registering this
  // listener doesn't need #edit-dialog to exist yet -- it's only looked up
  // once Escape is actually pressed, later).
  const documentLevelCloseHandler =
    closable === true
      ? `document.addEventListener('keydown', function (e) {
           if (e.key === 'Escape') {
             var dialog = document.getElementById('edit-dialog');
             if (dialog) dialog.remove();
           }
         });`
      : '';

  // closable === 'dialog-escape-only': Escape handling bound to the dialog
  // widget itself, not document -- covers a jQuery UI Dialog pattern where a
  // document-wide keydown dispatch alone would never reach it. This has to
  // be attached AFTER the dialog element exists, so it's inserted inline
  // where the dialog is created below, not as a top-level script block.
  const dialogLevelCloseHandler =
    closable === 'dialog-escape-only'
      ? `dialog.addEventListener('keydown', function (e) {
           if (e.key === 'Escape') dialog.remove();
         });`
      : '';

  // closable === 'titlebar': no Escape handling anywhere -- only the
  // jQuery UI titlebar close (X) button works, wrapped in a .ui-dialog
  // ancestor as on the real site.
  //
  // closable === 'hides-not-removes': the real jQuery UI behavior -- closing
  // sets display:none on the .ui-dialog wrapper and LEAVES the dialog in the
  // DOM. A text-only "is it still there" check can't tell this apart from a
  // dialog that never closed.
  //
  // closable === false (or unset): nothing closes it at all, simulating a
  // dialog that won't close no matter what.
  let dialogHtml = `document.body.appendChild(dialog);`;
  if (closable === 'titlebar') {
    dialogHtml = `var wrapper = document.createElement('div');
         wrapper.className = 'ui-dialog';
         var closeBtn = document.createElement('button');
         closeBtn.className = 'ui-dialog-titlebar-close';
         closeBtn.addEventListener('click', function () { wrapper.remove(); });
         wrapper.appendChild(closeBtn);
         wrapper.appendChild(dialog);
         document.body.appendChild(wrapper);`;
  } else if (closable === 'hides-not-removes') {
    dialogHtml = `var wrapper = document.createElement('div');
         wrapper.className = 'ui-dialog';
         var closeBtn = document.createElement('button');
         closeBtn.className = 'ui-dialog-titlebar-close';
         closeBtn.addEventListener('click', function () {
           wrapper.style.display = 'none';
         });
         wrapper.appendChild(closeBtn);
         wrapper.appendChild(dialog);
         document.body.appendChild(wrapper);`;
  }

  return `
    <script>
      document.getElementById('shift-el').addEventListener('click', function () {
        var popup = document.createElement('div');
        popup.id = 'summary-popup';
        popup.innerHTML =
          '<h4>Care Log</h4><a>Summary</a><a>Notes</a><a id="edit-link">Edit</a><a>Copy</a>';
        document.body.appendChild(popup);

        document.getElementById('edit-link').addEventListener('click', function () {
          popup.remove();
          var dialog = document.createElement('div');
          dialog.id = 'edit-dialog';
          dialog.innerHTML =
            '<label>Status</label><label>Official</label><label>Bill Hours</label>' +
            '<label>Pay Hours</label><label>Client</label><label>Caregiver</label>' +
            '<a class="actual_start">Actual</a>' +
            ${scheduledLinks === 'absent' ? "''" : `'<a class="scheduled_start">Scheduled</a>'`} +
            '<a class="actual_end">Actual</a>' +
            ${scheduledLinks === 'absent' ? "''" : `'<a class="scheduled_end">Scheduled</a>'`};
          ${dialogLevelCloseHandler}
          ${dialogHtml}

          function attachTooltip(selector, text) {
            var el = dialog.querySelector(selector);
            if (!el) return;
            el.addEventListener('mouseenter', function () {
              var tip = document.createElement('div');
              tip.className = '_ptip side_b';
              tip.textContent = text;
              document.body.appendChild(tip);
            });
          }
          attachTooltip('.actual_start', '${tooltipDate} 07:11:25 PM');
          attachTooltip('.actual_end', '${tooltipDate} 09:11:43 PM');
          ${
            scheduledLinks === 'present-but-silent'
              ? '// links exist but never produce a tooltip -- a real read failure'
              : `attachTooltip('.scheduled_start', '${tooltipDate} 07:00:00 PM');
                 attachTooltip('.scheduled_end', '${tooltipDate} 09:00:00 PM');`
          }
        });
      });
      ${documentLevelCloseHandler}
    </script>
  `;
}

test('a completed shift is clicked through to read all four real clock times', async () => {
  const calendarHtml = buildFixture({
    status: 'COMPLETED',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Kozuka-Ssenyan, Mia',
    caregiverName: 'Barberi, Miku',
    eventId: 'evt-enrich',
    id: 'shift-el',
  });
  const html = calendarHtml + buildClickThroughScript({ closable: true });

  const result = await runScanScript(html, { runScripts: true });

  assert.equal(result.stoppedEarlyReason, null);
  const record = result.records[0];
  assert.equal(record.actual_time_in, '07:11:25 PM');
  assert.equal(record.scheduled_time_in, '07:00:00 PM');
  assert.equal(record.actual_time_out, '09:11:43 PM');
  assert.equal(record.scheduled_time_out, '09:00:00 PM');
});

test('stops and reports a reason if the Edit Care Log dialog never closes', async () => {
  const calendarHtml = buildFixture({
    status: 'COMPLETED',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Kozuka-Ssenyan, Mia',
    caregiverName: 'Barberi, Miku',
    eventId: 'evt-stuck',
    id: 'shift-el',
  });
  const html = calendarHtml + buildClickThroughScript({ closable: false });

  const result = await runScanScript(html, { runScripts: true });

  assert.match(result.stoppedEarlyReason, /Barberi, Miku/);
  assert.match(result.stoppedEarlyReason, /stopped early/i);
});

test('closes via Escape dispatched directly on the dialog, not just document', async () => {
  // Regression test for a real observation: a shift's times were read
  // successfully but the scan still stopped early because it couldn't
  // confirm the dialog closed -- consistent with a jQuery UI Dialog whose
  // Escape handling is bound to the widget itself, which a document-only
  // Escape dispatch would never reach.
  const calendarHtml = buildFixture({
    status: 'COMPLETED',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Kozuka-Ssenyan, Mia',
    caregiverName: 'Barberi, Miku',
    eventId: 'evt-dialog-escape',
    id: 'shift-el',
  });
  const html = calendarHtml + buildClickThroughScript({ closable: 'dialog-escape-only' });

  const result = await runScanScript(html, { runScripts: true });

  assert.equal(result.stoppedEarlyReason, null);
  assert.equal(result.records[0].actual_time_in, '07:11:25 PM');
});

test('falls back to the jQuery UI titlebar close button when Escape does nothing', async () => {
  const calendarHtml = buildFixture({
    status: 'COMPLETED',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Kozuka-Ssenyan, Mia',
    caregiverName: 'Barberi, Miku',
    eventId: 'evt-titlebar-close',
    id: 'shift-el',
  });
  const html = calendarHtml + buildClickThroughScript({ closable: 'titlebar' });

  const result = await runScanScript(html, { runScripts: true });

  assert.equal(result.stoppedEarlyReason, null);
  assert.equal(result.records[0].actual_time_in, '07:11:25 PM');
});

test('treats a hidden-but-still-present dialog as closed, and keeps going', async () => {
  // Regression test for the real failure: the same shift read all four times
  // successfully, yet the scan stopped early every run claiming the dialog
  // never closed. jQuery UI closes a dialog by setting display:none and
  // leaving it in the DOM -- so a text-only presence check can't distinguish
  // "closed" from "never closed", and every later shift got skipped.
  const yesterday = isoDateOffsetFromToday(-1);
  const calendarHtml = buildFixture({
    status: 'COMPLETED',
    dataStart: `${yesterday}T09:00:00.000000`,
    dataEnd: `${yesterday}T16:00:00.000000`,
    clientName: 'Kozuka-Ssenyan, Mia',
    caregiverName: 'Barberi, Miku',
    eventId: 'evt-hidden-close',
    id: 'shift-el',
  });
  const html = calendarHtml + buildClickThroughScript({ closable: 'hides-not-removes', tooltipDate: mmDdYyyy(yesterday) });

  const result = await runScanScript(html, { runScripts: true });

  assert.equal(result.stoppedEarlyReason, null, 'a hidden dialog must count as closed');
  assert.equal(result.records[0].actual_time_in, '07:11:25 PM');
});

test('clicks the .title label, not just the outer shift wrapper', async () => {
  // Regression test for a real observation: clicking the outer ._event div
  // opened WellSky's "Add Unavailability" popup instead of the shift's own
  // summary -- meaning the real click handler must live on the inner .title
  // element, not the wrapper. A listener bound ONLY to .title would never
  // fire from a click on the wrapper (clicking a parent doesn't trigger a
  // child's own listener), so this only passes if the wrapper click actually
  // lands on .title.
  const calendarHtml = buildFixture({
    status: 'COMPLETED',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Kozuka-Ssenyan, Mia',
    caregiverName: 'Barberi, Miku',
    eventId: 'evt-title-click',
    id: 'shift-el',
  });
  const script = `
    <script>
      document.querySelector('#shift-el .title').addEventListener('click', function () {
        var popup = document.createElement('div');
        popup.innerHTML = '<h4>Care Log</h4><a>Summary</a><a>Notes</a><a id="edit-link">Edit</a><a>Copy</a>';
        document.body.appendChild(popup);
      });
    </script>
  `;

  const result = await runScanScript(calendarHtml + script, { runScripts: true });

  // The Edit Care Log dialog was never built in this minimal fixture, so
  // enrichment can't finish -- what matters here is that the summary popup
  // opened at all (proving .title, not the wrapper, was the click target).
  assert.equal(result.enrichmentDiagnostics.length, 1);
  assert.match(result.enrichmentDiagnostics[0], /Edit Care Log dialog never matched/);
});

test('reports a diagnostic and safely closes when the wrong popup opens', async () => {
  // Regression test for the real "Add Unavailability" observation: some
  // unexpected popup opens instead of the shift's summary.
  const calendarHtml = buildFixture({
    status: 'COMPLETED',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Kozuka-Ssenyan, Mia',
    caregiverName: 'Barberi, Miku',
    eventId: 'evt-wrong-popup',
    id: 'shift-el',
  });
  const script = `
    <script>
      document.getElementById('shift-el').addEventListener('click', function () {
        var popup = document.createElement('div');
        popup.textContent = 'Add Unavailability for this caregiver';
        document.body.appendChild(popup);
      });
    </script>
  `;

  const result = await runScanScript(calendarHtml + script, { runScripts: true });

  assert.equal(result.stoppedEarlyReason, null);
  assert.equal(result.records[0].actual_time_in, null);
  assert.equal(result.enrichmentDiagnostics.length, 1);
  assert.match(result.enrichmentDiagnostics[0], /Add Unavailability/);
});

test('records "only had actual hours" when a shift genuinely has no scheduled time', async () => {
  // Confirmed against a real shift whose Edit Care Log dialog showed
  // "Set to: Actual" with no "| Scheduled" link beside it at all -- there's
  // no scheduled time to read, which is a real property of that shift rather
  // than a read failure, so it must not be reported as one.
  const calendarHtml = buildFixture({
    status: 'COMPLETED',
    dataStart: '2026-07-27T10:30:00.000000',
    dataEnd: '2026-07-27T14:30:00.000000',
    clientName: 'Chiang, Ryan',
    caregiverName: 'Toki, Kaliya',
    eventId: 'evt-actual-only',
    id: 'shift-el',
  });
  const html =
    calendarHtml + buildClickThroughScript({ closable: true, scheduledLinks: 'absent' });

  const result = await runScanScript(html, { runScripts: true });

  const record = result.records[0];
  assert.equal(record.actual_time_in, '07:11:25 PM');
  assert.equal(record.actual_time_out, '09:11:43 PM');
  assert.equal(record.scheduled_time_in, 'only had actual hours');
  assert.equal(record.scheduled_time_out, 'only had actual hours');
  assert.deepEqual(result.enrichmentDiagnostics, [], 'an absent scheduled time is not a failure');
});

test("an overnight shift keeps the clock-out's next-day date", async () => {
  // The date is stripped from a clock punch because shift_date already carries
  // it -- but an overnight shift clocks out on the FOLLOWING day. Strip that and
  // "10:00:00 PM" to "06:00:00 AM" reads as a shift running backwards inside one
  // day, and the midnight crossing disappears from the sheet entirely.
  const date = isoDateOffsetFromToday(-2);
  const nextDay = isoDateOffsetFromToday(-1);
  const calendarHtml = buildGrid(
    [
      { name: 'Nocturne, Nia', shifts: [
        { date, start: '22:00:00.000000', end: '23:59:00.000000', client: 'Sleeper, Sam', eventId: 'overnight' },
      ] },
    ],
    [date]
  );
  const script = `
    <script>
      document.querySelector('.title .name').addEventListener('click', function () {
        var popup = document.createElement('div');
        popup.innerHTML =
          '<h4>Care Log</h4><a>Summary</a><a>Notes</a><a id="edit-link">Edit</a><a>Copy</a>';
        document.body.appendChild(popup);

        document.getElementById('edit-link').addEventListener('click', function () {
          popup.remove();
          var dialog = document.createElement('div');
          dialog.innerHTML =
            '<label>Status</label><label>Official</label>' +
            '<label>Client</label><label>Caregiver</label>' +
            '<a class="actual_start">Actual</a><a class="actual_end">Actual</a>';
          document.body.appendChild(dialog);

          function tip(selector, text) {
            dialog.querySelector(selector).addEventListener('mouseenter', function () {
              var t = document.createElement('div');
              t.className = '_ptip';
              t.textContent = text;
              document.body.appendChild(t);
            });
          }
          tip('.actual_start', '${mmDdYyyy(date)} 10:00:00 PM');
          tip('.actual_end', '${mmDdYyyy(nextDay)} 06:00:00 AM');

          document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') dialog.remove();
          });
        });
      });
    </script>
  `;

  const result = await runScanScript(calendarHtml + script, { runScripts: true });
  const shift = result.records.find((r) => r.event_id === 'overnight');

  assert.equal(shift.actual_time_in, '10:00:00 PM', "the shift's own date is redundant");
  assert.equal(
    shift.actual_time_out,
    `${mmDdYyyy(nextDay)} 06:00:00 AM`,
    'a different date is real information and stays'
  );
});

test('still flags a scheduled link that exists but cannot be read', async () => {
  // The other side of the coin: if the link IS there and hovering it produces
  // nothing, that's a genuine problem and must stay visible rather than being
  // quietly written off as "no scheduled time".
  const calendarHtml = buildFixture({
    status: 'COMPLETED',
    dataStart: '2026-07-27T10:30:00.000000',
    dataEnd: '2026-07-27T14:30:00.000000',
    clientName: 'Chiang, Ryan',
    caregiverName: 'Toki, Kaliya',
    eventId: 'evt-silent-link',
    id: 'shift-el',
  });
  const html =
    calendarHtml +
    buildClickThroughScript({ closable: true, scheduledLinks: 'present-but-silent' });

  const result = await runScanScript(html, { runScripts: true });

  const record = result.records[0];
  assert.equal(record.actual_time_in, '07:11:25 PM');
  assert.equal(record.scheduled_time_in, null);
  assert.equal(result.enrichmentDiagnostics.length, 1);
  assert.match(result.enrichmentDiagnostics[0], /scheduled_time_in/);
  assert.match(result.enrichmentDiagnostics[0], /scheduled_time_out/);
});

// ---- All caregivers, "-" rows, sorting, notes, durations ----

// A realistic multi-caregiver, multi-day grid: one table, one row per
// caregiver, one td.day-data per day column -- matching real WellSky markup.
function buildGrid(caregivers, dates) {
  const rows = caregivers
    .map((caregiver) => {
      const cells = dates
        .map((date) => {
          const shifts = (caregiver.shifts || []).filter((s) => s.date === date);
          const inner = shifts
            .map(
              (s) => `
                <div class="_event ${s.status || 'COMPLETED'} ajSet"
                     data-event-id="${s.eventId}"
                     data-start="${date}T${s.start}"
                     data-end="${date}T${s.end}">
                  <div class="title">
                    <a class="name">${s.client}<span class="time">x</span></a>
                  </div>
                  ${
                    s.note
                      ? `<div class="_pop_note note_exists" style="display:none"
                              data-ptip-url="/scheduling/note/get/?carelog=${s.eventId}">&nbsp;</div>`
                      : ''
                  }
                </div>`
            )
            .join('');
          return `<td class="day-data">${inner}</td>`;
        })
        .join('');
      return `<tr class="sched_row"><td class="person-name"><a href="#">${caregiver.name}</a></td>${cells}</tr>`;
    })
    .join('');
  return `<table>${rows}</table>`;
}

test('every caregiver on screen gets a row per date, "-" when they had no shift', async () => {
  const d1 = isoDateOffsetFromToday(-3);
  const d2 = isoDateOffsetFromToday(-2);
  const html = buildGrid(
    [
      { name: 'Worked, Both Days', shifts: [
        { date: d1, start: '09:00:00.000000', end: '12:00:00.000000', client: 'Client A', eventId: 'e1' },
        { date: d2, start: '09:00:00.000000', end: '12:00:00.000000', client: 'Client A', eventId: 'e2' },
      ] },
      { name: 'Worked, One Day', shifts: [
        { date: d1, start: '09:00:00.000000', end: '12:00:00.000000', client: 'Client B', eventId: 'e3' },
      ] },
      { name: 'Worked, Never', shifts: [] },
    ],
    [d1, d2]
  );

  const result = await runScanScript(html);

  // 3 caregivers x 2 dates = 6 rows, no matter who actually worked.
  assert.equal(result.records.length, 6);
  assert.deepEqual(result.columnDates, [d1, d2]);

  const byKey = {};
  for (const r of result.records) byKey[`${r.caregiver_name}|${r.shift_date}`] = r;

  assert.equal(byKey[`Worked, Never|${d1}`].status, 'no_shift');
  assert.equal(byKey[`Worked, Never|${d1}`].client_name, '-');
  assert.equal(byKey[`Worked, Never|${d1}`].official_time_in, '-');
  assert.equal(byKey[`Worked, Never|${d2}`].status, 'no_shift');
  assert.equal(byKey[`Worked, One Day|${d1}`].status, 'completed');
  assert.equal(byKey[`Worked, One Day|${d2}`].status, 'no_shift');
  assert.equal(byKey[`Worked, Both Days|${d2}`].status, 'completed');
});

test('a day column where nobody worked still produces "-" rows for everyone', async () => {
  // This is the case that made deriving column dates by offset worthwhile:
  // the middle column has no shifts at all, so its date can only be known by
  // counting from a neighbouring column.
  const d1 = isoDateOffsetFromToday(-3);
  const d2 = isoDateOffsetFromToday(-2);
  const d3 = isoDateOffsetFromToday(-1);
  const html = buildGrid(
    [
      { name: 'Solo, Caregiver', shifts: [
        { date: d1, start: '09:00:00.000000', end: '12:00:00.000000', client: 'Client A', eventId: 'e1' },
        { date: d3, start: '09:00:00.000000', end: '12:00:00.000000', client: 'Client A', eventId: 'e2' },
      ] },
    ],
    [d1, d2, d3]
  );

  const result = await runScanScript(html);

  assert.deepEqual(result.columnDates, [d1, d2, d3], 'the empty middle column still gets its date');
  const middle = result.records.find((r) => r.shift_date === d2);
  assert.ok(middle, 'the empty day produced a row');
  assert.equal(middle.status, 'no_shift');
});

test('records come out sorted by date, then caregiver name alphabetically', async () => {
  const d1 = isoDateOffsetFromToday(-2);
  const d2 = isoDateOffsetFromToday(-1);
  const html = buildGrid(
    [
      { name: 'Zulu, Zara', shifts: [
        { date: d1, start: '09:00:00.000000', end: '10:00:00.000000', client: 'C', eventId: 'z1' },
        { date: d2, start: '09:00:00.000000', end: '10:00:00.000000', client: 'C', eventId: 'z2' },
      ] },
      { name: 'Alpha, Aaron', shifts: [
        { date: d1, start: '09:00:00.000000', end: '10:00:00.000000', client: 'C', eventId: 'a1' },
        { date: d2, start: '09:00:00.000000', end: '10:00:00.000000', client: 'C', eventId: 'a2' },
      ] },
      { name: 'Mike, Mary', shifts: [] },
    ],
    [d1, d2]
  );

  const result = await runScanScript(html);

  assert.deepEqual(
    result.records.map((r) => `${r.shift_date} ${r.caregiver_name}`),
    [
      `${d1} Alpha, Aaron`,
      `${d1} Mike, Mary`,
      `${d1} Zulu, Zara`,
      `${d2} Alpha, Aaron`,
      `${d2} Mike, Mary`,
      `${d2} Zulu, Zara`,
    ]
  );
});

test('computes label times and duration, and zeroes out an incomplete shift', async () => {
  const date = isoDateOffsetFromToday(-1);
  const html = buildGrid(
    [
      { name: 'Timed, Terry', shifts: [
        { date, start: '13:00:00.000000', end: '17:05:00.000000', client: 'Client A', eventId: 'ok1' },
      ] },
      { name: 'Missed, Morgan', shifts: [
        { date, status: 'MISSED_CLOCK_IN', start: '09:00:00.000000', end: '17:00:00.000000', client: 'Client B', eventId: 'miss1' },
      ] },
    ],
    [date]
  );

  const result = await runScanScript(html);
  const byName = Object.fromEntries(result.records.map((r) => [r.caregiver_name, r]));

  // 1:00pm - 5:05pm = 245 minutes, matching the note format asked for.
  assert.equal(byName['Timed, Terry'].official_time_in, '1:00pm');
  assert.equal(byName['Timed, Terry'].official_time_out, '5:05pm');
  assert.equal(byName['Timed, Terry'].duration_minutes, 245);

  // A missed clock-in earns zero regardless of WellSky's placeholder times --
  // those 8 hours were never actually clocked.
  assert.equal(byName['Missed, Morgan'].status, 'incomplete');
  assert.equal(byName['Missed, Morgan'].duration_minutes, 0);
});

test('handles an overnight shift without producing negative hours', async () => {
  const date = isoDateOffsetFromToday(-2);
  const nextDay = isoDateOffsetFromToday(-1);
  const html = `
    <table>
      <tr class="sched_row">
        <td class="person-name"><a href="#">Night, Nadia</a></td>
        <td class="day-data">
          <div class="_event COMPLETED ajSet" data-event-id="night1"
               data-start="${date}T22:00:00.000000" data-end="${nextDay}T06:00:00.000000">
            <div class="title"><a class="name">Client N<span class="time">x</span></a></div>
          </div>
        </td>
      </tr>
    </table>
  `;

  const result = await runScanScript(html);
  const shift = result.records.find((r) => r.event_id === 'night1');

  assert.equal(shift.shift_date, date, 'an overnight shift belongs to the day it started');
  assert.equal(shift.duration_minutes, 480, '10pm to 6am is 8 hours, not a negative span');
});

// The note marker is display:none until the shift is hovered, and that
// visibility is a CSS :hover rule -- which dispatched events cannot trigger,
// so a simulated hover can never reveal it. The note is read by fetching the
// marker's data-ptip-url instead, the same request the page itself makes.
function noteFixture(caregiverName, eventId, extra = {}) {
  const date = isoDateOffsetFromToday(-1);
  return buildGrid(
    [
      { name: caregiverName, shifts: [
        {
          date, start: '17:00:00.000000', end: '20:00:00.000000',
          client: 'Pallapati, Samson', eventId, ...extra,
        },
      ] },
    ],
    [date]
  );
}

const NOTE_DIAGNOSTIC = /couldn't read its activity note/;

test('reads the activity note by fetching the marker\'s data-ptip-url', async () => {
  const requested = [];
  const fetchImpl = (url) => {
    requested.push(url);
    return Promise.resolve({
      ok: true,
      text: () =>
        Promise.resolve(
          '<div class="note">07/14/26: On a vacation with their father, July 22-31<br>' +
            '(Added to shift that Occurs once on 07/27/2026)</div>'
        ),
    });
  };

  const result = await runScanScript(noteFixture('Noted, Nora', 'n1', { note: true }), { fetchImpl });
  const shift = result.records.find((r) => r.event_id === 'n1');

  assert.deepEqual(requested, ['/scheduling/note/get/?carelog=n1']);
  // Markup stripped, entities decoded, whitespace collapsed to one line.
  assert.equal(
    shift.note,
    '07/14/26: On a vacation with their father, July 22-31 (Added to shift that Occurs once on 07/27/2026)'
  );
  assert.deepEqual(
    result.enrichmentDiagnostics.filter((d) => NOTE_DIAGNOSTIC.test(d)),
    []
  );
});

test('an empty note response means "no note", not a failure', async () => {
  // Most shifts carry the marker element with nothing behind it, so an empty
  // body must not be reported -- that was the bug that flagged every single
  // shift on the schedule at once.
  const fetchImpl = () => Promise.resolve({ ok: true, text: () => Promise.resolve('  &nbsp; ') });

  const result = await runScanScript(noteFixture('Blank, Bailey', 'b1', { note: true }), { fetchImpl });

  assert.equal(result.records.find((r) => r.event_id === 'b1').note, null);
  assert.deepEqual(
    result.enrichmentDiagnostics.filter((d) => NOTE_DIAGNOSTIC.test(d)),
    [],
    'a marker with nothing behind it is not a problem'
  );
});

test('reports a genuine note fetch failure', async () => {
  const fetchImpl = () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') });

  const result = await runScanScript(noteFixture('Broken, Bea', 'x1', { note: true }), { fetchImpl });

  assert.equal(result.records.find((r) => r.event_id === 'x1').note, null);
  const noteDiagnostics = result.enrichmentDiagnostics.filter((d) => NOTE_DIAGNOSTIC.test(d));
  assert.equal(noteDiagnostics.length, 1);
  assert.match(noteDiagnostics[0], /HTTP 500/);
});

test('reports a network error while reading a note', async () => {
  const fetchImpl = () => Promise.reject(new Error('network down'));

  const result = await runScanScript(noteFixture('Offline, Ollie', 'o1', { note: true }), { fetchImpl });

  const noteDiagnostics = result.enrichmentDiagnostics.filter((d) => NOTE_DIAGNOSTIC.test(d));
  assert.equal(noteDiagnostics.length, 1);
  assert.match(noteDiagnostics[0], /network down/);
});

test('a shift with no note marker is never fetched or reported', async () => {
  let called = false;
  const fetchImpl = () => {
    called = true;
    return Promise.resolve({ ok: true, text: () => Promise.resolve('') });
  };

  const result = await runScanScript(noteFixture('Plain, Pat', 'p1'), { fetchImpl });

  assert.equal(called, false, 'no marker means no request at all');
  assert.deepEqual(
    result.enrichmentDiagnostics.filter((d) => NOTE_DIAGNOSTIC.test(d)),
    []
  );
});

test('keeps an incomplete shift\'s scheduled span even though it earns no hours', async () => {
  const date = isoDateOffsetFromToday(-1);
  const html = buildGrid(
    [
      { name: 'Missed, Morgan', shifts: [
        { date, status: 'MISSED_CLOCK_IN', start: '11:00:00.000000', end: '18:00:00.000000', client: 'Joyner, Yusuf', eventId: 'miss2' },
      ] },
    ],
    [date]
  );

  const result = await runScanScript(html);
  const shift = result.records.find((r) => r.event_id === 'miss2');

  assert.equal(shift.duration_minutes, 0, 'no payable hours for a missing clock-in');
  assert.equal(shift.label_duration_minutes, 420, 'the scheduled 7h span is still kept for the note');
});

test('reads a dialog that has no Bill/Pay Hours block at all', async () => {
  // Regression test for a real failure ("Clicked Edit but the Edit Care Log
  // dialog never matched"): the bill-pay-automation block is conditional in
  // WellSky's markup, so a shift without billing has no "Bill Hours" text --
  // and requiring it made a perfectly good dialog look like it never opened.
  const date = isoDateOffsetFromToday(-1);
  const calendarHtml = buildGrid(
    [
      { name: 'Toki, Kaliya', shifts: [
        { date, start: '10:30:00.000000', end: '14:30:00.000000', client: 'Chiang, Ryan', eventId: 'nobill' },
      ] },
    ],
    [date]
  );
  const script = `
    <script>
      document.querySelector('.title .name').addEventListener('click', function () {
        var popup = document.createElement('div');
        popup.innerHTML =
          '<h4>Care Log</h4><a>Summary</a><a>Notes</a><a id="edit-link">Edit</a><a>Copy</a>';
        document.body.appendChild(popup);

        document.getElementById('edit-link').addEventListener('click', function () {
          popup.remove();
          var dialog = document.createElement('div');
          // No Bill Hours / Pay Hours anywhere -- exactly the shape that failed.
          dialog.innerHTML =
            '<label>Status</label><label>Official</label>' +
            '<label>Client</label><label>Caregiver</label>' +
            '<a class="actual_start">Actual</a><a class="actual_end">Actual</a>';
          document.body.appendChild(dialog);

          function tip(selector, text) {
            dialog.querySelector(selector).addEventListener('mouseenter', function () {
              var t = document.createElement('div');
              t.className = '_ptip';
              t.textContent = text;
              document.body.appendChild(t);
            });
          }
          tip('.actual_start', '${mmDdYyyy(date)} 10:30:00 AM');
          tip('.actual_end', '${mmDdYyyy(date)} 02:30:00 PM');

          document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') dialog.remove();
          });
        });
      });
    </script>
  `;

  const result = await runScanScript(calendarHtml + script, { runScripts: true });
  const shift = result.records.find((r) => r.event_id === 'nobill');

  assert.equal(shift.actual_time_in, '10:30:00 AM');
  assert.equal(shift.actual_time_out, '02:30:00 PM');
  // No Scheduled links at all -> genuinely absent, not a read failure.
  assert.equal(shift.scheduled_time_in, 'only had actual hours');
  assert.deepEqual(
    result.enrichmentDiagnostics.filter((d) => /never matched/.test(d)),
    [],
    'a billing-less dialog must not be reported as never opening'
  );
});

test('says WHY the dialog did not match, not just that it didn\'t', async () => {
  const date = isoDateOffsetFromToday(-1);
  const calendarHtml = buildGrid(
    [
      { name: 'Broken, Bea', shifts: [
        { date, start: '09:00:00.000000', end: '12:00:00.000000', client: 'Client B', eventId: 'nodialog' },
      ] },
    ],
    [date]
  );
  const script = `
    <script>
      document.querySelectorAll('.title .name')[0].addEventListener('click', function () {
        var popup = document.createElement('div');
        popup.innerHTML =
          '<h4>Care Log</h4><a>Summary</a><a>Notes</a><a id="edit-link">Edit</a><a>Copy</a>';
        document.body.appendChild(popup);
        // Clicking Edit does nothing at all -- no dialog ever appears.
      });
    </script>
  `;

  const result = await runScanScript(calendarHtml + script, { runScripts: true });

  const diagnostic = result.enrichmentDiagnostics.find((d) => /never matched/.test(d));
  assert.ok(diagnostic, 'the failure is still reported');
  // Names the specific expected text that was absent, so the next step is
  // obvious without another round trip to find out.
  assert.match(diagnostic, /nothing on the page contains:.*Official/);
});

test('recovers when the first Edit click does not land', async () => {
  // Regression test for a real failure: the dialog never appeared and none of
  // its text was anywhere on the page -- a click that didn't register, not a
  // dialog that failed to load. The fixture ignores the first Edit click and
  // builds the dialog on the second.
  const date = isoDateOffsetFromToday(-1);
  const calendarHtml = buildGrid(
    [
      { name: 'Tam, Sean', shifts: [
        { date, start: '09:00:00.000000', end: '12:00:00.000000', client: 'Lezer, Bryce', eventId: 'retry-edit' },
      ] },
    ],
    [date]
  );
  const script = `
    <script>
      var editClicks = 0;
      document.querySelector('.title .name').addEventListener('click', function () {
        var popup = document.createElement('div');
        popup.innerHTML =
          '<h4>Care Log</h4><a>Summary</a><a>Notes</a><a id="edit-link">Edit</a><a>Copy</a>';
        document.body.appendChild(popup);

        document.getElementById('edit-link').addEventListener('click', function () {
          editClicks++;
          if (editClicks < 2) return; // first click is swallowed
          popup.remove();
          var dialog = document.createElement('div');
          dialog.innerHTML =
            '<label>Status</label><label>Official</label>' +
            '<label>Client</label><label>Caregiver</label>' +
            '<a class="actual_start">Actual</a><a class="actual_end">Actual</a>';
          document.body.appendChild(dialog);

          function tip(selector, text) {
            dialog.querySelector(selector).addEventListener('mouseenter', function () {
              var t = document.createElement('div');
              t.className = '_ptip';
              t.textContent = text;
              document.body.appendChild(t);
            });
          }
          tip('.actual_start', '${mmDdYyyy(date)} 09:00:00 AM');
          tip('.actual_end', '${mmDdYyyy(date)} 12:00:00 PM');

          document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') dialog.remove();
          });
        });
      });
    </script>
  `;

  const result = await runScanScript(calendarHtml + script, { runScripts: true });
  const shift = result.records.find((r) => r.event_id === 'retry-edit');

  assert.equal(shift.actual_time_in, '09:00:00 AM', 'the retry got the times');
  assert.deepEqual(
    result.enrichmentDiagnostics.filter((d) => /never matched/.test(d)),
    [],
    'a recovered click is not reported as a failure'
  );
});

test('an error during the scan is returned, not swallowed into nothing', async () => {
  // A thrown error inside an async injected script rejects its promise, and
  // chrome.scripting.executeScript then hands the panel no result at all -- so
  // a crash and a wrong page looked identical ("the scanner returned nothing"),
  // with nothing to debug from. The error has to come back as data.
  const date = isoDateOffsetFromToday(-1);
  const calendarHtml = buildGrid(
    [
      { name: 'Boom, Bea', shifts: [
        { date, start: '09:00:00.000000', end: '12:00:00.000000', client: 'Client B', eventId: 'boom' },
      ] },
    ],
    [date]
  );

  // Break something the run section depends on, the way a WellSky markup change
  // or a browser quirk would.
  const result = await runScanScript(calendarHtml, {
    fetchImpl: () => Promise.reject(new Error('unused')),
    breakDocument: true,
  });

  assert.ok(result, 'a result comes back at all');
  assert.ok(result.error, 'and it carries the error');
  assert.match(result.error, /kaboom/);
  assert.ok(result.pageUrl, 'plus the page it happened on');
});
