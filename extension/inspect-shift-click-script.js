// Debug tool: what actually happens when different parts of a completed
// shift are clicked.
//
// Clicking the whole ._event wrapper (with the plain `.click()` DOM method,
// which always dispatches at position 0,0) was observed opening WellSky's
// generic "Add Unavailability" popup instead of the shift's own summary.
// Clicking .title the same way produced nothing detectable at all. Since
// getting the hover mechanism working earlier also required real screen
// coordinates (plain events default to 0,0), every click attempt here uses
// the element's real on-screen position instead of the plain `.click()`
// method, in case WellSky's calendar uses click position for anything
// (not just which element received the event).
//
// Rather than guess a third target blind, this captures the shift's real
// markup directly (which may reveal an onclick attribute, a wrapping <a>,
// or similar) and tries a few candidate click targets in sequence,
// reporting -- for each one -- whether any new element appeared anywhere on
// the page, or any existing `display:none` element became visible (WellSky
// may pre-render a hidden modal shell and just toggle it, rather than
// create a new DOM node, which a plain "new element" diff wouldn't catch).
//
// This is a DIAGNOSTIC tool only -- reload the WellSky tab afterward
// regardless of what it reports, since it may leave a popup open if Escape
// didn't close whatever a given click target opened. It only ever presses
// Escape to try to close something -- never Save, never any other button.
//
// This file only ever runs when injected on demand -- never on page load.

(async function () {
  const SETTLE_MS = 1200;
  const CLOSE_SETTLE_MS = 500;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findFirstCompletedShift() {
    return document.querySelector('.day-data ._event.COMPLETED');
  }

  function snapshotAllElements() {
    return new Set(document.querySelectorAll('*'));
  }

  function findNewTopLevelElements(before, after) {
    const isNew = (el) => !before.has(el);
    return Array.from(after)
      .filter(isNew)
      .filter((el) => !el.parentElement || !isNew(el.parentElement));
  }

  // WellSky may pre-render a hidden modal shell and just toggle it visible
  // instead of creating a new element -- a plain "new element" diff would
  // never catch that, so this tracks which currently-hidden (`display:none`
  // inline style) elements stop being hidden.
  function snapshotHiddenInlineStyled() {
    const all = Array.from(document.querySelectorAll('[style]'));
    const hidden = all.filter((el) => /display\s*:\s*none/i.test(el.getAttribute('style') || ''));
    return new Map(hidden.map((el) => [el, el.getAttribute('style')]));
  }

  function findNewlyVisible(beforeHiddenMap) {
    return Array.from(beforeHiddenMap.keys()).filter((el) => {
      const style = el.getAttribute('style') || '';
      return !/display\s*:\s*none/i.test(style);
    });
  }

  function snippet(el, maxLength = 200) {
    const html = (el.outerHTML || '').replace(/\s+/g, ' ');
    return html.length > maxLength ? `${html.slice(0, maxLength)}...` : html;
  }

  async function closeWhateverOpened() {
    const opts = { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27 };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
    await sleep(CLOSE_SETTLE_MS);
  }

  // Real coordinates, not the plain `.click()` method's default 0,0 --
  // matches the fix that was needed to get the hover mechanism working.
  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const clientX = Math.round(rect.left + rect.width / 2);
    const clientY = Math.round(rect.top + rect.height / 2);
    const opts = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  async function tryClickAndReport(label, el) {
    if (!el) return { label, tried: false, reason: 'element not found on this shift' };

    const elsBefore = snapshotAllElements();
    const hiddenBefore = snapshotHiddenInlineStyled();

    simulateClick(el);
    await sleep(SETTLE_MS);

    const newEls = findNewTopLevelElements(elsBefore, snapshotAllElements());
    const newlyVisible = findNewlyVisible(hiddenBefore);

    await closeWhateverOpened();

    return {
      label,
      tried: true,
      newElementsCount: newEls.length,
      newElementsSnippets: newEls.map((e) => snippet(e)),
      newlyVisibleCount: newlyVisible.length,
      newlyVisibleSnippets: newlyVisible.map((e) => snippet(e)),
    };
  }

  const shiftEl = findFirstCompletedShift();
  if (!shiftEl) {
    return {
      found: false,
      reason: 'No completed (green) shift found currently visible on screen.',
      pageUrl: window.location.href,
      capturedAt: new Date().toISOString(),
    };
  }

  const candidates = [
    { label: 'whole ._event wrapper', el: shiftEl },
    { label: '.title', el: shiftEl.querySelector('.title') },
    { label: '.title .name', el: shiftEl.querySelector('.title .name') },
    { label: '.time', el: shiftEl.querySelector('.time') },
    { label: 'first nested <a>, if any', el: shiftEl.querySelector('a') },
  ];

  const results = [];
  for (const c of candidates) {
    results.push(await tryClickAndReport(c.label, c.el));
  }

  return {
    found: true,
    shiftOuterHTML: shiftEl.outerHTML,
    results,
    pageUrl: window.location.href,
    capturedAt: new Date().toISOString(),
  };
})();
