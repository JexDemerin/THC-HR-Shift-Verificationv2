// Must match SCRIPT_VERSION in apps_script/Code.gs. Bumped together whenever
// the Sheet-side script changes in a way this extension depends on, so a
// stale deployment is reported loudly instead of silently doing the wrong
// thing (or nothing).
const EXPECTED_SCRIPT_VERSION = 12;

const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const exportBtn = document.getElementById('exportBtn');
const scanBtn = document.getElementById('scanBtn');
const inspectClickBtn = document.getElementById('inspectClickBtn');
const closeBtn = document.getElementById('closeBtn');
const webhookInput = document.getElementById('webhookUrl');
const saveWebhookBtn = document.getElementById('saveWebhookBtn');
const settingsEl = document.getElementById('settings');
const settingsBtn = document.getElementById('settingsBtn');

// This page runs in Chrome's side panel (or, on Chrome older than 114, a
// standalone window) -- never as the action popup Chrome would close the
// instant it lost focus. That mattered for more than convenience: the scan is
// driven from here, so a popup closing mid-scan took the pending results with
// it and nothing reached the Sheet. Because the panel stays put, the log simply
// stays on screen -- no persisting it across closes, and nothing to clear.
const IS_SIDE_PANEL = new URLSearchParams(window.location.search).get('panel') === '1';

function setStatus(text) {
  statusEl.textContent = text;
}

function addLogEntry(text) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = text;
  logEl.prepend(entry);
}

// Each run shows only its own output, so the panel doesn't grow without bound
// and bury the lines that matter.
function startNewRunLog() {
  logEl.textContent = '';
}

const WELLSKY_URL_MATCH = 'https://*.clearcareonline.com/*';

// Finds the WellSky tab wherever it is -- deliberately NOT "the active tab".
//
// chrome.tabs.query({active: true}) only ever returns the FRONT tab of each
// window, so the moment anything else takes focus in the same window the
// WellSky tab stops being a candidate. Downloading the Care Log export does
// exactly that: the export opens in front, and the old code then fell through
// to `candidates[0]` -- the export viewer itself -- injected the scanner into
// it, found no schedule there, and reported "Could not read the schedule from
// this page." The WellSky tab had been open the whole time, one tab over.
//
// Matching on the URL finds it whether it's focused, backgrounded, or in
// another window. Returning null when there genuinely isn't one is the other
// half of the fix: injecting into some unrelated page can only produce a
// confusing failure, so it's better to name the tab that's missing.
async function findWellSkyTab() {
  const tabs = await chrome.tabs.query({ url: WELLSKY_URL_MATCH });
  if (!tabs.length) return null;
  // With several WellSky tabs open, prefer the one being worked in: front-most
  // in its window, else the most recently looked at.
  return (
    tabs.find((t) => t.active) ||
    tabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0]
  );
}

const NO_WELLSKY_TAB =
  'No WellSky tab found. Open the WellSky schedule in a tab and try again — it ' +
  'can stay in the background, it does not have to be the tab in front.';

// Chrome unloads background tabs to reclaim memory (Memory Saver). A discarded
// tab keeps its title and URL in the tab strip -- and in chrome.tabs.query --
// but its document is gone, so injecting into one finds an empty page and reads
// no schedule. Only reachable since the lookup started matching backgrounded
// tabs by URL, so it has to be checked for by name rather than left to surface
// as a mystery empty result.
function tabNotReadyReason(tab) {
  if (tab.discarded) {
    return (
      'The WellSky tab is asleep — Chrome unloaded it to save memory, so there is ' +
      'no page there to read. Click that tab once to wake it, wait for the ' +
      'schedule to appear, then scan again.'
    );
  }
  if (tab.status === 'loading') {
    return 'The WellSky tab is still loading. Wait for the schedule to finish appearing, then scan again.';
  }
  return null;
}

