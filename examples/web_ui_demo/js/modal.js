// Minimal promise-based modal dialog. Spec content is untrusted input, so every
// string goes through textContent — nothing here ever touches innerHTML.

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// body: a string, a DOM Node, or an array whose entries are strings or
// { text, kind } objects (kind: 'mono' | 'muted' | 'strong' | 'warn').
function appendBody(dialog, body) {
  const wrap = el('div', 'modal-body');
  const items = Array.isArray(body) ? body : [body];
  for (const item of items) {
    if (item instanceof Node) {
      wrap.appendChild(item);
    } else if (item && typeof item === 'object') {
      wrap.appendChild(el('p', `modal-line is-${item.kind || 'text'}`, item.text));
    } else if (item !== undefined && item !== null && item !== '') {
      wrap.appendChild(el('p', 'modal-line is-text', String(item)));
    }
  }
  dialog.appendChild(wrap);
}

let openVeil = null; // only one modal at a time
// Closes whatever modal is currently open by running its own finish(null), so
// its keydown listener is removed and its promise resolves. Removing the veil
// directly would orphan both.
let closeOpenModal = null;

// choices: [{ label, value, kind }] where kind ∈ 'primary' | 'danger' | 'ghost'.
// Resolves with the chosen value, or null on Esc / backdrop / close.
export function openChoice({ title, body, choices }) {
  return new Promise((resolve) => {
    if (closeOpenModal) closeOpenModal();

    const veil = el('div', 'modal-veil');
    const dialog = el('div', 'modal');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.appendChild(el('h3', 'modal-title', title));
    appendBody(dialog, body);

    const actions = el('div', 'modal-actions');
    const buttons = choices.map((choice) => {
      const btn = el('button', `modal-btn is-${choice.kind || 'ghost'}`, choice.label);
      btn.type = 'button';
      btn.addEventListener('click', () => finish(choice.value));
      actions.appendChild(btn);
      return btn;
    });
    dialog.appendChild(actions);
    veil.appendChild(dialog);

    const prevFocus = document.activeElement;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      } else if (event.key === 'Tab') {
        trapFocus(event, buttons);
      }
    };

    function finish(value) {
      document.removeEventListener('keydown', onKey, true);
      veil.remove();
      if (openVeil === veil) {
        openVeil = null;
        closeOpenModal = null;
      }
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(value);
    }

    veil.addEventListener('mousedown', (event) => {
      if (event.target === veil) finish(null);
    });
    document.addEventListener('keydown', onKey, true);

    openVeil = veil;
    closeOpenModal = () => finish(null);
    document.body.appendChild(veil);
    const primary = buttons.find((b) => b.classList.contains('is-primary')) || buttons[0];
    if (primary) primary.focus();
  });
}

export function openPicker({
  title,
  body,
  items,
  itemText,
  renderItem,
  searchLabel = 'Search',
  searchPlaceholder = 'Search specifications',
  emptyText = 'No items match.',
}) {
  return new Promise((resolve) => {
    if (closeOpenModal) closeOpenModal();

    const veil = el('div', 'modal-veil');
    const dialog = el('div', 'modal modal-picker');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.appendChild(el('h3', 'modal-title', title));
    appendBody(dialog, body);

    const field = el('label', 'modal-field');
    field.appendChild(el('span', null, searchLabel));
    const input = document.createElement('input');
    input.type = 'search';
    input.autocomplete = 'off';
    input.placeholder = searchPlaceholder;
    field.appendChild(input);
    dialog.appendChild(field);

    const list = el('div', 'modal-pick-list');
    dialog.appendChild(list);

    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'modal-btn is-ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => finish(null));
    actions.appendChild(cancel);
    dialog.appendChild(actions);
    veil.appendChild(dialog);

    const prevFocus = document.activeElement;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      }
    };

    function matches(item, query) {
      if (!query) return true;
      return itemText(item).toLowerCase().includes(query);
    }

    function render() {
      const query = input.value.trim().toLowerCase();
      const visible = items.filter((item) => matches(item, query));
      list.replaceChildren();
      if (visible.length === 0) {
        list.appendChild(el('p', 'modal-pick-empty', emptyText));
        return;
      }
      for (const item of visible) {
        const row = el('button', 'modal-pick-row');
        row.type = 'button';
        const content = renderItem(item);
        if (content instanceof Node) row.appendChild(content);
        else row.textContent = String(content);
        row.addEventListener('click', () => finish(item));
        list.appendChild(row);
      }
    }

    function finish(value) {
      document.removeEventListener('keydown', onKey, true);
      veil.remove();
      if (openVeil === veil) {
        openVeil = null;
        closeOpenModal = null;
      }
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(value);
    }

    input.addEventListener('input', render);
    veil.addEventListener('mousedown', (event) => {
      if (event.target === veil) finish(null);
    });
    document.addEventListener('keydown', onKey, true);

    openVeil = veil;
    closeOpenModal = () => finish(null);
    document.body.appendChild(veil);
    render();
    input.focus();
  });
}

function trapFocus(event, buttons) {
  if (buttons.length === 0) return;
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// Two-button confirm. Resolves true only when the confirm button is pressed.
export function openConfirm({
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
}) {
  return openChoice({
    title,
    body,
    choices: [
      { label: cancelLabel, value: false, kind: 'ghost' },
      { label: confirmLabel, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  }).then((value) => value === true);
}
