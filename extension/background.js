// Service worker for the THC WellSky Shift Log extension.
//
// The control panel does the scanning; this worker opens that panel and
// relays the resulting shift records to the configured Google Sheet Web App,
// since fetches to an external URL belong in the background context.

chrome.runtime.onInstalled.addListener(() => {
  console.log('THC WellSky Shift Log installed.');
});

// The panel is a real window, not the usual action popup. An action popup is
// closed by Chrome the instant it loses focus, which can't be prevented from
// inside it -- and since the scan is driven from that page, a stray click used
// to kill a scan mid-run and lose everything it had gathered. A window closes
// only when you close it.
let panelWindowId = null;

async function openPanel() {
  // Reuse the existing panel if it's already open, so repeated clicks on the
  // toolbar icon focus it instead of stacking up copies that would each try to
  // drive the same scan.
  if (panelWindowId !== null) {
    try {
      await chrome.windows.update(panelWindowId, { focused: true });
      return;
    } catch (err) {
      panelWindowId = null; // it was closed since we last saw it
    }
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 440,
    height: 660,
  });
  panelWindowId = win.id;
}

chrome.action.onClicked.addListener(openPanel);

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === panelWindowId) panelWindowId = null;
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

  // Not `currentWindow`: from a service worker that resolves to whichever
  // window was focused last, which can be the panel's own window now that the
  // panel is a window rather than an action popup.
  const activeTabs = await chrome.tabs.query({ active: true });
  const candidates = activeTabs.filter(
    (t) => !String(t.url || '').startsWith('chrome-extension://')
  );
  const tab =
    candidates.find((t) => String(t.url || '').includes('clearcareonline.com')) || candidates[0];
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