// A version mismatch has TWO directions, and they need opposite fixes.
//
// This used to assume one: that the Sheet was always the stale side. When the
// Sheet was actually NEWER -- Code.gs re-deployed but the extension not yet
// reloaded -- the panel told the user to re-deploy Code.gs until it reported the
// OLDER version number. Following that means pasting an old Code.gs over a newer
// one, which silently removes whatever the newer version added. Advice that
// destroys work is worse than no advice.
//
// It also claimed "nothing was written properly" in both directions. The records
// are posted BEFORE this check runs, so the write already happened; and a newer
// Sheet understands everything an older extension sends, so those rows are fine.
function versionMismatchReport(found, expected) {
  if (found === undefined) {
    return {
      status: 'sheet is running OLD Code.gs, monthly tabs will not appear.',
      lines: [
        'The Sheet is running an older version that does not report one, but this ' +
          `extension needs version ${expected}.`,
        REDEPLOY_INSTRUCTIONS(expected),
      ],
    };
  }
  if (found < expected) {
    return {
      status: 'sheet is running OLD Code.gs, monthly tabs will not appear.',
      lines: [
        `The Sheet is running version ${found}, but this extension needs version ${expected}. ` +
          'Monthly tabs will NOT appear until it is updated.',
        REDEPLOY_INSTRUCTIONS(expected),
      ],
    };
  }
  return {
    status: 'written, but this extension is out of date — reload it.',
    lines: [
      `The Sheet is running version ${found}, which is NEWER than this extension's ${expected}. ` +
        'Your rows were still written — a newer Code.gs understands everything an older ' +
        'extension sends.',
      'Fix: reload the EXTENSION, not the Sheet — chrome://extensions, then the reload ' +
        'arrow on this extension. Do NOT re-deploy Code.gs to match; that would replace ' +
        'your current script with an older one and remove whatever it added.',
    ],
  };
}

function REDEPLOY_INSTRUCTIONS(expected) {
  return (
    'Fix: open the Sheet -> Extensions -> Apps Script, replace all the code with ' +
    'apps_script/Code.gs, Save, then Deploy -> Manage deployments -> pencil icon -> ' +
    'Version: "New version" -> Deploy. Do NOT create a separate new deployment, that ' +
    'makes a different URL. To check what is live, open your Web App URL in a browser: ' +
    `it should show script_version ${expected}.`
  );
}

// Which page a scan actually ran against. Worth showing on every failure: the
// panel picks the tab on its own, so without this a failure gives no way to
// tell "wrong page" from "right page, real bug".
function describeTab(tab) {
  let path = tab.url || '(unknown URL)';
  try {
    path = new URL(tab.url).pathname;
  } catch (err) {
    // Keep the raw URL -- a malformed one is itself worth seeing.
  }
  return path;
}

// ---- Export Care Log HTML (Phase 0 discovery tool) ----

function buildExportDocument(result) {
  const header =
    `<!--\n` +
    `WellSky Care Log Raw HTML Export (Phase 0 — DOM discovery)\n` +
    `Page URL: ${result.pageUrl}\n` +
    `Page title: ${result.pageTitle}\n` +
    `Captured at: ${result.capturedAt}\n` +
    `Matches found: ${result.matches.map((m) => m.matchedAs).join(', ') || 'none'}\n` +
    `Actual/Scheduled links probed (hovered one at a time): ${result.hoverTargetsTriggered}\n` +
    `jQuery detected on page: ${result.jQueryDetected}\n` +
    `-->\n`;
  const body = result.matches
    .map((m) => `<!-- ===== matched as: ${m.matchedAs} ===== -->\n${m.outerHTML}\n`)
    .join('\n');
  const probes = buildProbeReport(result.hoverProbes);
  return header + body + probes;
}

