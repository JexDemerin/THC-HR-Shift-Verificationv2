// Service worker for the THC WellSky Shift Log extension.
//
// The control panel does the scanning; this worker opens that panel and
// relays the resulting shift records to the configured Google Sheet Web App,
// since fetches to an external URL belong in the background context.

// The panel opens in Chrome's side panel -- docked beside the page, staying
// open while you click around WellSky, with the browser's own close control.
//
// It deliberately isn't the usual action popup: Chrome closes an action popup
// the instant it loses focus and that can't be prevented from inside it. Since
// the scan is driven from that page, a stray click used to kill a scan mid-run
// and lose everything it had gathered.
async function enableSidePanelOnActionClick() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

chrome.runtime.onInstalled.addListener(() => {
  enableSidePanelOnActionClick().catch(() => {
    // Side panels need Chrome 114+. On anything older this throws, and the
    // action-click fallback below opens a standalone window instead.
  });
});

chrome.runtime.onStartup.addListener(() => {
  enableSidePanelOnActionClick().catch(() => {});
});

// Only reached when the side panel isn't available: with
// openPanelOnActionClick set, Chrome opens the panel itself and never fires
// this. A standalone window is the fallback, since it also survives losing
// focus -- unlike an action popup.
let fallbackWindowId = null;

chrome.action.onClicked.addListener(async () => {
  if (fallbackWindowId !== null) {
    try {
      await chrome.windows.update(fallbackWindowId, { focused: true });
      return;
    } catch (err) {
      fallbackWindowId = null; // closed since we last saw it
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 440,
    height: 660,
  });
  fallbackWindowId = win.id;
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === fallbackWindowId) fallbackWindowId = null;
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

  // Matched by URL, not by {active: true}: that only returns the front tab of
  // each window, so the WellSky tab drops out of the running the moment
  // anything else takes focus beside it -- and the old fallback then reached
  // for an unrelated tab instead. Same fix as findWellSkyTab() in popup.js.
  const tabs = await chrome.tabs.query({ url: 'https://*.clearcareonline.com/*' });
  const tab =
    tabs.find((t) => t.active) ||
    tabs.slice().sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
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
