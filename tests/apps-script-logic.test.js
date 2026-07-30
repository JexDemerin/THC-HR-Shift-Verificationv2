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

test('an incomplete shift contributes no hours to the day total', () => {
  const records = [
    {
      caregiver_name: 'Amato, Savani', client_name: 'Joyner, Yusuf', shift_date: '2026-07-27',
      time_in: '11:00am', time_out: '6:00pm',
      duration_minutes: 0, label_duration_minutes: 420, status: 'incomplete',
    },
  ];

  const byCaregiver = code.aggregateByCaregiverAndDate_(records);
  const cell = byCaregiver['Amato, Savani']['2026-07-27'];

  // The scheduled span appears in the note (see the test below) but must not
  // reach the total, since nobody has verified those hours were worked.
  assert.equal(cell.totalMinutes, 0);
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

// ---- Incomplete shifts keep their scheduled breakdown in the note ----

test('an incomplete shift shows its scheduled span and client in the note, cell still 0', () => {
  const records = [
    {
      caregiver_name: 'Amato, Savani', client_name: 'Joyner, Yusuf', shift_date: '2026-07-27',
      time_in: '11:00am', time_out: '6:00pm',
      duration_minutes: 0,        // no payable hours until someone verifies them
      label_duration_minutes: 420, // but the schedule said 7h
      status: 'incomplete',
    },
  ];

  const byCaregiver = code.aggregateByCaregiverAndDate_(records);
  const cell = byCaregiver['Amato, Savani']['2026-07-27'];

  assert.equal(code.cellValueFor_('incomplete', cell.totalMinutes, true), 0);
  // Same plain format as any other line -- the red cell already signals that
  // this one needs follow-up, so the note doesn't restate it.
  assert.deepEqual(local(cell.noteLines), ['11:00am - 6:00pm = 7h (Joyner, Yusuf)']);
});

// ---- Sibling care ----

test('sibling care counts identical times once, not per client', () => {
  // Same caregiver, same day, two siblings, exactly the same hours -- those
  // three hours were only worked once.
  const records = [
    {
      caregiver_name: 'Foketi, Ma\'ata', client_name: 'Pallapati, Samson', shift_date: '2026-07-27',
      time_in: '1:00pm', time_out: '4:00pm', duration_minutes: 180, label_duration_minutes: 180,
      status: 'completed',
    },
    {
      caregiver_name: 'Foketi, Ma\'ata', client_name: 'Pallapati, Aaron', shift_date: '2026-07-27',
      time_in: '1:00pm', time_out: '4:00pm', duration_minutes: 180, label_duration_minutes: 180,
      status: 'completed',
    },
  ];

  const byCaregiver = code.aggregateByCaregiverAndDate_(records);
  const cell = byCaregiver['Foketi, Ma\'ata']['2026-07-27'];

  assert.equal(cell.totalMinutes, 180, 'three hours, not six');
  assert.equal(code.cellValueFor_('completed', cell.totalMinutes, true), 3);
  assert.equal(cell.siblingCare, true);

  // Both siblings still get their own plain note line, and nothing else is
  // appended -- the hours being counted once is intentional, not annotated.
  assert.deepEqual(local(cell.noteLines), [
    '1:00pm - 4:00pm = 3h (Pallapati, Samson)',
    '1:00pm - 4:00pm = 3h (Pallapati, Aaron)',
  ]);
});

test('two shifts at different times are NOT treated as sibling care', () => {
  const records = [
    {
      caregiver_name: 'Barberi, Miku', client_name: 'A. Palapati', shift_date: '2026-07-27',
      time_in: '3:00pm', time_out: '6:00pm', duration_minutes: 180, label_duration_minutes: 180,
      status: 'completed',
    },
    {
      caregiver_name: 'Barberi, Miku', client_name: 'S. Palapati', shift_date: '2026-07-27',
      time_in: '6:15pm', time_out: '9:00pm', duration_minutes: 165, label_duration_minutes: 165,
      status: 'completed',
    },
  ];

  const byCaregiver = code.aggregateByCaregiverAndDate_(records);
  const cell = byCaregiver['Barberi, Miku']['2026-07-27'];

  assert.equal(cell.totalMinutes, 345, 'back-to-back shifts both count');
  assert.equal(cell.siblingCare, false);
  assert.equal(local(cell.noteLines).length, 2, 'one line per shift');
});

test('a partial overlap is not sibling care -- only exactly identical times are', () => {
  const records = [
    {
      caregiver_name: 'Overlap, Olive', client_name: 'Client A', shift_date: '2026-07-27',
      time_in: '1:00pm', time_out: '4:00pm', duration_minutes: 180, label_duration_minutes: 180,
      status: 'completed',
    },
    {
      caregiver_name: 'Overlap, Olive', client_name: 'Client B', shift_date: '2026-07-27',
      time_in: '1:00pm', time_out: '3:00pm', duration_minutes: 120, label_duration_minutes: 120,
      status: 'completed',
    },
  ];

  const byCaregiver = code.aggregateByCaregiverAndDate_(records);
  const cell = byCaregiver['Overlap, Olive']['2026-07-27'];

  assert.equal(cell.totalMinutes, 300, 'same start but different end -- both counted');
  assert.equal(cell.siblingCare, false);
});

test('sibling care on different days is counted separately per day', () => {
  const makePair = (date) => [
    {
      caregiver_name: 'Daily, Dana', client_name: 'Sib One', shift_date: date,
      time_in: '1:00pm', time_out: '4:00pm', duration_minutes: 180, label_duration_minutes: 180,
      status: 'completed',
    },
    {
      caregiver_name: 'Daily, Dana', client_name: 'Sib Two', shift_date: date,
      time_in: '1:00pm', time_out: '4:00pm', duration_minutes: 180, label_duration_minutes: 180,
      status: 'completed',
    },
  ];

  const byCaregiver = code.aggregateByCaregiverAndDate_([
    ...makePair('2026-07-27'),
    ...makePair('2026-07-28'),
  ]);

  assert.equal(byCaregiver['Daily, Dana']['2026-07-27'].totalMinutes, 180);
  assert.equal(byCaregiver['Daily, Dana']['2026-07-28'].totalMinutes, 180);
});

test('a completed shift keeps its hours when an incomplete sibling shares its times', () => {
  // Order matters here: a naive "first one wins" dedup would let the
  // incomplete shift's zero swallow the completed shift's real hours.
  const records = [
    {
      caregiver_name: 'Mixed, Morgan', client_name: 'Sib One', shift_date: '2026-07-27',
      time_in: '1:00pm', time_out: '4:00pm',
      duration_minutes: 0, label_duration_minutes: 180, status: 'incomplete',
    },
    {
      caregiver_name: 'Mixed, Morgan', client_name: 'Sib Two', shift_date: '2026-07-27',
      time_in: '1:00pm', time_out: '4:00pm',
      duration_minutes: 180, label_duration_minutes: 180, status: 'completed',
    },
  ];

  const byCaregiver = code.aggregateByCaregiverAndDate_(records);
  const cell = byCaregiver['Mixed, Morgan']['2026-07-27'];

  assert.equal(cell.totalMinutes, 180, 'the real hours survive, counted once');
  // The cell itself still reads 0, because incomplete outranks completed --
  // a missing clock-in has to stay visible for follow-up.
  assert.equal(code.mostUrgentStatus_(local(cell.statuses)), 'incomplete');
  assert.equal(code.cellValueFor_('incomplete', cell.totalMinutes, true), 0);
});

// ---- Header row integrity ----

// A deliberately small stand-in for a Sheets sheet: enough surface for
// ensureHeaderRow_ to be exercised for real, since getting this wrong would
// silently misalign payroll columns.
function makeFakeSheet(grid) {
  const cells = grid.map((row) => row.slice());
  let maxColumns = Math.max(8, ...cells.map((r) => r.length));
  let frozenRows = 0;

  const widthOf = () => Math.max(0, ...cells.map((r) => r.length));

  return {
    _cells: cells,
    getLastRow: () => cells.length,
    getLastColumn: () => widthOf(),
    getMaxColumns: () => maxColumns,
    insertColumnsAfter: (_after, count) => { maxColumns += count; },
    setFrozenRows: (n) => { frozenRows = n; },
    getFrozenRows: () => frozenRows,
    clear: () => { cells.length = 0; },
    getRange: (row, col, numRows, numCols) => ({
      getValues: () => {
        const out = [];
        for (let r = 0; r < numRows; r++) {
          const source = cells[row - 1 + r] || [];
          const line = [];
          for (let c = 0; c < numCols; c++) line.push(source[col - 1 + c] ?? '');
          out.push(line);
        }
        return out;
      },
      setValues: (values) => {
        values.forEach((line, r) => {
          const target = row - 1 + r;
          while (cells.length <= target) cells.push([]);
          line.forEach((value, c) => { cells[target][col - 1 + c] = value; });
        });
        return { setFontWeight: () => {} };
      },
    }),
  };
}

test('writes the header row into a brand new tab', () => {
  const sheet = makeFakeSheet([]);

  code.ensureHeaderRow_(sheet, code.LOG_HEADERS);

  assert.deepEqual(local(sheet._cells[0]), local(code.LOG_HEADERS));
  assert.equal(sheet.getFrozenRows(), 1);
});

test('restores a header row that was deleted by hand, keeping the data', () => {
  // Someone cleared row 1 but the data rows are still there.
  const sheet = makeFakeSheet([
    code.LOG_HEADERS.map(() => ''),
    ['Barberi, Miku', 'Kozuka-Ssenyan, Mia', '2026-07-27'],
  ]);

  code.ensureHeaderRow_(sheet, code.LOG_HEADERS);

  assert.deepEqual(local(sheet._cells[0]), local(code.LOG_HEADERS));
  assert.equal(sheet._cells[1][0], 'Barberi, Miku', 'the data row survived');
});

test('leaves a correct header row alone', () => {
  const sheet = makeFakeSheet([
    local(code.LOG_HEADERS),
    ['Barberi, Miku', 'Kozuka-Ssenyan, Mia', '2026-07-27'],
  ]);

  code.ensureHeaderRow_(sheet, code.LOG_HEADERS);

  assert.deepEqual(local(sheet._cells[0]), local(code.LOG_HEADERS));
  assert.equal(sheet._cells.length, 2, 'nothing was rewritten');
});

test('migrates rows by column name when an older tab is missing a column', () => {
  // The real case: a tab written before label_duration_minutes existed. Its
  // values must follow their column NAMES, not their old positions -- else
  // every field after the inserted column silently shifts one place left.
  const oldHeaders = local(code.LOG_HEADERS).filter((h) => h !== 'label_duration_minutes');
  const oldRow = oldHeaders.map((header) => 'value:' + header);
  const sheet = makeFakeSheet([oldHeaders, oldRow]);

  code.ensureHeaderRow_(sheet, code.LOG_HEADERS);

  assert.deepEqual(local(sheet._cells[0]), local(code.LOG_HEADERS));

  const migrated = {};
  code.LOG_HEADERS.forEach((header, index) => { migrated[header] = sheet._cells[1][index]; });

  // Every pre-existing value still sits under its own column name...
  oldHeaders.forEach((header) => {
    assert.equal(migrated[header], 'value:' + header, `${header} kept its value`);
  });
  // ...and the newly added column is simply blank rather than stealing the
  // value of whatever used to occupy its position.
  assert.equal(migrated.label_duration_minutes, '');
});

test('drops a column that no longer exists rather than shifting everything', () => {
  const oldHeaders = ['caregiver_name', 'a_retired_column', 'client_name'];
  const sheet = makeFakeSheet([oldHeaders, ['Barberi, Miku', 'stale', 'Kozuka-Ssenyan, Mia']]);

  code.ensureHeaderRow_(sheet, code.LOG_HEADERS);

  const migrated = {};
  code.LOG_HEADERS.forEach((header, index) => { migrated[header] = sheet._cells[1][index]; });

  assert.equal(migrated.caregiver_name, 'Barberi, Miku');
  assert.equal(migrated.client_name, 'Kozuka-Ssenyan, Mia');
  assert.equal(local(sheet._cells[1]).indexOf('stale'), -1, 'the retired value is gone, not moved');
});

// ---- Tab naming ----

test('names the tabs per month, in a stable sortable form', () => {
  assert.equal(code.logSheetName_('2026-07'), '2026-07 Log');
  assert.equal(code.payrollSheetName_('2026-07'), '2026-07 Payroll');
  assert.equal(code.logSheetName_('2026-12'), '2026-12 Log');
  // Zero-padded so the tabs sort chronologically rather than 1, 10, 11, 2...
  assert.equal(code.monthKeyOf_('2026-01-05'), '2026-01');
  assert.equal(code.logSheetName_(code.monthKeyOf_('2026-01-05')), '2026-01 Log');
});

// ---- Version handshake ----

test('the script reports a version the extension can check against', () => {
  assert.equal(typeof code.SCRIPT_VERSION, 'number');
  assert.ok(code.SCRIPT_VERSION > 0);
});

test('Code.gs SCRIPT_VERSION matches the extension\'s EXPECTED_SCRIPT_VERSION', () => {
  // These two must be bumped together. If they drift, the extension either
  // rejects a perfectly current deployment or accepts a stale one -- and a
  // stale one silently produces no monthly Log/Payroll tabs at all, which is
  // exactly the failure this handshake exists to make obvious.
  const popupSource = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.js'), 'utf8');
  const match = popupSource.match(/EXPECTED_SCRIPT_VERSION\s*=\s*(\d+)/);

  assert.ok(match, 'popup.js should declare EXPECTED_SCRIPT_VERSION');
  assert.equal(Number(match[1]), code.SCRIPT_VERSION);
});

test('doGet reports the version so the live deployment can be checked in a browser', () => {
  const captured = [];
  code.ContentService.createTextOutput = (text) => {
    captured.push(text);
    return { setMimeType: () => 'output' };
  };

  code.doGet();

  const payload = JSON.parse(captured[0]);
  assert.equal(payload.ok, true);
  assert.equal(payload.script_version, code.SCRIPT_VERSION);
  assert.deepEqual(payload.log_headers, local(code.LOG_HEADERS));
});

// ---- Re-scanning: merge, don't clobber ----

test('a blank from a failed re-read never erases an existing value', () => {
  // The whole point: the Edit Care Log click-through occasionally misses, and
  // a re-scan that couldn't read the times must not wipe the ones a previous
  // scan got right.
  const existing = {
    caregiver_name: 'Barberi, Miku', client_name: 'Kozuka-Ssenyan, Mia', shift_date: '2026-07-27',
    actual_time_in: '07/27/2026 07:11:25 PM', scheduled_time_in: '07/27/2026 07:00:00 PM',
    actual_time_out: '07/27/2026 09:11:43 PM', scheduled_time_out: '07/27/2026 09:00:00 PM',
    duration_minutes: 120, status: 'completed', note: 'a real note', row_key: 'evt-1',
  };
  const incoming = {
    caregiver_name: 'Barberi, Miku', client_name: 'Kozuka-Ssenyan, Mia', shift_date: '2026-07-27',
    actual_time_in: '', scheduled_time_in: null,
    actual_time_out: undefined, scheduled_time_out: '',
    duration_minutes: 120, status: 'completed', note: '', row_key: 'evt-1',
  };

  const merged = code.mergeRecord_(existing, incoming);

  assert.equal(merged.actual_time_in, '07/27/2026 07:11:25 PM');
  assert.equal(merged.scheduled_time_in, '07/27/2026 07:00:00 PM');
  assert.equal(merged.actual_time_out, '07/27/2026 09:11:43 PM');
  assert.equal(merged.scheduled_time_out, '07/27/2026 09:00:00 PM');
  assert.equal(merged.note, 'a real note');
});

test('a real new value does overwrite the old one', () => {
  const existing = {
    caregiver_name: 'Barberi, Miku', shift_date: '2026-07-27',
    status: 'incomplete', duration_minutes: 0, row_key: 'evt-1',
  };
  const incoming = {
    caregiver_name: 'Barberi, Miku', shift_date: '2026-07-27',
    status: 'completed', duration_minutes: 180, row_key: 'evt-1',
  };

  const merged = code.mergeRecord_(existing, incoming);

  // A shift fixed up in WellSky between scans must be reflected.
  assert.equal(merged.status, 'completed');
  assert.equal(merged.duration_minutes, 180);
});

test('a zero is a real value and is not treated as blank', () => {
  const merged = code.mergeRecord_(
    { duration_minutes: 180, row_key: 'k' },
    { duration_minutes: 0, row_key: 'k' }
  );

  // 0 hours is a meaningful payroll value (an incomplete shift), so it has to
  // survive the merge rather than being mistaken for "nothing read".
  assert.equal(merged.duration_minutes, 0);
});

test('sorts by date, then caregiver, then client', () => {
  const sorted = code.sortRecordsForLog_([
    { shift_date: '2026-07-28', caregiver_name: 'Alpha, A', client_name: 'X' },
    { shift_date: '2026-07-27', caregiver_name: 'Zulu, Z', client_name: 'X' },
    { shift_date: '2026-07-27', caregiver_name: 'Alpha, A', client_name: 'B' },
    { shift_date: '2026-07-27', caregiver_name: 'Alpha, A', client_name: 'A' },
  ]);

  assert.deepEqual(
    local(sorted).map((r) => `${r.shift_date} ${r.caregiver_name} ${r.client_name}`),
    [
      '2026-07-27 Alpha, A A',
      '2026-07-27 Alpha, A B',
      '2026-07-27 Zulu, Z X',
      '2026-07-28 Alpha, A X',
    ]
  );
});

test('normalizes a Date object back to the ISO string form', () => {
  // Sheets can hand a date column back as a Date. Without normalising, a
  // re-scan wouldn't recognise its own previously-written rows.
  code.Utilities.formatDate = (date, _tz, _fmt) => date.toISOString().slice(0, 10);

  assert.equal(code.normalizeDateValue_(new Date('2026-07-27T00:00:00Z')), '2026-07-27');
  assert.equal(code.normalizeDateValue_('2026-07-27'), '2026-07-27');
  assert.equal(code.normalizeDateValue_(null), '');
});

test('a caregiver/date pair the scan covered is resynced, other dates are untouched', () => {
  // Mirrors the real workflow: 7/27 and 7/28 were already scanned, and now the
  // same week is rescanned once 7/29 has passed.
  const covered = {};
  const incoming = [
    { caregiver_name: 'A', shift_date: '2026-07-27', row_key: 'evt-a27' },
    { caregiver_name: 'A', shift_date: '2026-07-29', row_key: 'evt-a29' },
  ];
  incoming.forEach((r) => { covered[code.caregiverDateKey_(r)] = true; });

  const existing = [
    { caregiver_name: 'A', shift_date: '2026-07-27', row_key: 'evt-a27' },   // rescanned
    { caregiver_name: 'A', shift_date: '2026-07-27', row_key: 'evt-deleted' }, // gone from WellSky
    { caregiver_name: 'A', shift_date: '2026-07-20', row_key: 'evt-lastweek' }, // different week
    { caregiver_name: 'B', shift_date: '2026-07-27', row_key: 'evt-b27' },    // scrolled out of view
  ];

  const incomingKeys = {};
  incoming.forEach((r) => { incomingKeys[r.row_key] = true; });
  const kept = existing.filter(
    (r) => !incomingKeys[r.row_key] && !covered[code.caregiverDateKey_(r)]
  );

  assert.deepEqual(
    local(kept).map((r) => r.row_key),
    ['evt-lastweek', 'evt-b27'],
    'only rows outside this scan\'s coverage are preserved'
  );
  // evt-deleted was inside coverage but absent from the scan -> dropped, so a
  // shift removed in WellSky does not linger as a ghost row.
});
