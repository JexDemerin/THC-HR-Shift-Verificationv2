// Apps Script Web App bound to the destination Google Sheet.
// Deploy: Extensions -> Apps Script -> paste this in -> Deploy -> New deployment -> Web app.
//
// Receives the array of shift records the extension's background.js posts
// (see extension/background.js -- body is `JSON.stringify(records)`, a bare
// array, not wrapped in an object) and mirrors them into two tabs PER MONTH:
//
//   "2026-07 Log"     -- one row per shift (or per caregiver/day with no
//                        shift, which reads "-"), sorted by date then
//                        caregiver name.
//   "2026-07 Payroll" -- caregivers down the left, every date in the month
//                        across the top with its weekday beneath, a spacer
//                        column between each Saturday and Sunday. Each cell
//                        holds that caregiver's total hours for the day as a
//                        decimal, colored by shift status, with a hover note
//                        breaking down each client visit.
//
// Which month a record lands in is decided by its own shift_date, so a scan
// spanning a month boundary files each row correctly.
//
// The Log tab is the source of truth: every scan upserts into it, then the
// Payroll tab for that month is rebuilt from it. That keeps Payroll correct
// even though each scan only sees one week of the schedule at a time.

var LOG_HEADERS = [
  'caregiver_name', 'client_name', 'shift_date',
  'time_in', 'time_out', 'duration_minutes', 'label_duration_minutes',
  'actual_time_in', 'scheduled_time_in',
  'actual_time_out', 'scheduled_time_out',
  'status', 'status_raw', 'note', 'event_id', 'row_key', 'scanned_at'
];

var ROW_KEY_COL = LOG_HEADERS.indexOf('row_key') + 1; // 1-based sheet column

// Matches the WellSky legend colors the original scanner used, so a cell's
// color means the same thing here as it does on the schedule itself.
var STATUS_COLORS = {
  completed: '#b7e1cd',              // green
  incomplete: '#f4c7c3',             // red
  ongoing: '#fce8b2',                // yellow
  upcoming: '#4a86c8',               // dark blue
  cancelled_by_caregiver: '#f9cb9c', // orange
  cancelled_by_office: '#f6b26b',    // darker orange
  cancelled_by_client: '#a4c2f4',    // sky blue
  unparsed: '#d9d2e9'                // leftover: something needs a human look
};

// Most urgent status wins the cell when a caregiver worked more than one
// shift that day -- an incomplete log must never be hidden behind a
// completed one.
var STATUS_URGENCY = [
  'unparsed',
  'incomplete',
  'cancelled_by_client',
  'cancelled_by_office',
  'cancelled_by_caregiver',
  'ongoing',
  'completed',
  'upcoming',
  'no_shift'
];

var WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---- Helpers ----

function monthKeyOf_(isoDate) {
  return isoDate ? isoDate.slice(0, 7) : null; // "2026-07-28" -> "2026-07"
}

function logSheetName_(monthKey) {
  return monthKey + ' Log';
}

function payrollSheetName_(monthKey) {
  return monthKey + ' Payroll';
}

function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers) {
      sheet.appendRow(headers);
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

// Payroll's official quarter-hour rounding table: 0-7 leftover minutes round
// down to :00, 8-22 -> :15, 23-37 -> :30, 38-52 -> :45, 53+ rounds up to the
// next full hour. Applied to the day's TOTAL, not to each shift separately.
function roundedDecimalHours_(totalMinutes) {
  var hours = Math.floor(totalMinutes / 60);
  var leftover = totalMinutes % 60;
  var fraction;
  if (leftover <= 7) fraction = 0;
  else if (leftover <= 22) fraction = 0.25;
  else if (leftover <= 37) fraction = 0.5;
  else if (leftover <= 52) fraction = 0.75;
  else fraction = 1;
  return hours + fraction;
}

function formatHoursMinutes_(totalMinutes) {
  var hours = Math.floor(totalMinutes / 60);
  var minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return hours + 'h' + minutes + 'm';
  if (hours > 0) return hours + 'h';
  return minutes + 'm';
}

function mostUrgentStatus_(statuses) {
  for (var i = 0; i < STATUS_URGENCY.length; i++) {
    if (statuses.indexOf(STATUS_URGENCY[i]) !== -1) return STATUS_URGENCY[i];
  }
  return statuses.length ? statuses[0] : 'no_shift';
}

function daysInMonth_(monthKey) {
  var parts = monthKey.split('-');
  var year = parseInt(parts[0], 10);
  var month = parseInt(parts[1], 10);
  return new Date(year, month, 0).getDate(); // day 0 of next month = last of this
}

function isoDate_(monthKey, day) {
  return monthKey + '-' + (day < 10 ? '0' + day : String(day));
}

function weekdayIndexOf_(isoDate) {
  var parts = isoDate.split('-');
  return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)).getDay();
}

