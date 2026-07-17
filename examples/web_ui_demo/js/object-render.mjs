// Read-only demo render for a captured DOCX body object (#300, ADR-072): a
// `w:tbl` table or a text box, modeled server-side as an opaque OOXML blob
// (SpecNode.meta.object, ObjectMeta) rather than inferred CSI structure.
//
// isSimpleGridObject/chunkIntoRows mirror src/generator/markdown.ts's
// isSimpleGrid/chunkIntoRows byte-for-byte in logic — the demo can't import
// the TS build, so the "simple grid" heuristic is reimplemented here. This
// is the same mirroring pattern tree.js already uses for consumesNumber
// (see its own comment) — keep both in sync if the server-side rule changes.
//
// Scope is READ-ONLY: WS3 adds no edit affordance for object/objectText
// nodes. All text below goes through textContent, never innerHTML (see
// tree.js's file header — spec content is untrusted input).

/**
 * A "simple grid": the node's captured objectText children count exactly
 * matches rows*columns, so document-order cells can be chunked into
 * columns-wide rows with no merge evidence to account for. A merged or
 * blank cell (a blank cell is never captured, per ADR-072) throws off the
 * count and this returns false — the caller falls back to a labeled list
 * rather than guessing at cell positions.
 */
export function isSimpleGridObject(node, meta) {
  return (
    meta != null &&
    meta.rows !== undefined &&
    meta.columns !== undefined &&
    Array.isArray(node?.children) &&
    node.children.length === meta.rows * meta.columns
  );
}

/** Chunk a flat cell list into columns-wide rows (the last row may be short). */
export function chunkIntoRows(cells, columns) {
  const rows = [];
  for (let i = 0; i < cells.length; i += columns) {
    rows.push(cells.slice(i, i + columns));
  }
  return rows;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderGridTable(node, meta) {
  const table = el('table', 'object-grid');
  for (const row of chunkIntoRows(node.children, meta.columns)) {
    const tr = el('tr');
    for (const cellNode of row) {
      tr.appendChild(el('td', 'object-cell', cellNode.text));
    }
    table.appendChild(tr);
  }
  return table;
}

function renderTextBox(node, meta) {
  const wrap = el('div', 'object-textbox');
  wrap.appendChild(el('span', 'object-textbox-label', 'TEXT BOX'));
  const text = node.children.map((child) => child.text).join(' ');
  wrap.appendChild(el('span', 'object-textbox-text', text));
  if (meta.floating) {
    wrap.appendChild(el('span', 'object-textbox-floating', '(floating)'));
  }
  return wrap;
}

// Exotic cases (merged/blank cells the grid heuristic can't place, or a node
// missing its object metadata entirely) fall back to a labeled block of one
// line per captured interior text — never a guess at a table shape the blob
// doesn't cleanly support. Mirrors generator/markdown.ts's renderObjectFallback.
function renderFallbackList(node, meta) {
  const wrap = el('div', 'object-fallback');
  const label = meta?.kind === 'table' ? '[TABLE]' : '[OBJECT]';
  wrap.appendChild(el('span', 'object-fallback-label', label));
  for (const child of node.children ?? []) {
    wrap.appendChild(el('div', 'object-fallback-line', child.text));
  }
  return wrap;
}

/**
 * Read-only DOM render of a captured body object node (#300). A table
 * renders as a real HTML `<table>` when the grid is unambiguous; a text box
 * renders as a labeled inline block; everything else (merged/blank cells,
 * missing meta) degrades to a labeled list of captured lines. `ctx` is
 * accepted (unused today) for call-site symmetry with tree.js's other
 * renderX(node, ctx) dispatch — object rendering has no editability/inline-
 * editing affordance yet (WS3 scope is read-only).
 */
export function renderObjectBlock(node, ctx) {
  void ctx;
  const meta = node.meta && node.meta.object;
  const wrap = el('div', 'tree-object');
  wrap.dataset.nodeId = node.id;
  if (meta && meta.kind === 'textBox') {
    wrap.appendChild(renderTextBox(node, meta));
  } else if (meta && isSimpleGridObject(node, meta)) {
    wrap.appendChild(renderGridTable(node, meta));
  } else {
    wrap.appendChild(renderFallbackList(node, meta));
  }
  return wrap;
}
