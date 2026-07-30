// Phase 0 — DOM discovery for the shift summary popup and Edit Care Log dialog.
//
// We don't yet know the real mechanism behind the "Actual" / "Scheduled"
// links under the Official start/end fields -- a real capture ruled out the
// obvious guess (a `title` attribute) since it stayed empty even after a
// user visually confirmed the real tooltip appeared during a simulated
// hover. Rather than guess a second attribute name, this probes each link
// individually: snapshot every attribute and every element on the page
// immediately before and after hovering JUST that one link, and report
// whatever actually changed. Guessing here risks silently mis-recording
// payroll timestamps, so this only ever captures what's really happening --
// a human opens the popup first, then clicks "Export Care Log HTML".
//
// It simulates hovering every "Actual"/"Scheduled" link itself (dispatching
// synthetic pointer/mouse events) before capturing -- there's no need for a
// human to physically hold the mouse over a link while also clicking the
// extension icon, which isn't even physically possible. A prior version
// checked once at the very end, after hovering all 8 links in sequence --
// if whatever shows the tooltip also clears it again once a *different*
// element gets hovered next, that would explain why nothing showed up
// there even though the tooltip is real. This version checks right after
// each individual hover instead.
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
      // "Bill Hours"/"Pay Hours" deliberately excluded: that block is
      // conditional in the real markup, so requiring it misses the dialog
      // entirely for a shift without billing. Status/Client/Caregiver alone
      // already separate the dialog from the sub-widget nested inside it.
      mustContain: ['Official', 'Status', 'Client', 'Caregiver'],
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
  // system in parallel, in case jQuery is present and some handler only
  // responds to jQuery's .trigger(), not a raw native dispatchEvent.
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

  function snapshotAttributes(el) {
    const result = {};
    for (const attr of el.attributes) result[attr.name] = attr.value;
    return result;
  }

  function diffAttributes(before, after) {
    const changed = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      if (before[key] !== after[key]) {
        changed[key] = { before: before[key] ?? null, after: after[key] ?? null };
      }
    }
    return changed;
  }

  // Generic "what showed up" check -- catches a tooltip implemented as a
  // brand-new DOM node anywhere on the page, without needing to guess its
  // class name or where it gets attached.
  function snapshotAllElements() {
    return new Set(document.querySelectorAll('*'));
  }

  function findNewTopLevelElements(before, after) {
    const isNew = (el) => !before.has(el);
    const newEls = Array.from(after).filter(isNew);
    // Skip an element if its parent is also new -- keeps the report to just
    // the outermost new node instead of every descendant of it too.
    return newEls.filter((el) => !el.parentElement || !isNew(el.parentElement));
  }

  // Probes one link at a time: snapshot -> hover -> settle -> snapshot again
  // -> diff, immediately, before moving to the next link. This is what
  // catches a value that gets set and then cleared again once a *different*
  // element receives the next hover.
  async function probeHoverTargets(container) {
    const targets = findHoverTargets(container);
    const probes = [];

    for (const target of targets) {
      const attrsBefore = snapshotAttributes(target);
      const elsBefore = snapshotAllElements();

      simulateHover(target);
      await sleep(HOVER_SETTLE_MS);

      const attrsAfter = snapshotAttributes(target);
      const elsAfter = snapshotAllElements();

      probes.push({
        linkClass: target.className || null,
        linkText: (target.textContent || '').trim(),
        changedAttributes: diffAttributes(attrsBefore, attrsAfter),
        newElements: findNewTopLevelElements(elsBefore, elsAfter).map((el) => el.outerHTML),
      });
    }

    return probes;
  }

  const matches = [];
  let hoverProbes = [];

  for (const signal of SIGNALS) {
    const el = findSmallestMatch(signal.mustContain);
    if (!el) continue;

    if (signal.name === 'edit-care-log') {
      hoverProbes = await probeHoverTargets(el);
    }

    matches.push({
      matchedAs: signal.name,
      outerHTML: el.outerHTML,
      byteLength: el.outerHTML.length,
    });
  }

  return {
    matches,
    hoverProbes,
    hoverTargetsTriggered: hoverProbes.length,
    jQueryDetected: Boolean(window.jQuery || window.$),
    foundAny: matches.length > 0,
    pageUrl: window.location.href,
    pageTitle: document.title,
    capturedAt: new Date().toISOString(),
  };
})();
