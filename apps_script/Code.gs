// Apps Script Web App bound to the destination Google Sheet.
// Deploy: Extensions -> Apps Script -> paste this in -> Deploy -> New deployment -> Web app.
//
// Receives the array of shift records the extension's background.js posts
// (see extension/background.js -- body is `JSON.stringify(records)`, a bare
// array, not wrapped in an object) and mirrors them into two tabs PER MONTH:
//
//   "2026 - 07 Log (July)"     -- one row per shift (or per caregiver/day with
//                          no shift, which reads "-"), sorted by date then
//                          caregiver name.
//   "2026 - 07 Payroll (July)" -- caregivers down the left, every date in the month
//                          across the top with its weekday beneath, a spacer
//                          column between each Saturday and Sunday. Each cell
//                          holds that caregiver's total hours for the day as a
//                          decimal, colored by shift status, with a hover note
//                          breaking down each client visit and its note.
//
// Which month a record lands in is decided by its own shift_date, so a scan
// spanning a month boundary files each row correctly.
//
// The Log tab is the source of truth: every scan upserts into it, then the
// Payroll tab for that month is rebuilt from it. That keeps Payroll correct
// even though each scan only sees one week of the schedule at a time.

// Bumped whenever this file changes in a way the extension depends on.
// Reported back on every doPost, and readable by opening the Web App URL in a
// browser (see doGet), so "is the deployed script actually current?" is a
// question with a definite answer instead of a guess. Saving the script does
// NOT change what a published Web App serves -- a new deployment version does.
var SCRIPT_VERSION = 10;

// official_* is the time on the calendar label -- what WellSky's own Edit Care
// Log dialog labels "Official", i.e. the agreed hours the shift is paid on.
// It's read straight off the schedule with no click, and it's what
// duration_minutes and the payroll hours are computed from. actual_* is the raw
// clock punch and scheduled_* the original plan, both only obtainable by
// clicking into the dialog. Three different facts, so three pairs of columns --
// the pair used to be called plain time_in/time_out, which read as though it
// were a redundant copy of actual_time_in.
var LOG_HEADERS = [
  'caregiver_name', 'client_name', 'shift_date',
  'official_time_in', 'official_time_out', 'duration_minutes', 'label_duration_minutes',
  'actual_time_in', 'scheduled_time_in',
  'actual_time_out', 'scheduled_time_out',
  'status', 'status_raw', 'note', 'event_id', 'row_key', 'scanned_at'
];

// Old column name -> its current name. Consulted when the header row is
// rewritten, so values already in a sheet follow their column to its new name.
// Without this the remap would find no column called "official_time_in" in an
// existing sheet and start it blank, throwing away every label time already
// scanned -- and with it the payroll hours derived from them.
var COLUMN_RENAMES = {
  time_in: 'official_time_in',
  time_out: 'official_time_out'
};

// The four columns holding a clock punch read out of the Edit Care Log dialog.
// Grouped because they share a format ("07:11:25 PM") distinct from the label
// times' shorter "7:11pm".
var CLOCK_PUNCH_COLUMNS = [
  'actual_time_in', 'scheduled_time_in',
  'actual_time_out', 'scheduled_time_out'
];

// Columns Sheets would otherwise reinterpret: a time like "2:13pm" becomes a
// time value stored as a fraction of a day, and a date string becomes a Date.
// Written as plain text so a value survives the round trip unchanged.
var TEXT_COLUMNS = [
  'shift_date', 'official_time_in', 'official_time_out',
  'actual_time_in', 'scheduled_time_in',
  'actual_time_out', 'scheduled_time_out',
  'scanned_at'
];

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

var MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// Separates the hours from the activity note inside a payroll cell's note.
var NOTE_SEPARATOR = '-----------------------------';

// ---- Helpers ----

function monthKeyOf_(isoDate) {
  return isoDate ? isoDate.slice(0, 7) : null; // "2026-07-28" -> "2026-07"
}

// "2026-07" -> "July 2026". Used for the readable suffix and for reporting
// which months a scan touched.
function monthLabelOf_(monthKey) {
  var parts = String(monthKey).split('-');
  var monthIndex = parseInt(parts[1], 10) - 1;
  if (parts.length !== 2 || isNaN(monthIndex) || !MONTH_NAMES[monthIndex]) return String(monthKey);
  return MONTH_NAMES[monthIndex] + ' ' + parts[0];
}

