// Hover/focus walker: a floating ‹ n/N › pill that appears over an item and
// steps through a list of sibling items in document order, wrapping at the ends.
// The pill is position:fixed and deliberately does NOT follow the target — the
// page scrolls beneath it, so repeated "next" walks the whole list without the
// control chasing the cursor.
//
// createHoverWalker is the reusable engine; initRefPopover (spec-map citations)
// and the audit-view findings walker are thin callers. The spec-map caller keeps
// the original hover-only behavior byte-for-byte; the audit caller opts into
// keyboard stepping + an aria-live counter.

import { locateLink } from './tree.js';

const HIDE_GRACE_MS = 300;

function makeButton(label, title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pop-step';
  btn.textContent = label;
  btn.title = title;
  return btn;
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

// Move focus onto an item (or its first focusable child) so keyboard stepping
// keeps focus on the current item — the walker's item rows are not focusable
// themselves; their inner section button is.
function focusWithin(item) {
  if (!item) return;
  const target = item.matches(FOCUSABLE) ? item : item.querySelector(FOCUSABLE);
  target?.focus({ preventScroll: true });
}

// opts:
//   itemSelector       CSS selector identifying a walkable item
//   listFor(anchor)    -> ordered array of items to walk (from the hovered item)
//   onStep(item)       called with the new item on every prev/next step
//   prevTitle/nextTitle button tooltips
//   popClass           extra class on the pill (styling hook)
//   keyboard           focus-to-open + arrow-key stepping + aria-live counter
//   hideOnItemClick    drop the pill when an item is clicked (spec-map default)
export function createHoverWalker(opts) {
  const {
    itemSelector,
    listFor,
    onStep,
    prevTitle,
    nextTitle,
    popClass,
    keyboard = false,
    hideOnItemClick = true,
  } = opts;

  const pop = document.createElement('div');
  pop.className = popClass ? `ref-popover ${popClass}` : 'ref-popover';
  pop.hidden = true;
  if (keyboard) pop.setAttribute('role', 'group');

  const prev = makeButton('‹', prevTitle);
  const counter = document.createElement('span');
  counter.className = 'pop-counter';
  if (keyboard) counter.setAttribute('aria-live', 'polite');
  const next = makeButton('›', nextTitle);
  pop.append(prev, counter, next);
  document.body.appendChild(pop);

  let anchor = null; // the item the pill currently refers to
  let hideTimer = null;

  function items() {
    return anchor ? listFor(anchor) : [];
  }

  function updateCounter() {
    const list = items();
    const index = list.indexOf(anchor);
    counter.textContent = index === -1 ? '–' : `${index + 1}/${list.length}`;
  }

  function showAt(item) {
    anchor = item;
    updateCounter();
    pop.hidden = false;
    const rect = item.getBoundingClientRect();
    pop.style.left = `${rect.left + rect.width / 2}px`;
    pop.style.top = `${rect.top - 6}px`;
  }

  function hide() {
    pop.hidden = true;
    anchor = null;
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const overPopover = pop.matches(':hover');
      const overAnchor = anchor !== null && anchor.isConnected && anchor.matches(':hover');
      // Keyboard callers keep the pill up while focus is on the anchor OR its
      // inner focusable child (the finding row's section button) — a plain
      // identity check misses the child and would drop the pill mid-walk.
      const anchorFocused =
        keyboard &&
        anchor !== null &&
        anchor.isConnected &&
        anchor.contains(document.activeElement);
      if (!overPopover && !overAnchor && !anchorFocused) hide();
    }, HIDE_GRACE_MS);
  }

  function step(delta) {
    if (!anchor || !anchor.isConnected) {
      hide();
      return;
    }
    const list = items();
    if (list.length === 0) return;
    const index = list.indexOf(anchor);
    const target = list[(index + delta + list.length) % list.length];
    anchor = target;
    onStep(target);
    updateCounter(); // pill stays put under the cursor; the page moves instead
  }

  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  pop.addEventListener('mouseleave', scheduleHide);

  document.addEventListener('mouseover', (event) => {
    const item = event.target.closest?.(itemSelector);
    if (item) {
      clearTimeout(hideTimer);
      showAt(item);
    } else if (!pop.hidden && !pop.contains(event.target)) {
      scheduleHide();
    }
  });

  if (hideOnItemClick) {
    // clicking an item navigates away — drop the pill
    document.addEventListener('click', (event) => {
      if (event.target.closest?.(itemSelector)) hide();
    });
  }

  if (keyboard) {
    document.addEventListener('focusin', (event) => {
      const item = event.target.closest?.(itemSelector);
      if (item) {
        clearTimeout(hideTimer);
        showAt(item);
      }
    });
    document.addEventListener('keydown', (event) => {
      if (pop.hidden || !anchor) return;
      const active = document.activeElement;
      const onItem = active && active.closest?.(itemSelector);
      const onPop = pop.contains(active);
      if (!onItem && !onPop) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        event.preventDefault();
        step(1);
        focusWithin(anchor); // focus follows selection so the next Arrow works
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
        focusWithin(anchor);
      } else if (event.key === 'Escape') {
        hide();
      }
    });
  }

  return { showAt, hide };
}

// Spec-map citation walk: hovering any in-body `.ref-link` shows the pill and
// steps through EVERY citation site in that spec's body, in document order.
export function initRefPopover() {
  return createHoverWalker({
    itemSelector: '.ref-link',
    listFor: (anchor) => {
      const sheet = anchor.closest('.spec-sheet');
      return sheet ? [...sheet.querySelectorAll('.ref-link')] : [];
    },
    onStep: (target) => locateLink(target),
    prevTitle: 'Previous citation in this spec',
    nextTitle: 'Next citation in this spec',
  });
}
