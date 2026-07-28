const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'inspect-care-log-script.js'),
  'utf8'
);

function run(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  global.document = dom.window.document;
  global.window = dom.window;
  try {
    // eslint-disable-next-line no-eval
    return eval(SOURCE);
  } finally {
    delete global.document;
    delete global.window;
  }
}

test('captures the Edit Care Log dialog when its distinctive fields are present', () => {
  const html = `
    <div id="app">
      <div class="modal edit-care-log-dialog">
        <label>Status</label>
        <label>Official</label>
        <label>Bill Hours</label>
        <label>Pay Hours</label>
        <label>Client</label>
        <label>Caregiver</label>
      </div>
    </div>
  `;

  const result = run(html);

  assert.equal(result.foundAny, true);
  const match = result.matches.find((m) => m.matchedAs === 'edit-care-log');
  assert.ok(match, 'expected an edit-care-log match');
  assert.match(match.outerHTML, /edit-care-log-dialog/);
});

test('captures the smallest matching container, not an ancestor', () => {
  const html = `
    <div class="outer-wrapper">
      <div class="modal">
        <label>Status</label>
        <label>Official</label>
        <label>Bill Hours</label>
        <label>Pay Hours</label>
        <label>Client</label>
        <label>Caregiver</label>
      </div>
    </div>
  `;

  const result = run(html);
  const match = result.matches.find((m) => m.matchedAs === 'edit-care-log');
  assert.ok(match);
  assert.doesNotMatch(match.outerHTML, /outer-wrapper/);
});

test('matches the whole dialog, not the nested Bill/Pay Hours automation sub-widget', () => {
  // Regression test for a real capture: the Bill Hours/Pay Hours widget has
  // its own "Official"/"Bill Hours"/"Pay Hours" text (each with an
  // Actual|Scheduled|Official toggle), which alone used to satisfy the old,
  // narrower signal -- so "smallest matching container" grabbed that
  // sub-widget instead of the dialog that also has Status/Client/Caregiver.
  const html = `
    <div class="edit-care-log-dialog">
      <label>Status:</label>
      <select><option>Complete</option></select>
      <label>Client</label>
      <label>Caregiver</label>
      <div class="bill-pay-automation">
        <div class="hour-override">
          <label>Bill Hours:</label>
          <div class="quick-times">Set to: <a class="actual">Actual</a> | <a class="scheduled">Scheduled</a> | <a class="selected">Official</a></div>
        </div>
        <div class="hour-override">
          <label>Pay Hours:</label>
          <div class="quick-times">Set to: <a class="actual">Actual</a> | <a class="scheduled">Scheduled</a> | <a class="selected">Official</a></div>
        </div>
      </div>
    </div>
  `;

  const result = run(html);
  const match = result.matches.find((m) => m.matchedAs === 'edit-care-log');

  assert.ok(match);
  assert.match(match.outerHTML, /edit-care-log-dialog/);
  assert.match(match.outerHTML, /Caregiver/);
});

test('reports foundAny false when neither popup is open', () => {
  const result = run('<div>Just the regular schedule page, nothing open.</div>');

  assert.equal(result.foundAny, false);
  assert.deepEqual(result.matches, []);
});