// "2026-07" -> "2026 - 07". Leads with the zero-padded year and month so the
// tabs stay in chronological order, with the month name appended after the tab
// type for readability -- "2026 - 07 Log (July)".
function monthNumberPrefixOf_(monthKey) {
  var parts = String(monthKey).split('-');
  if (parts.length !== 2) return String(monthKey);
  return parts[0] + ' - ' + parts[1];
}

function monthNameOf_(monthKey) {
  var monthIndex = parseInt(String(monthKey).split('-')[1], 10) - 1;
  return MONTH_NAMES[monthIndex] || null;
}

function sheetNameFor_(monthKey, kind) {
  var monthName = monthNameOf_(monthKey);
  var base = monthNumberPrefixOf_(monthKey) + ' ' + kind;
  return monthName ? base + ' (' + monthName + ')' : base;
}

function logSheetName_(monthKey) {
  return sheetNameFor_(monthKey, 'Log');
}

function payrollSheetName_(monthKey) {
  return sheetNameFor_(monthKey, 'Payroll');
}

// Every naming scheme this script has used, so a tab created under an older one
// gets adopted instead of being left orphaned beside a newly-created tab -- that
// would strand every already-scanned row in it.
function legacyLogSheetNames_(monthKey) {
  return [
    monthKey + ' Log',                  // "2026-07 Log"
    monthLabelOf_(monthKey) + ' Log'    // "July 2026 Log"
  ];
}

function legacyPayrollSheetNames_(monthKey) {
  return [
    monthKey + ' Payroll',
    monthLabelOf_(monthKey) + ' Payroll'
  ];
}

function renameLegacyTabIfPresent_(legacyNames, currentName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  // If a tab under the current name already exists, any legacy tab is a
  // leftover -- leave it alone rather than risk a name collision or clobbering
  // whichever one holds the real data. Nothing is ever deleted here.
  if (ss.getSheetByName(currentName)) return false;

  for (var i = 0; i < legacyNames.length; i++) {
    if (legacyNames[i] === currentName) continue;
    var legacy = ss.getSheetByName(legacyNames[i]);
    if (legacy) {
      legacy.setName(currentName);
      return true;
    }
  }
  return false;
}

function migrateLegacyTabNames_(monthKey) {
  renameLegacyTabIfPresent_(legacyLogSheetNames_(monthKey), logSheetName_(monthKey));
  renameLegacyTabIfPresent_(legacyPayrollSheetNames_(monthKey), payrollSheetName_(monthKey));
}

function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (headers) ensureHeaderRow_(sheet, headers);
  return sheet;
}

// Checked on EVERY write, not just when a tab is first created: a tab may have
// been made by an older version of this script (fewer columns), or had its
// header row edited or cleared by hand.
//
// Where the headers differ, existing data rows are REMAPPED by their old
// column names rather than left in place. Simply stamping the new header row
// over the old one would leave every existing value under whatever column name
// now happens to sit at that position -- e.g. adding a column in the middle
// would silently relabel real payroll timestamps as durations. Values whose
// column no longer exists are dropped; genuinely new columns start blank.
function headersMatch_(current, headers) {
  for (var i = 0; i < headers.length; i++) {
    if (String(current[i] === undefined || current[i] === null ? '' : current[i]) !== headers[i]) {
      return false;
    }
  }
  return true;
}

function ensureHeaderRow_(sheet, headers) {
  var width = headers.length;
  var lastColumn = sheet.getLastColumn();
  var lastRow = sheet.getLastRow();

  var current = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0] : [];
  if (headersMatch_(current, headers) && lastColumn >= width) return;

  if (sheet.getMaxColumns() < width) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), width - sheet.getMaxColumns());
  }

  // Nothing but a header row (or an empty sheet) -- just write the headers.
  var hasOldHeaders = current.some(function (value) { return String(value || '') !== ''; });
  if (lastRow < 2 || !hasOldHeaders) {
    sheet.getRange(1, 1, 1, width).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    return;
  }

  var oldRows = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  var remapped = oldRows.map(function (row) {
    var byOldName = {};
    current.forEach(function (name, index) {
      if (name) byOldName[String(name)] = row[index];
    });
    // Renames applied in a second pass so the result doesn't depend on column
    // order: a sheet caught mid-migration can hold both the old and the new
    // name, and whichever of the two actually has a value should win.
    current.forEach(function (name, index) {
      var renamedTo = name ? COLUMN_RENAMES[String(name)] : null;
      if (renamedTo && isBlank_(byOldName[renamedTo])) byOldName[renamedTo] = row[index];
    });
    return headers.map(function (name) {
      var value = byOldName[name];
      return value === undefined ? '' : value;
    });
  });

  sheet.clear();
  sheet.getRange(1, 1, 1, width).setValues([headers]).setFontWeight('bold');
  if (remapped.length) {
    sheet.getRange(2, 1, remapped.length, width).setValues(remapped);
  }
  sheet.setFrozenRows(1);
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

