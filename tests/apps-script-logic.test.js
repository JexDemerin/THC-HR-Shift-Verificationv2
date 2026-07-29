const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Code.gs is plain ES5 meant for Apps Script, so its pure logic can be loaded
// and exercised directly in Node -- the Sheets-specific globals it never calls
// from these functions are stubbed just enough for the file to evaluate.
function loadCodeGs() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'apps_script', 'Code.gs'), 'utf8');
  const sandbox = {
    SpreadsheetApp: {},
    ContentService: { MimeType: { JSON: 'JSON' } },
    Utilities: {},
    Session: { getScriptTimeZone: () => 'UTC' },
  };
  vm.createContext(sandbox);
  new vm.Script(source).runInContext(sandbox);
  return sandbox;
}

const code = loadCodeGs();

// Arrays built inside the vm sandbox have that realm's Array prototype, so
// assert.deepEqual sees them as "same structure but not reference-equal".
// Copying into this realm's Array makes the comparison meaningful.
const local = (arr) => Array.prototype.slice.call(arr);

// ---- Quarter-hour rounding table ----

test('applies payroll quarter-hour rounding to the day total', () => {
  assert.equal(code.roundedDecimalHours_(0), 0);
  assert.equal(code.roundedDecimalHours_(60), 1); // exactly an hour
  assert.equal(code.roundedDecimalHours_(67), 1); // 1h7m -> rounds down
  assert.equal(code.roundedDecimalHours_(68), 1.25); // 1h8m -> :15
  assert.equal(code.roundedDecimalHours_(82), 1.25); // 1h22m -> :15
  assert.equal(code.roundedDecimalHours_(83), 1.5); // 1h23m -> :30
  assert.equal(code.roundedDecimalHours_(97), 1.5); // 1h37m -> :30
  assert.equal(code.roundedDecimalHours_(98), 1.75); // 1h38m -> :45
  assert.equal(code.roundedDecimalHours_(112), 1.75); // 1h52m -> :45
  assert.equal(code.roundedDecimalHours_(113), 2); // 1h53m -> next full hour
  assert.equal(code.roundedDecimalHours_(137), 2.25); // 2h17m -> 2.25 (README example)
  // 4h5m has only 5 leftover minutes, so it rounds DOWN to 4.00 -- matching
  // the real dialog capture that showed Bill/Pay Hours of exactly 4.
  assert.equal(code.roundedDecimalHours_(245), 4);
  assert.equal(code.roundedDecimalHours_(250), 4.25); // 4h10m -> :15
});

test('formats hours and minutes the way the cell notes need', () => {
  assert.equal(code.formatHoursMinutes_(245), '4h5m');
  assert.equal(code.formatHoursMinutes_(240), '4h');
  assert.equal(code.formatHoursMinutes_(45), '45m');
  assert.equal(code.formatHoursMinutes_(0), '0m');
});

// ---- Month/date helpers ----

test('knows how many days each month has, including leap February', () => {
  assert.equal(code.daysInMonth_('2026-07'), 31);
  assert.equal(code.daysInMonth_('2026-06'), 30);
  assert.equal(code.daysInMonth_('2026-02'), 28);
  assert.equal(code.daysInMonth_('2028-02'), 29); // leap year
});

test('files a record under the month of its own shift date', () => {
  assert.equal(code.monthKeyOf_('2026-07-31'), '2026-07');
  assert.equal(code.monthKeyOf_('2026-08-01'), '2026-08');
  assert.equal(code.monthKeyOf_(null), null);
});

test('labels dates in short m/d form', () => {
  assert.equal(code.shortDateLabel_('2026-07-05'), '7/5');
  assert.equal(code.shortDateLabel_('2026-07-27'), '7/27');
  assert.equal(code.shortDateLabel_('2026-12-31'), '12/31');
});

// ---- Payroll column layout ----

test('lays out every date in the month, not just scanned ones', () => {
  const columns = code.buildPayrollColumns_('2026-07');
  const dateColumns = columns.filter((c) => !c.spacer);

  assert.equal(dateColumns.length, 31);
  assert.equal(dateColumns[0].date, '2026-07-01');
  assert.equal(dateColumns[30].date, '2026-07-31');
});

test('puts a spacer column between every Saturday and Sunday', () => {
  const columns = code.buildPayrollColumns_('2026-07');

  // Each spacer must sit immediately after a Saturday and before a Sunday.
  const spacerIndexes = columns.map((c, i) => (c.spacer ? i : -1)).filter((i) => i !== -1);
  assert.ok(spacerIndexes.length > 0, 'expected at least one week divider');

  for (const index of spacerIndexes) {
    assert.equal(columns[index - 1].weekday, 'Sat', 'spacer should follow a Saturday');
    assert.equal(columns[index + 1].weekday, 'Sun', 'spacer should precede a Sunday');
  }
});

test('does not open the month with a leading spacer when the 1st is a Sunday', () => {
  // 2026-11-01 is a Sunday.
  const columns = code.buildPayrollColumns_('2026-11');

  assert.equal(columns[0].spacer, false);
  assert.equal(columns[0].weekday, 'Sun');
});

