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
// This file only ever runs when injected on demand -- never on page load.

(function () {
  const CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'FORM', 'ARTICLE']);

  // Strong, content-based signals -- much more reliable than guessing a class
  // name, since WellSky's actual CSS classes for these popups aren't known yet.
  const SIGNALS = [
    { name: 'edit-care-log', mustContain: ['Official', 'Bill Hours', 'Pay Hours'] },
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

  const matches = [];
  for (const signal of SIGNALS) {
    const el = findSmallestMatch(signal.mustContain);
    if (el) {
      matches.push({
        matchedAs: signal.name,
        outerHTML: el.outerHTML,
        byteLength: el.outerHTML.length,
      });
    }
  }

  return {
    matches,
    foundAny: matches.length > 0,
    pageUrl: window.location.href,
    pageTitle: document.title,
    capturedAt: new Date().toISOString(),
  };
})();
