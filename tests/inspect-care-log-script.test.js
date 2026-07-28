const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'inspect-care-log-script.js'),
  'utf8'
);

async function run(bodyHtml, { runScripts = false } = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    pretendToBeVisual: true, // jsdom needs this for MouseEvent dispatch/timers to behave
    runScripts: runScripts ? 'dangerously' : undefined, // only for our own trusted test fixtures
  });
  global.document = dom.window.document;
  global.window = dom.window;
  global.MouseEvent = dom.window.MouseEvent;
  // Deliberately NOT overriding global.setTimeout to jsdom's version --
  // the evaluated script's plain `setTimeout(...)` call already resolves to
  // Node's own global setTimeout, which is all `sleep()` needs.
  try {
    // eslint-disable-next-line no-eval
    return await eval(SOURCE);
  } finally {
    delete global.document;
    delete global.window;
    delete global.MouseEvent;
  }
}

test('captures the Edit Care Log dialog when its distinctive fields are present', async () => {
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

  const result = await run(html);

  assert.equal(result.foundAny, true);
  const match = result.matches.find((m) => m.matchedAs === 'edit-care-log');
  assert.ok(match, 'expected an edit-care-log match');
  assert.match(match.outerHTML, /edit-care-log-dialog/);
});

test('captures the smallest matching container, not an ancestor', async () => {
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

  const result = await run(html);
  const match = result.matches.find((m) => m.matchedAs === 'edit-care-log');
  assert.ok(match);
  assert.doesNotMatch(match.outerHTML, /outer-wrapper/);
});

test('matches the whole dialog, not the nested Bill/Pay Hours automation sub-widget', async () => {
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

  const result = await run(html);
  const match = result.matches.find((m) => m.matchedAs === 'edit-care-log');

  assert.ok(match);
  assert.match(match.outerHTML, /edit-care-log-dialog/);
  assert.match(match.outerHTML, /Caregiver/);
});

test('reports foundAny false when neither popup is open', async () => {
  const result = await run('<div>Just the regular schedule page, nothing open.</div>');

  assert.equal(result.foundAny, false);
  assert.deepEqual(result.matches, []);
});

test('simulates a hover on every Actual/Scheduled link and re-captures afterward', async () => {
  // A stand-in for whatever WellSky's real handler does: fill in the title
  // attribute once hovered. This checks the *mechanism* (dispatching a
  // synthetic hover actually reaches a real mouseenter listener, no physical
  // mouse needed) -- not WellSky's specific real implementation, which is
  // still unknown until a real capture confirms it.
  const html = `
    <div class="edit-care-log-dialog">
      <label>Status:</label>
      <label>Client</label>
      <label>Caregiver</label>
      <label>Official</label>
      <label>Bill Hours</label>
      <label>Pay Hours</label>
      <a id="actual-link" title="">Actual</a>
      <a id="scheduled-link" title="">Scheduled</a>
      <script>
        document.getElementById('actual-link').addEventListener('mouseenter', function (e) {
          e.target.setAttribute('title', '07/27/2026 01:35:33 PM');
        });
        document.getElementById('scheduled-link').addEventListener('mouseenter', function (e) {
          e.target.setAttribute('title', '07/27/2026 09:00:00 AM');
        });
      </script>
    </div>
  `;

  const result = await run(html, { runScripts: true });

  assert.equal(result.hoverTargetsTriggered, 2);
  const match = result.matches.find((m) => m.matchedAs === 'edit-care-log');
  assert.match(match.outerHTML, /title="07\/27\/2026 01:35:33 PM"/);
  assert.match(match.outerHTML, /title="07\/27\/2026 09:00:00 AM"/);
});

test('also captures floating tooltip-like elements appended anywhere on the page', async () => {
  const html = `
    <div class="edit-care-log-dialog">
      <label>Status</label>
      <label>Official</label>
      <label>Bill Hours</label>
      <label>Pay Hours</label>
      <label>Client</label>
      <label>Caregiver</label>
    </div>
    <div class="floating-tooltip" role="tooltip" style="position: absolute;">07/27/2026 01:35:33 PM</div>
  `;

  const result = await run(html);

  assert.equal(result.floatingTooltips.length, 1);
  assert.match(result.floatingTooltips[0], /01:35:33 PM/);
});
