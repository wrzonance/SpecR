// Regenerated-styles.xml companion to a captured object blob's persisted
// `vanishCharStyleIds` (#650 task 6/10 investigation): ADR-072 decision 1
// re-emits a captured table/text-box's OOXML blob byte-for-byte, INCLUDING
// any interior run whose `w:rPr>w:rStyle` names a character style that was
// resolved vanish at capture time — but the generator never previously wrote
// a `w:styles` section defining custom character styles at all, so that
// referenced style id was silently ABSENT from the regenerated document.
// Reopening (or re-parsing) that regenerated file therefore resolved
// `vanishCharStyleIds` back to empty and the previously-hidden run surfaced
// as visible plain text — a real privacy regression discovered writing
// `body-object-round-trip.test.ts`'s "with vanishCharStyleIds present" case,
// fixed here rather than merely documented, since the data needed to fix it
// (`ObjectMeta.vanishCharStyleIds`, persisted per object) already exists.
//
// The fix only needs to reconstruct enough of the ORIGINAL character style
// definition for `styles.ts`'s own `characterStyleVanishIds` to resolve the
// SAME id back into `vanishCharStyleIds` on re-parse — a minimal
// `w:type="character"` style stub carrying an enabled `w:vanish`, keyed by
// the exact id the blob's `w:rStyle` already references. No other property
// of the original style (font, color, basedOn chain, …) is reconstructed:
// none of it affects the vanish resolution this module exists to restore,
// and reconstructing it would need the original styles.xml, which SpecR
// does not retain (out of scope here, same posture as this file's sibling
// `styles.ts`'s own documented font/spacing/indent/numbering-only scope).
import type { ICharacterStyleOptions } from 'docx';
import type { SpecNode, SpecTree } from '../ast/index.js';

function collectFromNodes(nodes: readonly SpecNode[], acc: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'object') {
      for (const id of node.meta.object?.vanishCharStyleIds ?? []) acc.add(id);
    }
    collectFromNodes(node.children, acc);
  }
}

/**
 * Every distinct character-style id referenced as vanish-resolved by ANY
 * captured object across `trees`, sorted for deterministic output (a
 * generated document's byte content must not depend on `Set` iteration
 * order). Empty when no captured object in any tree carries the field —
 * the overwhelmingly common case, and byte-identical to pre-#650 output.
 */
export function collectVanishCharacterStyleIds(trees: readonly SpecTree[]): readonly string[] {
  const ids = new Set<string>();
  for (const tree of trees) collectFromNodes(tree.parts, ids);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * Minimal `docx` character-style definitions for `styleIds` — one per id,
 * carrying only an enabled `w:vanish` (see this module's header for why
 * nothing else is reconstructed). `name` mirrors `id`: it is never read
 * back by SpecR's own parser (`styleId`, not `name`, is the correlation
 * key), only shown to a human opening the file in Word.
 */
export function vanishCharacterStyleOptions(
  styleIds: readonly string[]
): readonly ICharacterStyleOptions[] {
  return styleIds.map((id) => ({ id, name: id, run: { vanish: true } }));
}
