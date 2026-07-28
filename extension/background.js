// Service worker for the THC WellSky Shift Log extension.
//
// The popup does the scanning; this worker's only job is relaying the
// resulting shift records to the configured Google Sheet Web App, since
// fetches to an external URL belong in the background context rather than
// the popup.

chrome.runtime.onInstalled.addListener(() => {
  console.log('THC WellSky Shift Log installed.');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'SEND_TO_SHEET') {
    sendToSheet(message.webhookUrl, message.records)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async response
  }
});

// Ctrl+Shift+E: export the Edit Care Log dialog AS-IS, no simulated hover --
// for physically hovering an "Actual"/"Scheduled" link with the real mouse
// and triggering the export without having to move the mouse to click
// anything (which isn't possible while also holding a hover in place).
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'export-care-log-no-hover') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;

  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['inspect-care-log-as-is-script.js'],
  });

  const result = injectionResults && injectionResults[0] && injectionResults[0].result;
  if (!result || !result.foundAny) return;

  downloadCareLogExport(result);
});

function buildCareLogExportDocument(result) {
  const header =
    `<!--\n` +
    `WellSky Care Log Raw HTML Export (Phase 0 — DOM discovery, AS-IS / no simulated hover)\n` +
    `Page URL: ${result.pageUrl}\n` +
    `Page title: ${result.pageTitle}\n` +
    `Captured at: ${result.capturedAt}\n` +
    `Matches found: ${result.matches.map((m) => m.matchedAs).join(', ') || 'none'}\n` +
    `jQuery detected on page: ${result.jQueryDetected}\n` +
    `Floating tooltip-like elements found on the page: ${result.floatingTooltips.length}\n` +
    `-->\n`;
  const body = result.matches
    .map((m) => `<!-- ===== matched as: ${m.matchedAs} ===== -->\n${m.outerHTML}\n`)
    .join('\n');
  const tooltips = result.floatingTooltips.length
    ? `\n<!-- ===== floating tooltip-like elements found anywhere on the page ===== -->\n` +
      result.floatingTooltips.map((html) => `${html}\n`).join('\n')
    : '';
  return header + body + tooltips;
}

function downloadCareLogExport(result) {
  const doc = buildCareLogExportDocument(result);
  const blob = new Blob([doc], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const safeTimestamp = result.capturedAt.replace(/[:.]/g, '-');
  const filename = `wellsky-care-log-export-as-is-${safeTimestamp}.html`;

  chrome.downloads.download({ url, filename, saveAs: false }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  });
}

async function sendToSheet(webhookUrl, records) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    // text/plain avoids a CORS preflight request, which Apps Script Web
    // Apps don't answer correctly — Apps Script still reads the body as
    // JSON on its end regardless of this header.
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(records),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Sheet responded with HTTP ${response.status}: ${plainTextSnippet(text)}`);
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Sheet response wasn't valid JSON: ${plainTextSnippet(text)}`);
  }
}

function plainTextSnippet(html, maxLength = 500) {
  const text = html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
