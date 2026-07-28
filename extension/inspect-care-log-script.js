// Phase 0 — DOM discovery for the shift summary popup and Edit Care Log dialog.
//
// We don't yet know the real markup for these two popups -- in particular how
// the "Actual" / "Scheduled" links under the Official start/end fields expose
// their tooltip values (a title attribute already present in the DOM? a
// separate element that only appears on hover? something else?). Guessing
// here risks silently mis-recording payroll timestamps, so this script only
// ever captures whatever popup is currently open on screen and hands its
// outerHTML back -- a human opens the popup first, then clicks "Export Care
// Log HTML" in the extension popup.
//
// It simulates hovering every "Actual"/"Scheduled" link itself (dispatching
// synthetic pointer/mouse events) before capturing -- there's no need for a
// human to physically hold the mouse over a link while also clicking the
// extension icon, which isn't even physically possible.
//
// This file only ever runs when injected on demand -- never on page load.

(async function () {
  const CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'FORM', 'ARTICLE']);
  const HOVER_SETTLE_MS = 400;

  // Strong, content-based signals -- much more reliable than guessing a class
  // name, since WellSky's actual CSS classes for these popups aren't known yet.
  //
  // The Edit Care Log dialog also contains a "Bill Hours"/"Pay Hours" hour
  // -override sub-widget that has its own nested "Official"/"Bill Hours"/
  // "Pay Hours" text, which used to satisfy this same signal on its own --
  // "smallest matching container" then grabbed that sub-widget instead of the
  // whole dialog. Requiring Status/Client/Caregiver too (only present in the
  // outer dialog, not that sub-widget) forces the match up to the real dialog.
  const SIGNALS = [
    {
      name: 'edit-care-log',
      mustContain: ['Official', 'Bill Hours', 'Pay Hours', 'Status', 'Client', 'Caregiver'],
    },
    { name: 'summary-popup', mustContain: ['Care Log', 'Summary', 'Notes', 'Edit', 'Copy'] },
  ];

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  // Dispatched directly on the target (not just bubbled), so this fires the
  // element's own mouseenter/mouseover listeners regardless of whether the
  // real handler was registered via addEventListener or a library like
  // jQuery's .hover()/.on('mouseenter'). Includes the element's real screen
  // position (clientX/Y default to 0,0 otherwise), in case the real handler
  // -- or a tooltip-positioning library -- checks the coordinates rather than
  // just which element received the event. Also fires jQuery's own event
  // system in parallel (this page loads jQuery -- Chosen.js's markup is
  // visible elsewhere in the dialog), since some jQuery-bound handlers only
  // respond to jQuery's .trigger(), not a raw native dispatchEvent.
  function simulateHover(el) {
    const rect = el.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY };

    el.dispatchEvent(new MouseEvent('mousemove', opts));
    el.dispatchEvent(new MouseEvent('pointerover', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));

    const jq = window.jQuery || window.$;
    if (jq) {
      jq(el).trigger('mouseover');
      jq(el).trigger('mouseenter');
    }
  }

  function findHoverTargets(container) {
    const candidates = Array.from(container.querySelectorAll('a, span, button, [role="button"]'));
    return candidates.filter((el) => {
      const text = (el.textContent || '').trim();
      return text === 'Actual' || text === 'Scheduled';
    });
  }

  async function hoverEveryActualScheduledLink(container) {
    const targets = findHoverTargets(container);
    for (const target of targets) {
      simulateHover(target);
      await sleep(HOVER_SETTLE_MS);
    }
    return targets.length;
  }

  // Some tooltip implementations append a floating element to <body> instead
  // of nesting it inside the dialog -- catch those too, in case the dialog's
  // own outerHTML capture (below) doesn't show anything even after hovering.
  function findFloatingTooltips() {
    const selector = '[role="tooltip"], .tooltip, .ui-tooltip, [class*="tooltip" i]';
    return Array.from(document.querySelectorAll(selector)).map((el) => el.outerHTML);
  }

  const matches = [];
  let hoverTargetsTriggered = 0;

  for (const signal of SIGNALS) {
    const el = findSmallestMatch(signal.mustContain);
    if (!el) continue;

    if (signal.name === 'edit-care-log') {
      hoverTargetsTriggered += await hoverEveryActualScheduledLink(el);
    }

    matches.push({
      matchedAs: signal.name,
      outerHTML: el.outerHTML, // re-read after hovering, so any attribute/DOM changes are included
      byteLength: el.outerHTML.length,
    });
  }

  const floatingTooltips = findFloatingTooltips();

  return {
    matches,
    floatingTooltips,
    hoverTargetsTriggered,
    jQueryDetected: Boolean(window.jQuery || window.$),
    foundAny: matches.length > 0,
    pageUrl: window.location.href,
    pageTitle: document.title,
    capturedAt: new Date().toISOString(),
  };
})();
