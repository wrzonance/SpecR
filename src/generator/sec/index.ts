import type { SpecNode, SpecTree, SecRef } from '../../ast/index.js';
import { GeneratorError } from '../error.js';
import { encodeXmlEntities } from './entities.js';
import { tierOf } from './tier.js';

// AST → SpecsIntact .SEC renderer — the inverse of parser/sec/index.ts.
//
// Faithfulness is defined as AST round-trip: parse → generateSec → re-parse
// yields the same tree (section, title, and every node's type/text/vanish).
// The parser is deliberately lossy (it drops MTA/HDR/BRK chrome, URL/SCP inline
// wrappers, and SRF inline section numbers), so this renderer emits a clean
// canonical .SEC rather than reproducing the original bytes.
//
// Each node type inverts its parser mapping:
//   tree  → <SEC><SCN>SECTION …</SCN><STL>…</STL>{parts}</SEC>
//   part  → <PRT><TTL>PART N   …</TTL>{spts}</PRT>   (PART N prefix re-added)
//   spt   → <SPT><TTL>…</TTL>{refs}{children}</SPT>
//   note  → <NTE><NPR>…</NPR></NTE>
//   cont. → <TXT>…</TXT>
//   leaf at parent_tier+1 → <LST>;  leaf at parent_tier+2 → <ITM>
//   standard ref → <REF><RID>code</RID><RTL>rtl</RTL></REF>

const XML_DECL = '<?xml version="1.0" encoding="windows-1252"?>';

type RefIndex = ReadonlyMap<string, readonly SecRef[]>;

function indexRefs(refs: readonly SecRef[]): RefIndex {
  const byNode = new Map<string, SecRef[]>();
  for (const ref of refs) {
    if (ref.targetType !== 'standard' || !ref.standardCode) continue;
    const list = byNode.get(ref.sourceNodeId) ?? [];
    list.push(ref);
    byNode.set(ref.sourceNodeId, list);
  }
  return byNode;
}

function escape(text: string): string {
  return encodeXmlEntities(text);
}

function renderNote(node: SpecNode): string {
  return `<NTE><NPR>${escape(node.text)}</NPR></NTE>`;
}

function renderRef(ref: SecRef): string {
  const rid = `<RID>${escape(ref.standardCode ?? '')}</RID>`;
  // referenceText is "CODE RTL" (or just "CODE"); recover the RTL tail so the
  // re-parse rebuilds the same standard ref. Empty tail emits no <RTL>.
  const code = ref.standardCode ?? '';
  const tail = ref.referenceText.startsWith(code)
    ? ref.referenceText.slice(code.length).trim()
    : ref.referenceText.trim();
  const rtl = tail.length > 0 ? `<RTL>${escape(tail)}</RTL>` : '';
  return `<REF>${rid}${rtl}</REF>`;
}

// A structural child renders as a nested <SPT> when it carries any children of
// its own (structural, continuation, or note) — only an SPT can hold child
// content (and only a nested SPT can carry a <REF>). A truly childless node
// with no refs becomes a leaf list/item whose element is chosen by its tier
// offset from the parent SPT (+1 → LST, +2 → ITM).
function isLeaf(node: SpecNode, refs: RefIndex): boolean {
  return node.children.length === 0 && !refs.has(node.id);
}

function leafElement(offset: number, text: string): string {
  const body = escape(text);
  if (offset >= 2) return `<ITM>${body}</ITM>`;
  return `<LST>${body}</LST>`;
}

function renderStructuralChild(child: SpecNode, parentTier: number, refs: RefIndex): string {
  const childTier = tierOf(child.type);
  if (childTier === null) return '';
  if (isLeaf(child, refs)) return leafElement(childTier - parentTier, child.text);
  // A node with children must be a nested SPT (only SPT holds child content),
  // and a nested SPT always re-parses at parentTier+1. A child declaring a
  // larger tier while carrying children cannot be expressed by a single
  // element; it does not occur in the UFGS corpus (see KNOWN AMBIGUITY test).
  return renderSpt(child, refs);
}

