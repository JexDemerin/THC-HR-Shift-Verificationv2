const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const exportBtn = document.getElementById('exportBtn');
const scanBtn = document.getElementById('scanBtn');
const webhookInput = document.getElementById('webhookUrl');
const saveWebhookBtn = document.getElementById('saveWebhookBtn');

function setStatus(text) {
  statusEl.textContent = text;
}

function addLogEntry(text) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = text;
  logEl.prepend(entry);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
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
  setStatus('Reading current tab...');

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus('No active tab found.');
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
  setStatus('Scanning visible schedule...');

  try {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus('No active tab found.');
      return;
    }

    const injectionResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['scan-script.js'],
    });

    const result = injectionResults && injectionResults[0] && injectionResults[0].result;
    if (!result) {
      setStatus('Could not read the schedule from this page.');
      return;
    }

    const { records, summary } = result;

    if (summary.total === 0) {
      setStatus(`No shifts found (checked ${result.rowCount} caregiver rows). Is a schedule visible on screen?`);
      return;
    }

    const parts = [`${summary.total} shifts found`];
    if (summary.unparsed > 0) parts.push(`${summary.unparsed} unparsed`);
    if (result.skippedTodayOrFuture > 0) parts.push(`${result.skippedTodayOrFuture} skipped (today/future)`);
    if (result.stoppedEarlyReason) parts.push('stopped early, see log');
    setStatus(parts.join(' — '));
    addLogEntry(
      `${new Date(result.scannedAt).toLocaleTimeString()} — scan — ${summary.total} total, ` +
        `${summary.completed} completed, ${summary.incomplete} incomplete, ${summary.upcoming} upcoming, ` +
        `${summary.ongoing} ongoing, ${summary.cancelled} cancelled, ${summary.unparsed} unparsed, ` +
        `${result.skippedTodayOrFuture} skipped (today/future)`
    );
    if (result.stoppedEarlyReason) {
      addLogEntry(`STOPPED EARLY: ${result.stoppedEarlyReason}`);
    }
    if (result.enrichmentDiagnostics && result.enrichmentDiagnostics.length > 0) {
      addLogEntry(`${result.enrichmentDiagnostics.length} completed shift(s) had a read issue:`);
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
      if (typeof sheetResult.written !== 'number') {
        // The current apps_script/Code.gs always returns a numeric `written`
        // -- getting anything else back means the Apps Script project is
        // very likely still running an older pasted-in version. Re-paste
        // the current Code.gs and create a NEW deployment (editing the
        // script alone doesn't update an existing Web App URL).
        setStatus(parts.join(' — ') + ' — sent to sheet, but got an unexpected response shape.');
        addLogEntry(
          'Sent to Google Sheet, but the response didn\'t look like the current Code.gs -- ' +
            're-paste apps_script/Code.gs into the Apps Script editor and create a NEW deployment ' +
            '(saving alone doesn\'t update an existing Web App URL).'
        );
      } else {
        setStatus(parts.join(' — ') + ` — sent to sheet (${sheetResult.written} written).`);
        addLogEntry(`Sent to Google Sheet: ${sheetResult.written} row(s) written/updated.`);
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
saveWebhookBtn.addEventListener('click', saveWebhookUrl);
loadWebhookUrl();
