import type { SpecNode, SpecTree, SecRef } from '../../ast/index.js';
import { GeneratorError } from '../error.js';
import { encodeXmlEntities } from './entities.js';
import { tierOf } from './tier.js';

// AST → SpecsIntact .SEC renderer — the inverse of parser/sec/index.ts.
//
// Faithfulness is defined as AST round-trip: parse → generateSec → re-parse
// yields the same tree (section, title, and every node's type/text/vanish),
// EXCEPT an owner-removed/hidden non-note node (meta.vanish, #251/#278/#296),
// which is filtered along with its subtree by design — see ADR-060 and isHidden.
// A note is always kept (it is vanish by definition). SEC-origin trees carry
// vanish only on notes, so their round-trip is unaffected; the filter matters
// only for DOCX-origin trees that reach .SEC egress.
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

// A non-note node flagged vanish is owner-removed (#251/#278) or hidden (#296):
// it — and its whole subtree — are filtered from SEC egress, matching the DOCX and
// Markdown renderers, so removed content never appears in a .SEC export. This is a
// FILTER, not an encode: SEC's `vanish` column already means "specifier note" (the
// parser sets it for <NTE>), so an owner-removal marker distinct from that would have
// to be invented — filtering is the AST-honoring choice (ADR-060). A note is never
// filtered: SEC notes are vanish by definition and always export as <NTE>.
function isHidden(node: SpecNode): boolean {
  return node.type !== 'note' && node.meta.vanish === true;
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

// A structural child renders as a nested <SPT> when it carries any child that
// will actually render (structural, continuation, or note) — only an SPT can
// hold child content (and only a nested SPT can carry a <REF>). A node with no
// rendered children (truly childless, OR every child filtered as hidden) and no
// refs becomes a leaf list/item whose element is chosen by its tier offset from
// the parent SPT (+1 → LST, +2 → ITM). Excluding hidden children here keeps the
// filter self-consistent: a filtered subtree must not force a tier-gap node onto
// the nested-<SPT> path (which re-parses one tier shallower) when it is really a
// leaf after removal (#278, ADR-060).
function isLeaf(node: SpecNode, refs: RefIndex): boolean {
  return node.children.every(isHidden) && !refs.has(node.id);
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
  // A note is always kept as <NTE>. Any other vanished node — a hidden continuation
  // (#296) or an owner-removed structural body node (#278) — is filtered along with
  // its subtree; the remainder render as their normal <TXT>/<LST>/<SPT>/<ITM>.
  for (const child of node.children) {
    if (child.type === 'note') out.push(renderNote(child));
    else if (isHidden(child)) continue;
    else if (child.type === 'continuation') out.push(`<TXT>${escape(child.text)}</TXT>`);
    else if (tierOf(child.type) !== null) out.push(renderStructuralChild(child, tier, refs));
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
      // An owner-removed (#278) or hidden article is filtered with its subtree.
      if (isHidden(child)) return '';
      if (tierOf(child.type) !== null) return renderSpt(child, refs);
      return '';
    })
    .join('');
  return `<PRT>${ttl}${body}</PRT>`;
}

// A tree root carries the same rule as a deeper node (#296): a note root is a
// <NTE>, a hidden non-note root is filtered (#278/#296), a visible continuation root
// is plain <TXT>, and only a visible structural root becomes a <PRT>. The root level
// previously mapped EVERY root through renderPart, so a note/continuation/vanish
// root rendered as a fake "PART n" and shifted real PART numbering.
//
// KNOWN LIMITATION: root-level <NTE>/<TXT> chrome is emitted for export fidelity but
// is NOT re-parseable — parseSec rebuilds roots only from <PRT>, so a DOCX-origin
// tree's root note/continuation is lost on generate → parse. The fix is parser-side
// and out of scope here; pinned by a KNOWN LIMITATION test.
function renderRoot(node: SpecNode, partIndex: number, refs: RefIndex): string {
  if (node.type === 'note') return renderNote(node);
  if (isHidden(node)) return '';
  if (node.type === 'continuation') {
    return `<TXT>${escape(node.text)}</TXT>`;
  }
  return renderPart(node, partIndex, refs);
}

// Only visible structural roots take a "PART n" ordinal — note/continuation/vanish
// roots are chrome and must not advance it (mirrors markdown.ts consumesNumber).
function isPartRoot(node: SpecNode): boolean {
  return node.type !== 'note' && node.type !== 'continuation' && !isHidden(node);
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
 * reproduces the same AST — except owner-removed/hidden non-note nodes
 * (`meta.vanish`), which are filtered with their subtrees, so they do not
 * reappear on re-parse (filter, not lossless encode; #278, ADR-060).
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