function renderChildren(node: SpecNode, tier: number, refs: RefIndex): string {
  const out: string[] = [];
  for (const child of node.children) {
    if (child.type === 'note') out.push(renderNote(child));
    // A hidden non-note continuation is suppressed (#296). A note is always kept
    // as <NTE> (SEC notes are vanish by definition), and a structural node keeps
    // rendering even when vanish — owner-removal (vanish on a body node) is the
    // separate, still-lossy #278 case the round-trip tests pin.
    else if (child.type === 'continuation') {
      if (child.meta.vanish !== true) out.push(`<TXT>${escape(child.text)}</TXT>`);
    } else if (tierOf(child.type) !== null) out.push(renderStructuralChild(child, tier, refs));
  }
  return out.join('');
}

function renderSpt(node: SpecNode, refs: RefIndex): string {
  const tier = tierOf(node.type) ?? 0;
  const ttl = `<TTL>${escape(node.text)}</TTL>`;
  const refXml = (refs.get(node.id) ?? []).map(renderRef).join('');
  return `<SPT>${ttl}${refXml}${renderChildren(node, tier, refs)}</SPT>`;
}

function renderPart(node: SpecNode, index: number, refs: RefIndex): string {
  const ttl = `<TTL>PART ${index + 1}   ${escape(node.text)}</TTL>`;
  const body = node.children
    .map((child) => {
      if (child.type === 'note') return renderNote(child);
      if (tierOf(child.type) !== null) return renderSpt(child, refs);
      return '';
    })
    .join('');
  return `<PRT>${ttl}${body}</PRT>`;
}

// A tree root carries the same rule as a deeper node (#296): a note root is a
// <NTE>, a hidden non-note root is suppressed, a visible continuation root is
// plain <TXT>, and only a visible structural root becomes a <PRT>. The root level
// previously mapped EVERY root through renderPart, so a note/continuation/vanish
// root rendered as a fake "PART n" and shifted real PART numbering.
//
// KNOWN LIMITATION (adjacent to #278): root-level <NTE>/<TXT> chrome is emitted for
// export fidelity but is NOT re-parseable — parseSec rebuilds roots only from <PRT>,
// so a DOCX-origin tree's root note/continuation is lost on generate → parse. The
// fix is parser-side and out of scope here; pinned by a KNOWN LIMITATION test.
function renderRoot(node: SpecNode, partIndex: number, refs: RefIndex): string {
  if (node.type === 'note') return renderNote(node);
  if (node.meta.vanish === true) return '';
  if (node.type === 'continuation') {
    return `<TXT>${escape(node.text)}</TXT>`;
  }
  return renderPart(node, partIndex, refs);
}

// Only visible structural roots take a "PART n" ordinal — note/continuation/vanish
// roots are chrome and must not advance it (mirrors markdown.ts consumesNumber).
function isPartRoot(node: SpecNode): boolean {
  return node.type !== 'note' && node.type !== 'continuation' && node.meta.vanish !== true;
}

function renderRoots(parts: readonly SpecNode[], refs: RefIndex): string {
  const out: string[] = [];
  let partIndex = 0;
  for (const node of parts) {
    out.push(renderRoot(node, partIndex, refs));
    if (isPartRoot(node)) partIndex += 1;
  }
  return out.join('');
}

/**
 * Render a spec tree (and optional standard refs) to a SpecsIntact .SEC XML
 * string. The output is the canonical inverse of the SEC parser: re-parsing it
 * reproduces the same AST.
 */
export function generateSec(tree: SpecTree, refs: readonly SecRef[] = []): string {
  try {
    const refIndex = indexRefs(refs);
    const scn = `<SCN>SECTION ${escape(tree.section)}</SCN>`;
    const stl = `<STL>${escape(tree.title)}</STL>`;
    const parts = renderRoots(tree.parts, refIndex);
    return `${XML_DECL}<SEC>${scn}${stl}${parts}</SEC>`;
  } catch (err) {
    if (err instanceof GeneratorError) throw err;
    throw new GeneratorError('SEC generation failed', { cause: err });
  }
}