function isBlank_(value) {
  return value === '' || value === null || value === undefined;
}

function caregiverDateKey_(record) {
  return String(record.caregiver_name) + '|' + String(record.shift_date);
}

// The Sheet mirrors WellSky, so a re-scan's result wins -- including a blank.
// If a field was cleared in WellSky, the cell gets cleared too.
//
// The single exception is a field the scan could not DETERMINE, which the
// scanner reports in `unread_fields` (the Edit Care Log click-through does
// occasionally fail to open). A failed read is not an observation about
// WellSky, so blanking a cell on the strength of one would put a claim in the
// sheet that was never actually seen. Those fields keep their previous value;
// the popup's log names every shift this happened to.
function mergeRecord_(existing, incoming) {
  var unread = {};
  (incoming.unread_fields || []).forEach(function (field) {
    unread[field] = true;
  });

  var merged = {};
  LOG_HEADERS.forEach(function (key) {
    var keepPrevious = unread[key] && isBlank_(incoming[key]) && !isBlank_(existing[key]);
    merged[key] = keepPrevious ? existing[key] : incoming[key];
  });
  return merged;
}

function sortRecordsForLog_(records) {
  return records.slice().sort(function (a, b) {
    var dateA = String(a.shift_date || '');
    var dateB = String(b.shift_date || '');
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    var nameA = String(a.caregiver_name || '').toLowerCase();
    var nameB = String(b.caregiver_name || '').toLowerCase();
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    var clientA = String(a.client_name || '').toLowerCase();
    var clientB = String(b.client_name || '').toLowerCase();
    return clientA < clientB ? -1 : clientA > clientB ? 1 : 0;
  });
}

// Read the whole month, merge this scan into it, write it back sorted -- one
// read and one write rather than a per-row shuffle, and every decision made
// against a complete picture.
//
// The scan emits a row for EVERY caregiver on screen x EVERY past visible
// date, so the (caregiver, date) pairs in `records` are exactly what this scan
// had authoritative knowledge of. For those pairs, whatever the scan found IS
// the truth -- so a previously-logged shift that no longer appears there has
// been deleted or recreated in WellSky and its old row is dropped. Rows for
// any other pair (a different week, or a caregiver who was scrolled out of
// view) are left completely untouched.
function upsertLogRows_(monthKey, records) {
  var sheet = getOrCreateSheet_(logSheetName_(monthKey), LOG_HEADERS);
  var existing = readLogRecords_(monthKey);

  var existingByKey = {};
  existing.forEach(function (record) {
    if (record.row_key) existingByKey[String(record.row_key)] = record;
  });

  var covered = {};
  var incomingKeys = {};
  records.forEach(function (record) {
    if (record.caregiver_name && record.shift_date) covered[caregiverDateKey_(record)] = true;
    if (record.row_key) incomingKeys[String(record.row_key)] = true;
  });

  var kept = existing.filter(function (record) {
    // Anything this scan is about to write is handled by the merge below.
    if (record.row_key && incomingKeys[String(record.row_key)]) return false;
    // Outside this scan's coverage -- not ours to judge, leave it alone.
    return !covered[caregiverDateKey_(record)];
  });

  var mergedIncoming = records.map(function (record) {
    var previous = record.row_key ? existingByKey[String(record.row_key)] : null;
    return previous ? mergeRecord_(previous, record) : record;
  });

  var finalRows = sortRecordsForLog_(kept.concat(mergedIncoming));

  sheet.clearContents();
  sheet.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]).setFontWeight('bold');
  if (finalRows.length) {
    // Force the text-ish columns to plain text BEFORE writing, so Sheets stops
    // helpfully reinterpreting them: "2:13pm" was being stored as a time value
    // (a fraction of a day) and read back as a Date on 1899-12-30, and a date
    // string likewise became a Date. Keeping them as text means what goes in is
    // exactly what comes back out.
    TEXT_COLUMNS.forEach(function (name) {
      var index = LOG_HEADERS.indexOf(name);
      if (index >= 0) {
        sheet.getRange(2, index + 1, finalRows.length, 1).setNumberFormat('@');
      }
    });
    sheet.getRange(2, 1, finalRows.length, LOG_HEADERS.length)
      .setValues(finalRows.map(rowValuesFor_));
  }
  sheet.setFrozenRows(1);

  return records.length;
}

