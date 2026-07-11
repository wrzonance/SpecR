// DOCX-specific adapter for the format-agnostic note-delimiter classifier (see
// src/lib/note-delimiters.ts). Deliberately a sibling of heuristics.ts, not folded
// into it — heuristics.ts's isDecorationSeparator suite must stay untouched by this
// change (#292).

import type { DocxParagraph, StyleMap } from './types.js';
import {
  isPartHeading,
  matchTextSignal,
  isSpecifierNote,
  isSpecifierNoteInstruction,
} from './heuristics.js';
import { classifyNoteRoles, type NoteRole, type NoteScanItem } from '../../lib/note-delimiters.js';

// Specifier notes are editorial metadata, not spec content: banner text in any
// decoration variant, the visible "reveal the hidden notes" instruction chrome, or
// a note-named paragraph style (name contains "note"). Footnote/endnote styles are
// document apparatus, not specifier notes.
export function isNoteParagraph(para: DocxParagraph, styleMap: StyleMap): boolean {
  if (isSpecifierNote(para.text)) return true;
  if (isSpecifierNoteInstruction(para.text)) return true;
  if (!para.styleId) return false;
  const style = styleMap.styles.get(para.styleId);
  const label = `${para.styleId} ${style?.name ?? ''}`;
  // exclusion targets Word's built-in FootnoteText/EndnoteText styles —
  // bare /foot|end/ would also exclude e.g. AppendixNote ("app-END-ix")
  return /note/i.test(label) && !/footnote|endnote/i.test(label);
}

/**
 * Text-pattern-only heading gate: true for a literal "PART n" prefix (isPartHeading)
 * or a Signal-4 text match that resolves to 'part' or 'article' (matchTextSignal).
 * Deliberately text-only — a heading force-close is a soft safety break, and keeping
 * it a pure text guess matches the format-agnostic classifier's own `isHeading`.
 *
 * A heading whose PART/article status is carried entirely by numbering/style (no
 * literal "PART n" / "N.N" text — e.g. a bare "PRODUCTS" title under a spec-shaped
 * numId, or a style-numbered list item) is invisible to THIS gate, but is NOT lost:
 * the injected `isStructural` predicate marks it structural, and a structural item
 * enclosed by an open region trips the classifier's drift guard
 * (NoteScanItem.isStructural), disengaging the asterisk convention for the document
 * rather than swallowing the heading. See note-roles.test.ts.
 */
function isHeadingParagraph(para: DocxParagraph): boolean {
  if (isPartHeading(para.text)) return true;
  const match = matchTextSignal(para.text);
  return match !== null && (match.nodeType === 'part' || match.nodeType === 'article');
}

/**
 * Index-aligned with `paragraphs`. Maps each DocxParagraph to a NoteScanItem via its
 * raw text, heading gate, and an injected structural predicate, then delegates to the
 * shared classifier.
 *
 * `isStructural` is injected rather than computed here because "carries its own
 * structural numbering" spans Signal 1 (live numId) AND Signal 2 (a style whose
 * resolved numPr lands on a real tier) — the latter needs the full NumberingMap +
 * StyleMap the classification driver owns and that inference.ts's trySignal2 already
 * resolves. Keeping it a caller-supplied predicate reuses that resolution verbatim
 * with no duplicated OOXML opt-out logic. Still a pure function of its inputs — safe
 * to call twice on identical input, as classifyWithOptionalProfile (index.ts, #317)
 * already does for the profiled and base inference passes.
 */
export function computeNoteRoles(
  paragraphs: readonly DocxParagraph[],
  isStructural: (para: DocxParagraph) => boolean
): readonly NoteRole[] {
  const items: NoteScanItem[] = paragraphs.map((paragraph) => ({
    text: paragraph.text,
    isHeading: isHeadingParagraph(paragraph),
    isStructural: isStructural(paragraph),
  }));
  return classifyNoteRoles(items);
}