// ---- Log tab ----

function rowValuesFor_(record) {
  return LOG_HEADERS.map(function (key) {
    var value = record[key];
    if (value === null || value === undefined) return '';
    return value;
  });
}

function readRowKeyIndex_(sheet) {
  var lastRow = sheet.getLastRow();
  var index = {};
  if (lastRow < 2) return index;
  var keys = sheet.getRange(2, ROW_KEY_COL, lastRow - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) {
    if (keys[i][0]) index[keys[i][0]] = i + 2; // +2: 1-based, plus header row
  }
  return index;
}

function upsertLogRows_(monthKey, records) {
  var sheet = getOrCreateSheet_(logSheetName_(monthKey), LOG_HEADERS);
  var existingKeys = readRowKeyIndex_(sheet);

  // A caregiver/day that now has a real shift must not keep a stale "-" row
  // from an earlier scan sitting alongside it.
  var supersededRows = [];
  records.forEach(function (record) {
    if (record.status !== 'no_shift' && record.caregiver_name && record.shift_date) {
      var staleKey = 'no-shift:' + record.caregiver_name + ':' + record.shift_date;
      if (existingKeys[staleKey]) supersededRows.push(existingKeys[staleKey]);
    }
  });

  if (supersededRows.length) {
    // Delete from the bottom up so earlier deletions don't shift the indices
    // of rows still to be deleted, then re-read the index since every row
    // below a deletion has moved.
    supersededRows.sort(function (a, b) { return b - a; }).forEach(function (rowIndex) {
      sheet.deleteRow(rowIndex);
    });
    existingKeys = readRowKeyIndex_(sheet);
  }

  var appended = [];
  records.forEach(function (record) {
    var values = rowValuesFor_(record);
    var existingRow = existingKeys[record.row_key];
    if (existingRow) {
      sheet.getRange(existingRow, 1, 1, LOG_HEADERS.length).setValues([values]);
    } else {
      appended.push(values);
    }
  });

  if (appended.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appended.length, LOG_HEADERS.length).setValues(appended);
  }

  sortLogSheet_(sheet);
  return records.length;
}

// Date chronological, then caregiver alphabetical within each date.
function sortLogSheet_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 3) return;
  var dateCol = LOG_HEADERS.indexOf('shift_date') + 1;
  var caregiverCol = LOG_HEADERS.indexOf('caregiver_name') + 1;
  sheet.getRange(2, 1, lastRow - 1, LOG_HEADERS.length).sort([
    { column: dateCol, ascending: true },
    { column: caregiverCol, ascending: true }
  ]);
}

function readLogRecords_(monthKey) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(logSheetName_(monthKey));
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var values = sheet.getRange(2, 1, lastRow - 1, LOG_HEADERS.length).getValues();
  return values.map(function (row) {
    var record = {};
    LOG_HEADERS.forEach(function (key, index) {
      record[key] = row[index];
    });
    return record;
  });
}

// ---- Payroll tab ----

