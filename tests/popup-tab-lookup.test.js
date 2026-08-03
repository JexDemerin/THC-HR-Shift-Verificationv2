const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const EXTENSION_DIR = path.join(__dirname, '..', 'extension');
const POPUP_HTML = fs.readFileSync(path.join(EXTENSION_DIR, 'popup.html'), 'utf8');
const POPUP_SOURCE = fs.readFileSync(path.join(EXTENSION_DIR, 'popup.js'), 'utf8');

// popup.js wires up its buttons and reads chrome.storage the moment it loads,
// so it can only be exercised against the real popup.html and a stubbed
// `chrome`. Worth the setup: which tab the panel injects into is the difference
// between a scan working and a scan reporting a failure about the wrong page.
function loadPopup({ tabs = [] } = {}) {
  // 'outside-only' gives window.eval the window's own globals (document, etc.)
  // without letting popup.html's own <script src> tag fetch and run a second
  // copy of popup.js.
  const dom = new JSDOM(POPUP_HTML, {
    url: 'chrome-extension://abc/popup.html?panel=1',
    runScripts: 'outside-only',
  });
  const queries = [];

  const chrome = {
    tabs: {
      query: async (info) => {
        queries.push(info);
        let found = tabs;
        // Chrome's {active: true} returns only the FRONT tab of each window --
        // modelling that is the entire point of this double. A stub that
        // ignored it would let the old lookup pass the very test written to
        // reproduce the bug.
        if (info.active === true) found = found.filter((t) => t.active);
        if (info.url) {
          // Close enough to Chrome's match-pattern filtering for the single
          // pattern this extension uses.
          const pattern = new RegExp(
            '^' + info.url.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'
          );
          found = found.filter((t) => pattern.test(t.url || ''));
        }
        return found;
      },
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
    scripting: { executeScript: async () => [{ result: null }] },
    runtime: { sendMessage: async () => ({ ok: true }) },
  };

  dom.window.chrome = chrome;
  const sandboxSource = `${POPUP_SOURCE}\n;window.__findWellSkyTab = findWellSkyTab;` +
    `\nwindow.__NO_WELLSKY_TAB = NO_WELLSKY_TAB;` +
    `\nwindow.__versionMismatchReport = versionMismatchReport;`;
  dom.window.eval(sandboxSource);
  return { dom, window: dom.window, queries };
}

test('finds the WellSky tab even when it is not the tab in front', async () => {
  // The exact situation from a real run: the Care Log export opened in front,
  // pushing the WellSky tab into the background of the same window. The old
  // {active: true} lookup could not see it, injected the scanner into the
  // export viewer instead, and reported "Could not read the schedule from this
  // page" about a page that never had one.
  const { window } = loadPopup({
    tabs: [
      { id: 1, active: true, url: 'blob:chrome-untrusted://export.json', lastAccessed: 200 },
      {
        id: 2,
        active: false,
        url: 'https://togetherhomecare.clearcareonline.com/dashboard/live/weekly/caregivers/',
        lastAccessed: 100,
      },
    ],
  });

  const tab = await window.__findWellSkyTab();

  assert.equal(tab.id, 2, 'the backgrounded WellSky tab is the one to inject into');
});

test('never falls back to an unrelated tab when no WellSky tab is open', async () => {
  // Injecting into whatever happened to be in front can only produce a
  // confusing failure about the wrong page -- so this reports nothing found and
  // lets the caller name the tab that is actually missing.
  const { window } = loadPopup({
    tabs: [{ id: 1, active: true, url: 'https://mail.google.com/', lastAccessed: 200 }],
  });

  assert.equal(await window.__findWellSkyTab(), null);
  assert.match(window.__NO_WELLSKY_TAB, /No WellSky tab found/);
});

test('prefers the focused WellSky tab when several are open', async () => {
  const { window } = loadPopup({
    tabs: [
      { id: 1, active: false, url: 'https://x.clearcareonline.com/a', lastAccessed: 300 },
      { id: 2, active: true, url: 'https://x.clearcareonline.com/b', lastAccessed: 100 },
    ],
  });

  assert.equal((await window.__findWellSkyTab()).id, 2);
});

test('falls back to the most recently used WellSky tab when none is focused', async () => {
  const { window } = loadPopup({
    tabs: [
      { id: 1, active: false, url: 'https://x.clearcareonline.com/a', lastAccessed: 100 },
      { id: 2, active: false, url: 'https://x.clearcareonline.com/b', lastAccessed: 300 },
    ],
  });

  assert.equal((await window.__findWellSkyTab()).id, 2);
});

test('the tab query is filtered by URL, not by which tab is active', async () => {
  // The distinction that caused the bug, pinned directly: a query for the
  // active tab cannot see a backgrounded one, however the results are filtered
  // afterwards.
  const { window, queries } = loadPopup({
    tabs: [{ id: 1, active: true, url: 'https://x.clearcareonline.com/a', lastAccessed: 1 }],
  });
  await window.__findWellSkyTab();

  assert.equal(queries.length, 1);
  assert.equal(queries[0].url, 'https://*.clearcareonline.com/*');
  assert.equal(queries[0].active, undefined, 'must not narrow to the active tab');
});

test('only matches clearcareonline over https, not a lookalike host', async () => {
  const { window } = loadPopup({
    tabs: [
      { id: 1, active: true, url: 'https://clearcareonline.com.evil.test/x', lastAccessed: 300 },
      { id: 2, active: false, url: 'http://x.clearcareonline.com/insecure', lastAccessed: 200 },
    ],
  });

  assert.equal(await window.__findWellSkyTab(), null);
});

test('a stale Sheet is told to re-deploy Code.gs', async () => {
  const { window } = loadPopup();
  const report = window.__versionMismatchReport(11, 12);

  assert.match(report.status, /OLD Code\.gs/);
  assert.match(report.lines.join(' '), /New version/);
  assert.match(report.lines.join(' '), /script_version 12/, 'names the version to deploy to');
});

test('a Sheet with no version at all is treated as stale', async () => {
  const { window } = loadPopup();
  const report = window.__versionMismatchReport(undefined, 12);

  assert.match(report.status, /OLD Code\.gs/);
  assert.match(report.lines.join(' '), /New version/);
});

test('a NEWER Sheet is told to reload the extension, never to downgrade', async () => {
  // The direction that used to give destructive advice: Code.gs re-deployed but
  // the extension not yet reloaded. The old message said to re-deploy until the
  // Sheet reported the OLDER number, which means pasting an old Code.gs over a
  // newer one and silently removing whatever it added.
  const { window } = loadPopup();
  const report = window.__versionMismatchReport(12, 11);
  const text = report.lines.join(' ');

  assert.match(text, /reload the EXTENSION/);
  assert.match(text, /Do NOT re-deploy/);
  assert.doesNotMatch(text, /New version/, 'must not walk them into a downgrade');
  assert.doesNotMatch(text, /script_version 11/, 'must not name the older version as the target');
});

test('a newer Sheet does not claim the rows were lost', async () => {
  // The records are posted before the version check runs, and a newer Code.gs
  // understands everything an older extension sends -- so "nothing was written"
  // would send someone hunting for data that is already in the Sheet.
  const { window } = loadPopup();
  const report = window.__versionMismatchReport(12, 11);

  assert.doesNotMatch(report.status, /nothing was written/);
  assert.match(report.lines.join(' '), /rows were still written/);
});