function readLogRecords_(monthKey) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(logSheetName_(monthKey));
  if (!sheet) return [];
  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];

  // Read by the header row actually present rather than assuming LOG_HEADERS'
  // order, so this can't quietly misread a tab whose columns have been
  // reordered or that predates a column being added.
  var headerRow = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  var values = sheet.getRange(2, 1, lastRow - 1, lastColumn).getValues();
  return values.map(function (row) {
    var record = {};
    headerRow.forEach(function (key, index) {
      if (key) record[String(key)] = row[index];
    });
    // Sheets may hand a date or time column back as a Date object rather than
    // the string that was written. Normalising here means every comparison,
    // sort and lookup downstream works on one consistent form -- otherwise a
    // re-scan would fail to recognise its own previously-written rows, and the
    // payroll notes would print raw Date objects.
    record.shift_date = normalizeDateValue_(record.shift_date);
    record.official_time_in = normalizeTimeValue_(record.official_time_in);
    record.official_time_out = normalizeTimeValue_(record.official_time_out);
    CLOCK_PUNCH_COLUMNS.forEach(function (name) {
      record[name] = normalizeClockPunchValue_(record[name], record.shift_date);
    });
    return record;
  });
}

function isDateLike_(value) {
  // Duck-typed rather than `instanceof Date`: instanceof compares against one
  // specific realm's Date constructor and quietly returns false for a Date
  // that came from anywhere else, which would send the value down the
  // String() path and produce "Mon Jul 27 2026 00:00:00 GMT..." instead.
  return Boolean(value) && typeof value.getTime === 'function';
}

