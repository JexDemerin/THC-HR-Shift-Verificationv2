const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'inspect-care-log-as-is-script.js'),
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

test('captures the dialog as-is, with no hover simulated', () => {
  const html = `
    <div class="edit-care-log-dialog">
      <label>Status</label>
      <label>Official</label>
      <label>Bill Hours</label>
      <label>Pay Hours</label>
      <label>Client</label>
      <label>Caregiver</label>
      <a class="actual_start" title="07/27/2026 01:35:33 PM">Actual</a>
    </div>
  `;

  const result = run(html);

  assert.equal(result.foundAny, true);
  assert.equal(result.hoverTargetsTriggered, 0);
  const match = result.matches.find((m) => m.matchedAs === 'edit-care-log');
  // Whatever title is already on the page (e.g. from a real physical hover
  // moments before this ran) passes through untouched -- nothing simulated.
  assert.match(match.outerHTML, /title="07\/27\/2026 01:35:33 PM"/);
});

test('reports foundAny false when neither popup is open', () => {
  const result = run('<div>Just the regular schedule page, nothing open.</div>');

  assert.equal(result.foundAny, false);
  assert.deepEqual(result.matches, []);
});
