const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'inspect-shift-click-script.js'),
  'utf8'
);

async function run(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    pretendToBeVisual: true,
    runScripts: 'dangerously',
  });
  global.document = dom.window.document;
  global.window = dom.window;
  global.MouseEvent = dom.window.MouseEvent;
  global.KeyboardEvent = dom.window.KeyboardEvent;
  try {
    // eslint-disable-next-line no-eval
    return await eval(SOURCE);
  } finally {
    delete global.document;
    delete global.window;
    delete global.MouseEvent;
    delete global.KeyboardEvent;
  }
}

test('reports not found when no completed shift is visible', async () => {
  const result = await run('<div>nothing here</div>');

  assert.equal(result.found, false);
  assert.match(result.reason, /No completed/);
});

test('tries every candidate click target and reports what each one does', async () => {
  const html = `
    <table>
      <tr class="sched_row">
        <td class="day-data">
          <div id="shift-el" class="_event COMPLETED ajSet">
            <div class="title"><span class="name">Kozuka-Ssenyan, Mia</span><span class="time">1p-4p</span></div>
          </div>
        </td>
      </tr>
    </table>
    <script>
      // Only the .title element actually opens anything, in this fixture.
      document.querySelector('#shift-el .title').addEventListener('click', function () {
        var popup = document.createElement('div');
        popup.className = 'test-popup';
        popup.textContent = 'A popup opened';
        document.body.appendChild(popup);
      });
    </script>
  `;

  const result = await run(html);

  assert.equal(result.found, true);
  assert.match(result.shiftOuterHTML, /Kozuka-Ssenyan, Mia/);

  const byLabel = Object.fromEntries(result.results.map((r) => [r.label, r]));
  // Events bubble UP from a child to its ancestors, never down -- clicking
  // the parent wrapper does not trigger a listener bound to its .title child.
  assert.equal(byLabel['whole ._event wrapper'].newElementsCount, 0);
  assert.equal(byLabel['.title'].newElementsCount, 1);
  assert.equal(byLabel['.title .name'].newElementsCount, 1); // bubbles up to .title
  assert.equal(byLabel['.time'].tried, true);
  assert.equal(byLabel['.time'].newElementsCount, 1); // also nested inside .title, so it bubbles up too
});

test('also catches a pre-rendered hidden element becoming visible instead of a new element', async () => {
  const html = `
    <table>
      <tr class="sched_row">
        <td class="day-data">
          <div id="shift-el" class="_event COMPLETED ajSet">
            <div class="title"><span class="name">Someone</span></div>
          </div>
        </td>
      </tr>
    </table>
    <div id="hidden-modal" style="display: none;">Care Log Summary</div>
    <script>
      document.getElementById('shift-el').addEventListener('click', function () {
        document.getElementById('hidden-modal').setAttribute('style', 'display: block;');
      });
    </script>
  `;

  const result = await run(html);

  const wrapperResult = result.results.find((r) => r.label === 'whole ._event wrapper');
  assert.equal(wrapperResult.newlyVisibleCount, 1);
  assert.match(wrapperResult.newlyVisibleSnippets[0], /Care Log Summary/);
});
