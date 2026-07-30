// Must match SCRIPT_VERSION in apps_script/Code.gs. Bumped together whenever
// the Sheet-side script changes in a way this extension depends on, so a
// stale deployment is reported loudly instead of silently doing the wrong
// thing (or nothing).
const EXPECTED_SCRIPT_VERSION = 11;

const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const exportBtn = document.getElementById('exportBtn');
const scanBtn = document.getElementById('scanBtn');
const inspectClickBtn = document.getElementById('inspectClickBtn');
const closeBtn = document.getElementById('closeBtn');
const webhookInput = document.getElementById('webhookUrl');
const saveWebhookBtn = document.getElementById('saveWebhookBtn');

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

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['scan-script.js'],
    });

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;
    if (!result) {
      // The WellSky tab was found, so this is about the PAGE, not the tab --
      // say which, rather than the old message that covered both and pointed at
      // neither.
      setStatus(
        'Found the WellSky tab, but the scanner returned nothing from it. ' +
          'Make sure the weekly schedule is showing (not a settings or detail page), then re-scan.'
      );
      return;
    }

    const { records, summary } = result;

    if (summary.total === 0) {
      setStatus(`No shifts found (checked ${result.rowCount} caregiver rows). Is a schedule visible on screen?`);
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
        const found = sheetResult.script_version === undefined
          ? 'an older version that does not report one'
          : `version ${sheetResult.script_version}`;
        setStatus(parts.join(' — ') + ' — sheet is running OLD Code.gs, nothing was written properly.');
        addLogEntry(
          `The Sheet is running ${found}, but this extension needs version ${EXPECTED_SCRIPT_VERSION}. ` +
            'Monthly Log/Payroll tabs will NOT appear until it is updated.'
        );
        addLogEntry(
          'Fix: open the Sheet -> Extensions -> Apps Script, replace all the code with ' +
            'apps_script/Code.gs, Save, then Deploy -> Manage deployments -> pencil icon -> ' +
            'Version: "New version" -> Deploy. Do NOT create a separate new deployment, that ' +
            'makes a different URL. To check what is live, open your Web App URL in a browser: ' +
            `it should show script_version ${EXPECTED_SCRIPT_VERSION}.`
        );
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
