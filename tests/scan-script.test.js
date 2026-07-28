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
function buildFixture({ status, dataStart, dataEnd, clientName, caregiverName, eventId }) {
  return `
    <table>
      <tr class="sched_row">
        <td class="person-name"><a href="#">${caregiverName}</a></td>
        <td class="day-data">
          <div class="_event ${status} ajSet" data-event-id="${eventId}" data-start="${dataStart}" data-end="${dataEnd}">
            <div class="title"><span class="name">${clientName}</span><span class="time">1p-4p</span></div>
          </div>
        </td>
      </tr>
    </table>
  `;
}

function runScanScript(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://togetherhomecare.clearcareonline.com/dashboard/live/weekly/caregivers/',
  });
  global.document = dom.window.document;
  global.window = dom.window;
  try {
    // eslint-disable-next-line no-eval
    return eval(SCAN_SCRIPT_SOURCE);
  } finally {
    delete global.document;
    delete global.window;
  }
}

test('completed shift is parsed with caregiver/client/date/status/event_id', () => {
  const html = buildFixture({
    status: 'COMPLETED',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Kozuka-Ssenyan, Mia',
    caregiverName: 'Barberi, Miku',
    eventId: 'evt-123',
  });

  const result = runScanScript(html);

  assert.equal(result.records.length, 1);
  const record = result.records[0];
  assert.equal(record.caregiver_name, 'Barberi, Miku');
  assert.equal(record.client_name, 'Kozuka-Ssenyan, Mia');
  assert.equal(record.shift_date, '2026-07-27');
  assert.equal(record.status, 'completed');
  assert.equal(record.status_raw, 'COMPLETED');
  assert.equal(record.event_id, 'evt-123');
  // Not built yet on purpose -- see inspect-care-log-script.js.
  assert.equal(record.actual_time_in, null);
  assert.equal(record.scheduled_time_in, null);
  assert.equal(record.actual_time_out, null);
  assert.equal(record.scheduled_time_out, null);
});

test('missed clock-in/out maps to the "incomplete" status', () => {
  const html = buildFixture({
    status: 'MISSED_CLOCK_IN',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Joyner, Yusuf',
    caregiverName: 'Amato, Savani',
    eventId: 'evt-456',
  });

  const result = runScanScript(html);

  assert.equal(result.records[0].status, 'incomplete');
  assert.equal(result.summary.incomplete, 1);
});

test('an unrecognized status token is reported as unparsed, not dropped', () => {
  const html = buildFixture({
    status: 'SOME_NEW_STATUS_WELLSKY_ADDED',
    dataStart: '2026-07-27T09:00:00.000000',
    dataEnd: '2026-07-27T16:00:00.000000',
    clientName: 'Someone, Client',
    caregiverName: 'Someone, Caregiver',
    eventId: 'evt-789',
  });

  const result = runScanScript(html);

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].status, 'unparsed');
  assert.equal(result.summary.unparsed, 1);
});

test('no shifts on the page returns an empty, not throwing, result', () => {
  const result = runScanScript('<table></table>');

  assert.equal(result.records.length, 0);
  assert.equal(result.rowCount, 0);
  assert.equal(result.summary.total, 0);
});

function isoDateOffsetFromToday(dayOffset) {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('today and future shifts are skipped -- only past days get scanned', () => {
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

  const result = runScanScript(html);

  assert.equal(result.rowCount, 3, 'all three caregiver rows were on screen');
  assert.equal(result.records.length, 1, 'only the past-dated shift survives the filter');
  assert.equal(result.records[0].event_id, 'evt-past');
  assert.equal(result.skippedTodayOrFuture, 2);
});

test('an unparsed shift with no discoverable date is kept, not silently dropped', () => {
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

  const result = runScanScript(html);

  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].status, 'unparsed');
  assert.equal(result.records[0].shift_date, null);
});