function buildProbeReport(hoverProbes) {
  if (!hoverProbes || hoverProbes.length === 0) return '';

  const sections = hoverProbes.map((probe, i) => {
    const attrLines = Object.entries(probe.changedAttributes || {})
      .map(([name, { before, after }]) => `    ${name}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
      .join('\n');
    const newElLines = (probe.newElements || []).map((html) => `    ${html}`).join('\n');

    return (
      `<!--\n` +
      `  Link ${i + 1}: class="${probe.linkClass}" text="${probe.linkText}"\n` +
      `  Changed attributes on the link itself after hovering:\n` +
      (attrLines || '    (none)\n') +
      `\n  New elements that appeared anywhere on the page after hovering:\n` +
      (newElLines || '    (none)\n') +
      `\n-->`
    );
  });

  return `\n<!-- ===== per-link hover probe results ===== -->\n${sections.join('\n')}\n`;
}

function downloadHtmlExport(result) {
  const doc = buildExportDocument(result);
  const blob = new Blob([doc], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const safeTimestamp = result.capturedAt.replace(/[:.]/g, '-');
  const filename = `wellsky-care-log-export-${safeTimestamp}.html`;

  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  });
}

async function exportCareLogHtml() {
  exportBtn.disabled = true;
  startNewRunLog();
  setStatus('Reading the WellSky tab...');

  try {
    const tab = await findWellSkyTab();
    if (!tab || !tab.id) {
      setStatus(NO_WELLSKY_TAB);
      return;
    }

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['inspect-care-log-script.js'],
    });

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;
    if (!result || !result.foundAny) {
      setStatus('No open popup matched. Make sure the Edit Care Log (or summary) popup is open, then try again.');
      return;
    }

    downloadHtmlExport(result);

    const sizeKb = Math.round(
      result.matches.reduce((sum, m) => sum + m.byteLength, 0) / 1024
    );
    setStatus(
      `Captured ~${sizeKb} KB (${result.matches.map((m) => m.matchedAs).join(', ')}), ` +
        `hovered ${result.hoverTargetsTriggered} Actual/Scheduled link(s). Downloaded.`
    );
    const changesSeen = (result.hoverProbes || []).filter(
      (p) => Object.keys(p.changedAttributes || {}).length > 0 || (p.newElements || []).length > 0
    ).length;
    addLogEntry(
      `${new Date(result.capturedAt).toLocaleTimeString()} — care log export — ${sizeKb} KB — ` +
        `${result.hoverTargetsTriggered} link(s) probed — ${changesSeen} showed a real change`
    );
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    exportBtn.disabled = false;
  }
}

// ---- Scan Schedule (the real feature) ----

async function scanSchedule() {
  scanBtn.disabled = true;
  startNewRunLog();
  setStatus('Scanning visible schedule...');

  try {
    const tab = await findWellSkyTab();
    if (!tab || !tab.id) {
      setStatus(NO_WELLSKY_TAB);
      return;
    }

    const notReady = tabNotReadyReason(tab);
    if (notReady) {
      setStatus(notReady);
      addLogEntry(`WellSky tab: ${describeTab(tab)} — discarded=${!!tab.discarded} status=${tab.status}`);
      return;
    }

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['scan-script.js'],
    });

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;
    if (!result) {
      setStatus(
        `Scanned ${describeTab(tab)} but got no result back at all. ` +
          'If that is not the weekly schedule page, switch that tab to it and re-scan.'
      );
      return;
    }

    if (result.loggedOut) {
      setStatus(
        'WellSky is logged out — that tab is showing the login page. It signs you ' +
          'out on its own after a while idle. Log back in, bring up the weekly ' +
          'schedule, then scan again.'
      );
      return;
    }

    // The scanner caught something and told us what. Far more useful than the
    // silence a thrown error used to produce.
    if (result.error) {
      setStatus(`The scanner hit an error on ${describeTab(tab)}: ${result.error}`);
      addLogEntry(`Page: ${result.pageUrl}`);
      if (result.stack) addLogEntry(result.stack);
      return;
    }

    const { records, summary } = result;

    if (summary.total === 0) {
      // Zero caregiver rows means the page had no schedule on it at all, which
      // is a different problem from a schedule that happens to be empty -- so
      // name the page in that case rather than asking a question the log
      // already answers.
      setStatus(
        result.rowCount === 0
          ? `No schedule on ${describeTab(tab)} — found 0 caregiver rows. ` +
              'Switch that tab to the weekly schedule view and re-scan.'
          : `No shifts found (checked ${result.rowCount} caregiver rows). Is a schedule visible on screen?`
      );
      return;
    }

    // summary.total counts every row, including the "-" placeholders for
    // caregivers who had no shift -- so report the real shift count separately
    // to avoid implying the schedule held far more shifts than it did.
    const realShifts = summary.total - summary.no_shift;
    const parts = [`${realShifts} shifts, ${summary.no_shift} idle caregiver-days`];
    if (summary.unparsed > 0) parts.push(`${summary.unparsed} unparsed`);
    if (result.skippedTodayOrFuture > 0) parts.push(`${result.skippedTodayOrFuture} skipped (today/future)`);
    if (result.stoppedEarlyReason) parts.push('stopped early, see log');
    setStatus(parts.join(' — '));
    addLogEntry(
      `${new Date(result.scannedAt).toLocaleTimeString()} — scan — ${realShifts} shifts across ` +
        `${(result.columnDates || []).length} day(s), ${result.rowCount} caregiver row(s): ` +
        `${summary.completed} completed, ${summary.incomplete} incomplete, ${summary.upcoming} upcoming, ` +
        `${summary.ongoing} ongoing, ${summary.cancelled} cancelled, ${summary.unparsed} unparsed, ` +
        `${summary.no_shift} idle, ${result.skippedTodayOrFuture} skipped (today/future)`
    );
    if (result.stoppedEarlyReason) {
      addLogEntry(`STOPPED EARLY: ${result.stoppedEarlyReason}`);
    }
    if (result.enrichmentDiagnostics && result.enrichmentDiagnostics.length > 0) {
      addLogEntry(`${result.enrichmentDiagnostics.length} shift(s) had a read issue:`);
      for (const line of result.enrichmentDiagnostics) addLogEntry(`  ${line}`);
    }

    const { webhookUrl } = await chrome.storage.local.get('webhookUrl');
    if (!webhookUrl) {
      addLogEntry('Not sent — no Google Sheet URL saved yet (see Settings below).');
      return;
    }

    setStatus(parts.join(' — ') + ' — sending to sheet...');
    const response = await chrome.runtime.sendMessage({
      type: 'SEND_TO_SHEET',
      webhookUrl,
      records,
    });

    const sheetResult = response && response.result;
    if (response && response.ok && sheetResult && sheetResult.ok) {
      // The deployed Apps Script reports its own version. Anything other than
      // the version this extension expects means the Sheet is running older
      // code -- which is exactly what produces "the monthly Log/Payroll tabs
      // never appeared", since an older script simply doesn't build them.
      // Publishing a NEW DEPLOYMENT VERSION is what updates a live Web App;
      // editing and saving the script does not.
      if (sheetResult.script_version !== EXPECTED_SCRIPT_VERSION) {
        const report = versionMismatchReport(sheetResult.script_version, EXPECTED_SCRIPT_VERSION);
        setStatus(parts.join(' — ') + ' — ' + report.status);
        // The row count regardless of direction: it is the answer to "did my
        // scan actually land?", which is the first thing anyone wants to know.
        addLogEntry(`Sheet reported ${sheetResult.written} row(s) written/updated.`);
        for (const line of report.lines) addLogEntry(line);
      } else {
        setStatus(parts.join(' — ') + ` — sent to sheet (${sheetResult.written} written).`);
        const months = (sheetResult.months || []).join(', ');
        addLogEntry(
          `Sent to Google Sheet: ${sheetResult.written} row(s) written/updated` +
            (months ? ` in ${months} (Log + Payroll tabs).` : '.')
        );
        if (sheetResult.skipped_undated > 0) {
          addLogEntry(
            `${sheetResult.skipped_undated} record(s) had no usable date and were not written anywhere.`
          );
        }
      }
    } else {
      const errorMessage =
        (sheetResult && sheetResult.error) ||
        (response && response.error) ||
        'unknown error — check the Apps Script project\'s Executions log (clock icon on the left) for the actual failure';
      setStatus(parts.join(' — ') + ` — send failed: ${errorMessage}`);
      addLogEntry(`Send to sheet failed: ${errorMessage}`);
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    scanBtn.disabled = false;
  }
}

// ---- Debug: Inspect Shift Click ----

function buildInspectClickReport(result) {
  if (!result.found) {
    return `<!--\nNo completed shift found.\nReason: ${result.reason}\nCaptured at: ${result.capturedAt}\n-->`;
  }

  const header =
    `<!--\n` +
    `WellSky Shift Click Inspection (debug)\n` +
    `Page URL: ${result.pageUrl}\n` +
    `Captured at: ${result.capturedAt}\n` +
    `-->\n`;

  const shiftHtml = `<!-- ===== the shift element itself ===== -->\n${result.shiftOuterHTML}\n`;

  const resultsText = result.results
    .map((r) => {
      if (!r.tried) return `<!--\n  ${r.label}: not tried -- ${r.reason}\n-->`;
      const newEls = r.newElementsSnippets.length
        ? r.newElementsSnippets.map((s) => `    ${s}`).join('\n')
        : '    (none)';
      const newlyVisible = r.newlyVisibleSnippets.length
        ? r.newlyVisibleSnippets.map((s) => `    ${s}`).join('\n')
        : '    (none)';
      return (
        `<!--\n  ${r.label}:\n` +
        `  New elements that appeared (${r.newElementsCount}):\n${newEls}\n` +
        `  Previously-hidden elements that became visible (${r.newlyVisibleCount}):\n${newlyVisible}\n-->`
      );
    })
    .join('\n');

  return header + shiftHtml + `\n<!-- ===== per-target click results ===== -->\n${resultsText}\n`;
}

function downloadInspectClickReport(result) {
  const doc = buildInspectClickReport(result);
  const blob = new Blob([doc], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const safeTimestamp = result.capturedAt.replace(/[:.]/g, '-');
  const filename = `wellsky-shift-click-inspect-${safeTimestamp}.html`;

  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  });
}

async function inspectShiftClick() {
  inspectClickBtn.disabled = true;
  startNewRunLog();
  setStatus('Trying a few click targets on one completed shift...');

  try {
    const tab = await findWellSkyTab();
    if (!tab || !tab.id) {
      setStatus(NO_WELLSKY_TAB);
      return;
    }

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['inspect-shift-click-script.js'],
    });

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;
    if (!result) {
      setStatus('Could not run the inspection on this page.');
      return;
    }

    downloadInspectClickReport(result);

    if (!result.found) {
      setStatus(`No completed shift found to test. ${result.reason}`);
      return;
    }

    setStatus(`Tried ${result.results.length} click target(s). Downloaded the report -- reload the WellSky tab now.`);
    addLogEntry(`${new Date(result.capturedAt).toLocaleTimeString()} — shift click inspection downloaded.`);
  } catch (err) {
    setStatus(`Error: ${err.message}`);
  } finally {
    inspectClickBtn.disabled = false;
  }
}

// ---- Settings ----

async function loadWebhookUrl() {
  const { webhookUrl } = await chrome.storage.local.get('webhookUrl');
  if (webhookUrl) {
    webhookInput.value = webhookUrl;
  }
}

async function saveWebhookUrl() {
  const url = webhookInput.value.trim();
  if (!url) {
    setStatus('Enter a Google Sheet Web App URL first.');
    return;
  }

  try {
    new URL(url);
  } catch (err) {
    setStatus('That does not look like a valid URL.');
    return;
  }

  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
    setStatus('This should be an Apps Script Web App URL (starts with https://script.google.com/).');
    return;
  }

  saveWebhookBtn.disabled = true;
  try {
    await chrome.storage.local.set({ webhookUrl: url });
    setStatus('Google Sheet URL saved.');
  } catch (err) {
    setStatus(`Error saving URL: ${err.message}`);
  } finally {
    saveWebhookBtn.disabled = false;
  }
}

exportBtn.addEventListener('click', exportCareLogHtml);
scanBtn.addEventListener('click', scanSchedule);
inspectClickBtn.addEventListener('click', inspectShiftClick);
closeBtn.addEventListener('click', () => window.close());
saveWebhookBtn.addEventListener('click', saveWebhookUrl);

// The gear in the header opens the settings section, matching how the rest of
// Together Homecare's panels work. It stays a real <details> underneath, so the
// section is still reachable if this listener ever fails to bind -- and
// aria-expanded is kept in step so the control reads correctly to a screen
// reader rather than being an unlabelled glyph.
if (settingsBtn && settingsEl) {
  settingsBtn.addEventListener('click', () => {
    settingsEl.open = !settingsEl.open;
    settingsBtn.setAttribute('aria-expanded', String(settingsEl.open));
  });
  // Also covers the section being opened any other way.
  settingsEl.addEventListener('toggle', () => {
    settingsBtn.setAttribute('aria-expanded', String(settingsEl.open));
  });
}

// The side panel has Chrome's own close control in its header, so a second
// Close button here would be redundant -- and window.close() doesn't reliably
// dismiss a side panel anyway. It's kept for the standalone-window fallback.
if (IS_SIDE_PANEL) {
  closeBtn.style.display = 'none';
  const hint = document.getElementById('closeHint');
  if (hint) {
    hint.textContent =
      'Stays open while you work in WellSky. Close it with the X at the top of this panel.';
  }
}

loadWebhookUrl();