// Builds the column layout: every date in the month in order, with a spacer
// column inserted between each Saturday and Sunday so weeks read separately.
function buildPayrollColumns_(monthKey) {
  var columns = [];
  var total = daysInMonth_(monthKey);
  for (var day = 1; day <= total; day++) {
    var date = isoDate_(monthKey, day);
    var weekday = weekdayIndexOf_(date);
    // Sunday starts a new week, so the divider goes just before it -- i.e.
    // between Saturday and Sunday. Not needed before the month's first column.
    if (weekday === 0 && columns.length > 0) {
      columns.push({ spacer: true });
    }
    columns.push({ spacer: false, date: date, weekday: WEEKDAY_NAMES[weekday] });
  }
  return columns;
}

function shortDateLabel_(isoDate) {
  var parts = isoDate.split('-');
  return parseInt(parts[1], 10) + '/' + parseInt(parts[2], 10); // "2026-07-05" -> "7/5"
}

// caregiver -> date -> { totalMinutes, statuses, noteLines, hasRealShift }
function aggregateByCaregiverAndDate_(records) {
  var byCaregiver = {};
  records.forEach(function (record) {
    var caregiver = record.caregiver_name;
    var date = record.shift_date;
    if (!caregiver || !date) return;
    // Dates arrive as strings from the extension but Sheets may hand back a
    // Date object once they've been through a cell.
    if (date instanceof Date) {
      date = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }

    if (!byCaregiver[caregiver]) byCaregiver[caregiver] = {};
    if (!byCaregiver[caregiver][date]) {
      byCaregiver[caregiver][date] = {
        totalMinutes: 0,
        statuses: [],
        noteLines: [],
        hasRealShift: false,
        // Sibling care: one caregiver looking after two siblings in the same
        // house over the exact same hours shows up as two separate shifts
        // with identical start AND end times. Those hours were only worked
        // once, so minutes are tracked PER DISTINCT TIME RANGE and summed at
        // the end -- deliberately not "first one wins", which would zero out
        // a real shift that happened to share its times with an incomplete
        // one processed just before it. Both clients still show in the note.
        minutesByTimeRange: {},
        timeRangeCounts: {},
        siblingCare: false
      };
    }
    var cell = byCaregiver[caregiver][date];
    cell.statuses.push(record.status);

    if (record.status === 'no_shift') return;
    cell.hasRealShift = true;

    var minutes = toMinutes_(record.duration_minutes);
    // For a missed clock-in/out this is the *scheduled* span rather than
    // hours worked -- shown in the note so the office can see what was
    // supposed to happen, while the cell total stays zero.
    var labelMinutes = toMinutes_(record.label_duration_minutes);
    var noteMinutes = labelMinutes !== null ? labelMinutes : minutes;

    var timeRangeKey = String(record.time_in) + '|' + String(record.time_out);
    cell.timeRangeCounts[timeRangeKey] = (cell.timeRangeCounts[timeRangeKey] || 0) + 1;
    if (cell.timeRangeCounts[timeRangeKey] > 1) cell.siblingCare = true;

    if (minutes !== null) {
      // Highest wins for a shared time range, so a completed shift's real
      // hours aren't lost to an incomplete sibling shift's zero.
      var existing = cell.minutesByTimeRange[timeRangeKey];
      if (existing === undefined || minutes > existing) {
        cell.minutesByTimeRange[timeRangeKey] = minutes;
      }
    }

    if (noteMinutes !== null) {
      // One consistent format for every line, whatever the status -- the
      // cell's own color already says which shifts need follow-up, so the
      // note doesn't repeat it. e.g. "1:00pm - 5:05pm = 4h5m (Chiang, Ryan)"
      cell.noteLines.push(
        (record.time_in || '?') + ' - ' + (record.time_out || '?') +
        ' = ' + formatHoursMinutes_(noteMinutes) +
        ' (' + (record.client_name || 'unknown client') + ')'
      );
    }
  });

  Object.keys(byCaregiver).forEach(function (caregiver) {
    Object.keys(byCaregiver[caregiver]).forEach(function (date) {
      var cell = byCaregiver[caregiver][date];
      cell.totalMinutes = Object.keys(cell.minutesByTimeRange).reduce(function (sum, key) {
        return sum + cell.minutesByTimeRange[key];
      }, 0);
    });
  });

  return byCaregiver;
}

