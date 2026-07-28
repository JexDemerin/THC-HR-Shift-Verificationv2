// Apps Script Web App bound to the destination Google Sheet.
// Deploy: Extensions -> Apps Script -> paste this in -> Deploy -> New deployment -> Web app.

var LOG_SHEET_NAME = 'ScreenBot Log';

var HEADERS = [
  'Date', 'Caregiver', 'Client', 'Status',
  'Official Start', 'Official End',
  'Actual Clock-In', 'Scheduled Clock-In',
  'Actual Clock-Out', 'Scheduled Clock-Out',
  'Bill Hours', 'Pay Hours'
];

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

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var rows = body.rows || [];
  var sheet = getOrCreateLogSheet_();

  rows.forEach(function (row) {
    sheet.appendRow([
      row.date || '',
      row.caregiver_name || '',
      row.client_name || '',
      row.status || '',
      row.official_start || '',
      row.official_end || '',
      row.actual_clock_in || '',
      row.scheduled_clock_in || '',
      row.actual_clock_out || '',
      row.scheduled_clock_out || '',
      row.bill_hours || '',
      row.pay_hours || ''
    ]);
  });

  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', rows_written: rows.length }))
    .setMimeType(ContentService.MimeType.JSON);
}