function normalizeDateValue_(value) {
  if (isDateLike_(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return value === null || value === undefined ? '' : String(value);
}

// Sheets recognises "2:13pm" as a time and stores it as a fraction of a day,
// handing it back as a Date on its time epoch (1899-12-30). Left alone that
// surfaces in a payroll note as "Sat Dec 30 1899 14:13:00 GMT-0800 (Pacific
// Standard Time)". Reading it back through here restores the 12-hour form.
// (Newly written rows also get a plain-text column format so the coercion
// stops happening in the first place -- this covers rows already in the sheet.)
function normalizeTimeValue_(value) {
  if (isDateLike_(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'h:mma').toLowerCase();
  }
  return value === null || value === undefined ? '' : String(value);
}

// The scanner drops a clock punch's leading date when it matches the shift's own
// date, since shift_date already says it -- but keeps it when it differs, which
// is how an overnight shift's clock-out stays visibly on the next day. Rows
// already in the sheet may predate that, and Sheets may hand one back as a Date,
// so the same rule is applied on the way in. Sharing one rule means a re-scan's
// merge can't quietly reformat a field it never actually read.
function stripRedundantDatePrefix_(value, isoDate) {
  var match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(.+)$/.exec(String(value).trim());
  if (!match || !isoDate) return String(value);
  var pad = function (part) { return part.length === 1 ? '0' + part : part; };
  var asIso = match[3] + '-' + pad(match[1]) + '-' + pad(match[2]);
  return asIso === String(isoDate) ? match[4] : String(value);
}

// A time with no date is stored on Sheets' own time epoch, 1899-12-30. That
// date is Sheets bookkeeping rather than anything observed in WellSky, so it
// must never reach a cell -- left in, it produces the "Sat Dec 30 1899" strings
// that used to show up in payroll notes.
var SHEETS_TIME_EPOCH_PREFIX = '12/30/1899 ';

function normalizeClockPunchValue_(value, isoDate) {
  if (isDateLike_(value)) {
    var formatted = Utilities.formatDate(
      value, Session.getScriptTimeZone(), 'MM/dd/yyyy hh:mm:ss a');
    value = formatted.indexOf(SHEETS_TIME_EPOCH_PREFIX) === 0
      ? formatted.slice(SHEETS_TIME_EPOCH_PREFIX.length)
      : formatted;
  }
  if (value === null || value === undefined) return '';
  return stripRedundantDatePrefix_(String(value), isoDate);
}

// "2026-07-29" -> "07/29/2026"
function formatMmDdYyyy_(isoDate) {
  var parts = String(isoDate).split('-');
  if (parts.length !== 3) return String(isoDate);
  return parts[1] + '/' + parts[2] + '/' + parts[0];
}

// WellSky pads every activity note with a bookkeeping parenthetical -- e.g.
// "(Added to shift that Occurs once on 07/27/2026 from 06:00 AM PDT to 08:00 AM
// PDT for Samson Pallapati; assigned to caregiver Natalia Williams)" -- often
// twice, once before the note text and once after. It repeats the shift, client
// and caregiver the payroll cell already identifies, so it's stripped out here
// and only the human-written part is kept. The full untouched note stays in the
// Log tab's `note` column for anyone who needs it.
function cleanActivityNote_(note) {
  if (note === null || note === undefined) return '';
  var text = String(note).trim();
  if (text === '' || text === '-') return '';
  text = text.replace(/\(\s*Added to shift[^)]*\)/gi, ' ');
  return text.replace(/\s+/g, ' ').trim();
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
    var date = normalizeDateValue_(record.shift_date);
    if (!caregiver || !date) return;

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

    var timeRangeKey = String(record.official_time_in) + '|' + String(record.official_time_out);
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
      // Per shift: date and client, then the hours, then its activity note if
      // it has one -- hours first, note last:
      //   07/27/2026 (Kozuka-Ssenyan, Mia)
      //   9:00am - 4:00pm = 7h
      //   -----------------------------
      //   Activity Note: On a vacation with their father, July 22-31
      // Same shape whatever the status; the cell's own color already says
      // which shifts need follow-up, so the note doesn't repeat it.
      var block =
        formatMmDdYyyy_(date) + ' (' + (record.client_name || 'unknown client') + ')\n' +
        normalizeTimeValue_(record.official_time_in || '?') + ' - ' +
        normalizeTimeValue_(record.official_time_out || '?') +
        ' = ' + formatHoursMinutes_(noteMinutes);

      var activityNote = cleanActivityNote_(record.note);
      if (activityNote) {
        block += '\n' + NOTE_SEPARATOR + '\nActivity Note: ' + activityNote;
      }

      cell.noteLines.push(block);
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
  // clear() drops values and formatting but leaves cell notes behind, which
  // would strand an old hours breakdown on a cell whose data has since
  // changed -- so notes are cleared explicitly. The whole tab is rebuilt from
  // the Log tab each time, so its date/weekday header rows are always
  // rewritten fresh and can't drift or go missing.
  sheet.clear();
  sheet.clearNotes();

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
      // Blank line between shifts: each entry is already two lines, so without
      // the gap a caregiver with two clients reads as one four-line blur.
      rowNotes.push(cell.noteLines.join('\n\n'));
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

function jsonOutput_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// Open the Web App URL in a browser to see which version is actually live.
// A published Web App keeps serving the last DEPLOYED version, so editing and
// saving the script changes nothing until a new deployment version is
// published -- this makes that difference visible instead of leaving you to
// infer it from missing tabs.
function doGet() {
  return jsonOutput_({
    ok: true,
    script_version: SCRIPT_VERSION,
    log_headers: LOG_HEADERS,
    message: 'THC WellSky Shift Log — Apps Script is deployed and reachable.'
  });
}

function doPost(e) {
  var records = JSON.parse(e.postData.contents);
  if (!Array.isArray(records)) records = records.records || [];

  // Group by month so a scan spanning a month boundary files each row in the
  // right pair of tabs.
  var byMonth = {};
  var undated = 0;
  records.forEach(function (record) {
    var monthKey = monthKeyOf_(record.shift_date);
    if (!monthKey) {
      undated++;
      return;
    }
    if (!byMonth[monthKey]) byMonth[monthKey] = [];
    byMonth[monthKey].push(record);
  });

  var written = 0;
  var monthsTouched = [];
  Object.keys(byMonth).sort().forEach(function (monthKey) {
    // Before anything is written: adopt a tab left over from the old
    // "2026-07 Log" naming, so previously-scanned rows carry over instead of
    // being stranded in an orphaned tab next to a newly-created one.
    migrateLegacyTabNames_(monthKey);
    written += upsertLogRows_(monthKey, byMonth[monthKey]);
    rebuildPayrollSheet_(monthKey);
    monthsTouched.push(monthLabelOf_(monthKey));
  });

  return jsonOutput_({
    ok: true,
    script_version: SCRIPT_VERSION,
    written: written,
    // Surfaced rather than silently swallowed: a record with no parseable
    // shift_date has no month to file under, so it is not written anywhere.
    skipped_undated: undated,
    months: monthsTouched
  });
}
