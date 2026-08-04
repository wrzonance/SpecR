// Run-level vanish resolution for the body-object capture walk (#641/#650).
// Split out of body-objects.ts purely to keep that file under the repo's
// enforced `max-lines` budget — no behavior of its own moved, and no shared
// dependency on body-objects.ts's other node-navigation helpers: this file
// keeps its OWN minimal tagOf/directChildrenByTag copies, mirroring the
// established per-module-helper pattern body-order.ts and body-objects.ts
// themselves already document (self-contained beats a cross-file import that
// would otherwise create a circular dependency back into body-objects.ts).
import { getAttrVal } from './xml-utils.js';
import type { ObjectBlobNode } from '../../ast/index.js';

function tagOf(node: ObjectBlobNode): string | undefined {
  return Object.keys(node).find((key) => key !== ':@');
}

function isBlobNodeArray(value: unknown): value is readonly ObjectBlobNode[] {
  return Array.isArray(value);
}

function directChildrenByTag(node: ObjectBlobNode, tag: string): readonly ObjectBlobNode[] {
  const nodeTag = tagOf(node);
  if (!nodeTag) return [];
  const value = node[nodeTag];
  return isBlobNodeArray(value) ? value.filter((child) => tagOf(child) === tag) : [];
}

// `w:vanish` is an OOXML ST_OnOff toggle (ECMA-376 §17.3.2.45): bare or
// `w:val` in {1,true,on} means ON; an explicit `w:val` in {0,false,off} means
// the toggle is switched OFF — a VISIBLE run — most often because the run is
// overriding an inherited vanish from its style. Treating the mere PRESENCE
// of the element as "hidden" therefore suppresses visible text.
//
// This is not hypothetical: two real CPI corpus fixtures carry 15
// `<w:vanish w:val="0"/>` runs between them, several of them text-bearing
// (`CPI_COMMUNICATIONS_RACK_MOUNTED_POWER_PROTECTION_CSIMFS.docx` has
// "Select voltage/phase; breaker number, " and "rating" in exactly that
// shape). Since collectText's suppression in body-objects.ts is a
// text-DROPPING path, getting this backwards would silently lose visible
// spec text inside a captured table/text-box — the opposite of ADR-072's
// no-silent-loss posture. Erring toward keeping text is the safe direction:
// a missed suppression is a visible leak a test can catch, a wrong
// suppression is invisible data loss.
function isOnOffEnabled(node: ObjectBlobNode): boolean {
  const val = getAttrVal(node[':@']).toLowerCase();
  return val !== '0' && val !== 'false' && val !== 'off';
}

// Straight OR port of document.ts's own `runIsVanish`: a run is hidden if
// EITHER its own `w:rPr>w:vanish` is an enabled ST_OnOff toggle, OR its
// `w:rPr>w:rStyle` names a character style present in the caller's
// `vanishCharStyleIds` (the StyleMap's resolved set of character styles that
// themselves carry an enabled `w:vanish`). No special-casing between the two
// signals — a resolved-off direct `<w:vanish w:val="0"/>` does not override a
// matching rStyle, mirroring document.ts's own behaviour exactly (#650).
// `vanishCharStyleIds` defaults to an empty set so a caller that has none to
// offer (object-blob-edit.ts's rewriteFirstText before its own #650 wiring,
// #648's extract.ts) keeps compiling and behaving byte-for-byte unchanged.
// body-objects.ts's collectText threads the real set through on every call.
//
// EXPORTED (re-exported from body-objects.ts, its established public surface)
// so object-blob-edit.ts's `rewriteFirstText` applies the SAME rule when it
// writes an edit back. That walk's stated contract is to reach text
// "wherever capture read it from"; once capture started skipping vanish runs,
// a second, drifting copy of this predicate there would place edits into
// hidden runs and blank the visible ones. One definition, both directions
// (ADR-092).
export function hasRunVanish(
  node: ObjectBlobNode,
  vanishCharStyleIds: ReadonlySet<string> = new Set()
): boolean {
  if (tagOf(node) !== 'w:r') return false;
  const rPr = directChildrenByTag(node, 'w:rPr')[0];
  if (!rPr) return false;
  return resolveRunVanish(rPr, vanishCharStyleIds);
}

// The two OR'd vanish signals, split out of hasRunVanish purely to keep that
// function's cognitive complexity low — no behavior of its own. `getAttrVal`
// applied to the w:rStyle node's own `:@` attrs mirrors isOnOffEnabled's
// identical read of a w:vanish node's `:@` above.
function resolveRunVanish(rPr: ObjectBlobNode, vanishCharStyleIds: ReadonlySet<string>): boolean {
  if (directChildrenByTag(rPr, 'w:vanish').some(isOnOffEnabled)) return true;
  const rStyleNode = directChildrenByTag(rPr, 'w:rStyle')[0];
  const rStyle = rStyleNode ? getAttrVal(rStyleNode[':@']) : '';
  return rStyle !== '' && vanishCharStyleIds.has(rStyle);
}
