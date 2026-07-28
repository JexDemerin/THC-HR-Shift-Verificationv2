// Apps Script Web App bound to the destination Google Sheet.
// Deploy: Extensions -> Apps Script -> paste this in -> Deploy -> New deployment -> Web app.
//
// Receives the array of shift records the extension's background.js posts
// (see extension/background.js -- body is `JSON.stringify(records)`, a bare
// array, not wrapped in an object) and mirrors them into a dedicated tab,
// one row per shift. Re-posting the same event_id updates its existing row
// instead of creating a duplicate, so re-scanning the same view is safe.

var LOG_SHEET_NAME = 'Shift Log';

var HEADERS = [
  'caregiver_name', 'client_name', 'shift_date',
  'actual_time_in', 'scheduled_time_in',
  'actual_time_out', 'scheduled_time_out',
  'status', 'status_raw', 'event_id', 'scanned_at'
];

var EVENT_ID_COL = HEADERS.indexOf('event_id') + 1; // 1-based sheet column

function getOrCreateLogSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function rowValues_(record) {
  return HEADERS.map(function (key) {
    return record[key] || '';
  });
}

function findRowByEventId_(sheet, eventId) {
  if (!eventId) return -1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;
  var ids = sheet.getRange(2, EVENT_ID_COL, lastRow - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === eventId) return i + 2; // +2: 1-based, plus header row
  }
  return -1;
}

function doPost(e) {
  var records = JSON.parse(e.postData.contents);
  if (!Array.isArray(records)) records = records.records || [];

  var sheet = getOrCreateLogSheet_();
  var written = 0;

  records.forEach(function (record) {
    var values = rowValues_(record);
    var existingRow = findRowByEventId_(sheet, record.event_id);
    if (existingRow > 0) {
      sheet.getRange(existingRow, 1, 1, HEADERS.length).setValues([values]);
    } else {
      sheet.appendRow(values);
    }
    written++;
  });

  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, written: written }))
    .setMimeType(ContentService.MimeType.JSON);
}
