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
        <label>Official</label>
        <label>Bill Hours</label>
        <label>Pay Hours</label>
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
        <label>Official</label>
        <label>Bill Hours</label>
        <label>Pay Hours</label>
      </div>
    </div>
  `;

  const result = run(html);
  const match = result.matches.find((m) => m.matchedAs === 'edit-care-log');
  assert.ok(match);
  assert.doesNotMatch(match.outerHTML, /outer-wrapper/);
});

test('reports foundAny false when neither popup is open', () => {
  const result = run('<div>Just the regular schedule page, nothing open.</div>');

  assert.equal(result.foundAny, false);
  assert.deepEqual(result.matches, []);
});
