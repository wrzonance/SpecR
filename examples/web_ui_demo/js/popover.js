// Citation-walk popover: hovering any in-body section reference shows a
// floating ‹ n/N › pill. Next/prev step through EVERY citation site in that
// spec's body, in document order, wrapping at the ends. The pill is
// position:fixed and deliberately does NOT follow the target link — the page
// scrolls beneath it, so repeated "next" clicks walk the whole spec without
// chasing the control.

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

export function initRefPopover() {
  const pop = document.createElement('div');
  pop.className = 'ref-popover';
  pop.hidden = true;

  const prev = makeButton('‹', 'Previous citation in this spec');
  const counter = document.createElement('span');
  counter.className = 'pop-counter';
  const next = makeButton('›', 'Next citation in this spec');
  pop.append(prev, counter, next);
  document.body.appendChild(pop);

  let anchor = null; // the citation link the popover currently refers to
  let hideTimer = null;

  function sheetLinks() {
    const sheet = anchor ? anchor.closest('.spec-sheet') : null;
    return sheet ? [...sheet.querySelectorAll('.ref-link')] : [];
  }

  function updateCounter() {
    const links = sheetLinks();
    const index = links.indexOf(anchor);
    counter.textContent = index === -1 ? '–' : `${index + 1}/${links.length}`;
  }

  function showAt(link) {
    anchor = link;
    updateCounter();
    pop.hidden = false;
    const rect = link.getBoundingClientRect();
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
      if (!overPopover && !overAnchor) hide();
    }, HIDE_GRACE_MS);
  }

  function step(delta) {
    if (!anchor || !anchor.isConnected) {
      hide();
      return;
    }
    const links = sheetLinks();
    if (links.length === 0) return;
    const index = links.indexOf(anchor);
    const target = links[(index + delta + links.length) % links.length];
    anchor = target;
    locateLink(target);
    updateCounter(); // pill stays put under the cursor; the page moves instead
  }

  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  pop.addEventListener('mouseleave', scheduleHide);

  document.addEventListener('mouseover', (event) => {
    const link = event.target.closest?.('.ref-link');
    if (link) {
      clearTimeout(hideTimer);
      showAt(link);
    } else if (!pop.hidden && !pop.contains(event.target)) {
      scheduleHide();
    }
  });

  // clicking a citation link navigates to another sheet — drop the pill
  document.addEventListener('click', (event) => {
    if (event.target.closest?.('.ref-link')) hide();
  });
}
