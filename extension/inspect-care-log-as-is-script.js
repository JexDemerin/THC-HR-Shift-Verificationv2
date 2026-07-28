// Phase 0 discovery, captured AS-IS -- no simulated hover.
//
// Used by the Ctrl+Shift+E keyboard shortcut (see background.js), for the
// case where a human is physically hovering an "Actual"/"Scheduled" link with
// the real mouse right now (which the simulated-hover version in
// inspect-care-log-script.js is meant to make unnecessary, but can't fully
// replace until it's confirmed to actually trigger WellSky's real handler).
// A keyboard shortcut can fire without moving the mouse away from whatever
// it's currently hovering, unlike clicking the extension icon.
//
// This file only ever runs when injected on demand -- never on page load.

(function () {
  const CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'FORM', 'ARTICLE']);

  // Keep in sync with inspect-care-log-script.js's SIGNALS.
  const SIGNALS = [
    {
      name: 'edit-care-log',
      mustContain: ['Official', 'Bill Hours', 'Pay Hours', 'Status', 'Client', 'Caregiver'],
    },
    { name: 'summary-popup', mustContain: ['Care Log', 'Summary', 'Notes', 'Edit', 'Copy'] },
  ];

  function containsAll(text, phrases) {
    return phrases.every((p) => text.includes(p));
  }

  function findSmallestMatch(mustContain) {
    if (!document.body) return null;
    const candidates = Array.from(document.body.querySelectorAll('*')).filter((el) =>
      CONTAINER_TAGS.has(el.tagName)
    );

    let best = null;
    let bestSize = Infinity;

    for (const el of candidates) {
      const text = el.textContent || '';
      if (containsAll(text, mustContain)) {
        const size = el.outerHTML.length;
        if (size < bestSize) {
          bestSize = size;
          best = el;
        }
      }
    }
    return best;
  }

  function findFloatingTooltips() {
    const selector = '[role="tooltip"], .tooltip, .ui-tooltip, [class*="tooltip" i]';
    return Array.from(document.querySelectorAll(selector)).map((el) => el.outerHTML);
  }

  const matches = [];
  for (const signal of SIGNALS) {
    const el = findSmallestMatch(signal.mustContain);
    if (el) {
      matches.push({ matchedAs: signal.name, outerHTML: el.outerHTML, byteLength: el.outerHTML.length });
    }
  }

  return {
    matches,
    floatingTooltips: findFloatingTooltips(),
    hoverTargetsTriggered: 0, // nothing simulated -- this capture relies on a real physical hover
    jQueryDetected: Boolean(window.jQuery || window.$),
    foundAny: matches.length > 0,
    pageUrl: window.location.href,
    pageTitle: document.title,
    capturedAt: new Date().toISOString(),
  };
})();