test('marks each date with its real weekday', () => {
  const columns = code.buildPayrollColumns_('2026-07').filter((c) => !c.spacer);
  const byDate = Object.fromEntries(columns.map((c) => [c.date, c.weekday]));

  // 2026-07-27 is a Monday (matches the real WellSky screenshot: "Mon 07/27").
  assert.equal(byDate['2026-07-27'], 'Mon');
  assert.equal(byDate['2026-07-28'], 'Tue');
  assert.equal(byDate['2026-08-01'], undefined, 'August must not appear in the July tab');
});

// ---- Most-urgent-status-wins ----

test('an incomplete shift wins the cell over a completed one', () => {
  assert.equal(code.mostUrgentStatus_(['completed', 'incomplete']), 'incomplete');
  assert.equal(code.mostUrgentStatus_(['completed', 'ongoing']), 'ongoing');
  assert.equal(code.mostUrgentStatus_(['completed', 'cancelled_by_client']), 'cancelled_by_client');
  assert.equal(code.mostUrgentStatus_(['completed']), 'completed');
  assert.equal(code.mostUrgentStatus_(['no_shift']), 'no_shift');
});

// ---- Cell values ----

test('cell shows "-" when the caregiver had no shift that day', () => {
  assert.equal(code.cellValueFor_('no_shift', 0, false), '-');
});

test('cell shows rounded decimal hours for a completed day', () => {
  assert.equal(code.cellValueFor_('completed', 250, true), 4.25); // 4h10m
  assert.equal(code.cellValueFor_('completed', 245, true), 4); // 4h5m rounds down
});

test('cell shows 0 for incomplete and cancelled shifts', () => {
  assert.equal(code.cellValueFor_('incomplete', 480, true), 0);
  assert.equal(code.cellValueFor_('cancelled_by_client', 480, true), 0);
  assert.equal(code.cellValueFor_('cancelled_by_office', 480, true), 0);
  assert.equal(code.cellValueFor_('cancelled_by_caregiver', 480, true), 0);
});

test('cell says "ongoing" for a shift still in progress', () => {
  assert.equal(code.cellValueFor_('ongoing', 120, true), 'ongoing');
});

// ---- Aggregation across clients ----

test('sums a day across two clients and notes each visit separately', () => {
  const records = [
    {
      caregiver_name: 'Barberi, Miku', client_name: 'A. Palapati', shift_date: '2026-07-27',
      time_in: '3:00pm', time_out: '6:00pm', duration_minutes: 180, status: 'completed',
    },
    {
      caregiver_name: 'Barberi, Miku', client_name: 'S. Palapati', shift_date: '2026-07-27',
      time_in: '6:15pm', time_out: '9:00pm', duration_minutes: 165, status: 'completed',
    },
  ];

  const byCaregiver = code.aggregateByCaregiverAndDate_(records);
  const cell = byCaregiver['Barberi, Miku']['2026-07-27'];

  assert.equal(cell.totalMinutes, 345); // 5h45m
  assert.equal(code.cellValueFor_('completed', cell.totalMinutes, true), 5.75);
  assert.deepEqual(local(cell.noteLines), [
    '3:00pm - 6:00pm = 3h (A. Palapati)',
    '6:15pm - 9:00pm = 2h45m (S. Palapati)',
  ]);
});

test('an incomplete shift contributes no note line', () => {
  const records = [
    {
      caregiver_name: 'Amato, Savani', client_name: 'Joyner, Yusuf', shift_date: '2026-07-27',
      time_in: '11:00am', time_out: '6:00pm', duration_minutes: 0, status: 'incomplete',
    },
  ];

  const byCaregiver = code.aggregateByCaregiverAndDate_(records);
  const cell = byCaregiver['Amato, Savani']['2026-07-27'];

  assert.deepEqual(local(cell.noteLines), [], 'placeholder times must not read as worked hours');
  assert.equal(code.cellValueFor_('incomplete', cell.totalMinutes, true), 0);
});

test('a no-shift record marks the day as having no real shift', () => {
  const records = [
    {
      caregiver_name: 'Abaigar, Kit', client_name: '-', shift_date: '2026-07-27',
      duration_minutes: null, status: 'no_shift',
    },
  ];

  const byCaregiver = code.aggregateByCaregiverAndDate_(records);
  const cell = byCaregiver['Abaigar, Kit']['2026-07-27'];

  assert.equal(cell.hasRealShift, false);
  assert.equal(code.cellValueFor_(code.mostUrgentStatus_(cell.statuses), 0, cell.hasRealShift), '-');
});

test('every status that can reach a cell has a color', () => {
  // A status with no color would silently render as an uncolored cell, losing
  // the at-a-glance signal the whole payroll view depends on.
  const colorless = local(code.STATUS_URGENCY).filter(
    (status) => status !== 'no_shift' && !code.STATUS_COLORS[status]
  );
  assert.deepEqual(colorless, []);
});
