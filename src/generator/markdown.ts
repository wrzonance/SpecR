import type { SpecNode, SpecTree } from '../ast/types.js';
import { getLabel, consumesNumber } from '../ast/index.js';

// getLabel is re-exported so existing consumers (and the markdown-renderer contract)
// keep importing CSI labels from here; the logic itself is single-sourced in ast/labels
// and reached through the ast barrel (module-boundary rule).
export { getLabel };

const INDENT = '   ';

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
// continuation renders as indented plain text. Returns null for a structural
// (numbered) node — the caller labels it (a part at the root, a pr-tier deeper).
function renderNonStructural(node: SpecNode, depth: number): string | null {
  if (node.type === 'note') {
    return `\n> **[NOTE]** ${node.text}`;
  }
  if (node.meta.vanish) {
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