function toMinutes_(value) {
  if (value === '' || value === null || value === undefined) return null;
  var number = Number(value);
  return isNaN(number) ? null : number;
}

function cellValueFor_(status, totalMinutes, hasRealShift) {
  if (!hasRealShift) return '-';
  if (status === 'ongoing') return 'ongoing';
  if (status === 'incomplete') return 0;
  if (status.indexOf('cancelled_') === 0) return 0;
  if (status === 'upcoming') return '';
  return roundedDecimalHours_(totalMinutes);
}

function rebuildPayrollSheet_(monthKey) {
  var records = readLogRecords_(monthKey);
  var sheet = getOrCreateSheet_(payrollSheetName_(monthKey), null);
  sheet.clear();

  var columns = buildPayrollColumns_(monthKey);
  var byCaregiver = aggregateByCaregiverAndDate_(records);
  var caregivers = Object.keys(byCaregiver).sort(function (a, b) {
    return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
  });

  var width = columns.length + 1; // +1 for the caregiver-name column

  // Header rows: dates across the top, weekday beneath each.
  var dateRow = ['Caregiver'];
  var weekdayRow = [''];
  columns.forEach(function (column) {
    dateRow.push(column.spacer ? '' : shortDateLabel_(column.date));
    weekdayRow.push(column.spacer ? '' : column.weekday);
  });
  sheet.getRange(1, 1, 1, width).setValues([dateRow]).setFontWeight('bold');
  sheet.getRange(2, 1, 1, width).setValues([weekdayRow]).setFontWeight('bold');

  if (caregivers.length === 0) {
    sheet.setFrozenRows(2);
    sheet.setFrozenColumns(1);
    return 0;
  }

  var grid = [];
  var notes = [];
  var colors = [];

  caregivers.forEach(function (caregiver) {
    var rowValues = [caregiver];
    var rowNotes = [''];
    var rowColors = [null];

    columns.forEach(function (column) {
      if (column.spacer) {
        rowValues.push('');
        rowNotes.push('');
        rowColors.push('#d9d9d9'); // visible divider between weeks
        return;
      }

      var cell = byCaregiver[caregiver][column.date];
      if (!cell) {
        // No record at all for this caregiver/date -- e.g. a date that hasn't
        // been scanned yet, or one still in the future. Left blank rather than
        // "-", since "-" means "scanned, and they didn't work".
        rowValues.push('');
        rowNotes.push('');
        rowColors.push(null);
        return;
      }

      var status = mostUrgentStatus_(cell.statuses);
      rowValues.push(cellValueFor_(status, cell.totalMinutes, cell.hasRealShift));
      rowNotes.push(cell.noteLines.join('\n'));
      rowColors.push(STATUS_COLORS[status] || null);
    });

    grid.push(rowValues);
    notes.push(rowNotes);
    colors.push(rowColors);
  });

  var body = sheet.getRange(3, 1, grid.length, width);
  body.setValues(grid);
  body.setNotes(notes);
  body.setBackgrounds(colors);

  sheet.setFrozenRows(2);
  sheet.setFrozenColumns(1);
  return caregivers.length;
}

// ---- Entry point ----

function doPost(e) {
  var records = JSON.parse(e.postData.contents);
  if (!Array.isArray(records)) records = records.records || [];

  // Group by month so a scan spanning a month boundary files each row in the
  // right pair of tabs.
  var byMonth = {};
  records.forEach(function (record) {
    var monthKey = monthKeyOf_(record.shift_date);
    if (!monthKey) return;
    if (!byMonth[monthKey]) byMonth[monthKey] = [];
    byMonth[monthKey].push(record);
  });

  var written = 0;
  var monthsTouched = [];
  Object.keys(byMonth).forEach(function (monthKey) {
    written += upsertLogRows_(monthKey, byMonth[monthKey]);
    rebuildPayrollSheet_(monthKey);
    monthsTouched.push(monthKey);
  });

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, written: written, months: monthsTouched }))
    .setMimeType(ContentService.MimeType.JSON);
}
