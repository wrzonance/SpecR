import type { SpecNode, SpecTree } from '../ast/types.js';
import type { ObjectMeta } from '../ast/index.js';
import { getLabel, consumesNumber } from '../ast/index.js';

// getLabel is re-exported so existing consumers (and the markdown-renderer contract)
// keep importing CSI labels from here; the logic itself is single-sourced in ast/labels
// and reached through the ast barrel (module-boundary rule).
export { getLabel };

const INDENT = '   ';

// GFM pipe-table cells can't carry a literal newline or an unescaped `|` — collapse the
// former to a space (captured objectText is already single-paragraph text) and escape
// the latter so a cell like "A | B" doesn't fracture the row into extra columns.
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function chunkIntoRows(cells: readonly SpecNode[], columns: number): readonly SpecNode[][] {
  const rows: SpecNode[][] = [];
  for (let i = 0; i < cells.length; i += columns) {
    rows.push(cells.slice(i, i + columns));
  }
  return rows;
}

function renderPipeRow(cells: readonly SpecNode[]): string {
  return `| ${cells.map((cell) => escapeTableCell(cell.text)).join(' | ')} |`;
}

// A "simple grid": the captured objectText count exactly matches rows*columns, so
// document-order cells can be chunked into columns-wide rows with no merge evidence to
// account for (ADR-072). A blank cell is never captured as an objectText leaf (its text
// would be empty), so any mismatch here means either a merged cell or a blank one — both
// degrade to renderObjectFallback rather than guessing at cell positions.
function isSimpleGrid(node: SpecNode, meta: ObjectMeta): meta is ObjectMeta & { columns: number } {
  return (
    meta.rows !== undefined &&
    meta.columns !== undefined &&
    node.children.length === meta.rows * meta.columns
  );
}

// The first chunked row doubles as the GFM header row — the blob carries no per-row
// "this is a header" flag, and GFM syntax requires a header/separator regardless.
function renderGfmTable(node: SpecNode, columns: number): string {
  const [header, ...body] = chunkIntoRows(node.children, columns);
  if (!header) return '';
  const separator = `| ${Array(columns).fill('---').join(' | ')} |`;
  return `\n${[renderPipeRow(header), separator, ...body.map(renderPipeRow)].join('\n')}`;
}

// Exotic cases (merged/blank cells the grid heuristic can't place, or a node missing
// its object metadata entirely) fall back to a labeled block of one line per captured
// interior text — never a guess at a table shape the blob doesn't cleanly support.
function renderObjectFallback(node: SpecNode, meta: ObjectMeta | undefined): string {
  const label = meta?.kind === 'table' ? '[TABLE]' : '[OBJECT]';
  const lines = node.children.map((child) => `${INDENT}${child.text}`);
  return [`\n> **${label}**`, ...lines].join('\n');
}

function renderTextBox(node: SpecNode, meta: ObjectMeta): string {
  const text = node.children.map((child) => child.text).join(' ');
  const floatingNote = meta.floating ? ' *(floating)*' : '';
  return `\n> **[TEXT BOX]** ${text}${floatingNote}`;
}

// A captured body object (#300, ADR-072) renders out-of-band from CSI numbering: a
// table as a GFM pipe table when its shape is unambiguous, a text box as a labeled
// blockquote, and anything else as a labeled fallback list. `node.children` are always
// the object's own `objectText` leaves (never rendered independently — see the
// objectText branch in renderNonStructural).
function renderObjectNode(node: SpecNode): string {
  const meta = node.meta.object;
  if (!meta) return renderObjectFallback(node, meta);
  if (meta.kind === 'textBox') return renderTextBox(node, meta);
  if (isSimpleGrid(node, meta)) return renderGfmTable(node, meta.columns);
  return renderObjectFallback(node, meta);
}

// Render a node's children, advancing the CSI ordinal only past numbered siblings
// so notes/continuations/vanish nodes interleave without disturbing the sequence.
function renderChildren(
  children: readonly SpecNode[],
  render: (child: SpecNode, ordinal: number) => string
): string {
  let ordinal = 0;
  const out: string[] = [];
  for (const child of children) {
    out.push(render(child, ordinal));
    if (consumesNumber(child)) ordinal += 1;
  }
  return out.join('');
}

// The one rule every depth shares — root and child alike (#296). A note always
// renders as a [NOTE] blockquote (editorial metadata visible to spec writers,
// regardless of meta.vanish); hidden (vanish) non-note content is suppressed; a
// continuation renders as indented plain text. An object (#300) renders as a table/
// text-box block; its objectText leaves fold into that rendering and never render on
// their own. Returns null for a structural (numbered) node — the caller labels it (a
// part at the root, a pr-tier deeper).
function renderNonStructural(node: SpecNode, depth: number): string | null {
  if (node.type === 'note') {
    return `\n> **[NOTE]** ${node.text}`;
  }
  if (node.meta.vanish) {
    return '';
  }
  if (node.type === 'object') {
    return renderObjectNode(node);
  }
  if (node.type === 'objectText') {
    return '';
  }
  if (node.type === 'continuation') {
    return `\n${INDENT.repeat(depth)}${node.text}`;
  }
  return null;
}

function renderPrNode(node: SpecNode, index: number, depth: number): string {
  const nonStructural = renderNonStructural(node, depth);
  if (nonStructural !== null) return nonStructural;
  const pad = INDENT.repeat(depth);
  const label = getLabel(node.type, index);
  return (
    `\n${pad}${label} ${node.text}` +
    renderChildren(node.children, (child, ordinal) => renderPrNode(child, ordinal, depth + 1))
  );
}

function renderArticle(node: SpecNode, index: number, partNumber: number): string {
  // A PART's direct children carry the same rule: a note/continuation/vanish child
  // (e.g. a hidden form appended after the PART heading, before any article) is not
  // an article and must not take a "P.n" label nor leak when hidden (#296).
  const nonStructural = renderNonStructural(node, 0);
  if (nonStructural !== null) return nonStructural;
  const label = getLabel('article', index, partNumber);
  return (
    `\n### ${label} ${node.text}\n` +
    renderChildren(node.children, (child, ordinal) => renderPrNode(child, ordinal, 0))
  );
}

function renderPart(node: SpecNode, index: number): string {
  const label = getLabel('part', index);
  return (
    `\n## ${label} ${node.text}\n` +
    renderChildren(node.children, (child, ordinal) => renderArticle(child, ordinal, index + 1))
  );
}

// A tree root carries the same note/vanish/continuation rule as any child (#296):
// a note/continuation/vanish root is chrome, not a PART, so it never takes a
// "PART n" label nor advances the PART ordinal. Only structural roots are parts.
function renderRoot(node: SpecNode, partIndex: number): string {
  const nonStructural = renderNonStructural(node, 0);
  if (nonStructural !== null) return nonStructural;
  return renderPart(node, partIndex);
}

export function renderMarkdown(tree: SpecTree): string {
  const rendered: string[] = [`# SECTION ${tree.section} — ${tree.title}`];
  let partIndex = 0;
  for (const node of tree.parts) {
    const out = renderRoot(node, partIndex);
    // consumesNumber excludes note/continuation/vanish, so a hidden/note/continuation
    // root cannot shift the "PART n" number of a real part that follows it.
    if (consumesNumber(node)) partIndex += 1;
    if (out !== '') rendered.push(out);
  }
  return rendered.join('\n');
}
