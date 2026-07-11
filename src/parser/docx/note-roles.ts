// DOCX-specific adapter for the format-agnostic note-delimiter classifier (see
// src/lib/note-delimiters.ts). Deliberately a sibling of heuristics.ts, not folded
// into it — heuristics.ts's isDecorationSeparator suite must stay untouched by this
// change (#292).

import type { DocxParagraph } from './types.js';
import { isPartHeading, matchTextSignal } from './heuristics.js';
import { classifyNoteRoles, type NoteRole, type NoteScanItem } from '../../lib/note-delimiters.js';

/**
 * Text-pattern-only heading gate: true for a literal "PART n" prefix (isPartHeading)
 * or a Signal-4 text match that resolves to 'part' or 'article' (matchTextSignal).
 * Deliberately text-only — a heading force-close is a soft safety break, and keeping
 * it a pure text guess matches the format-agnostic classifier's own `isHeading`.
 *
 * A heading whose PART/article status is carried entirely by numbering.xml (no
 * literal "PART n" / "N.N" text — e.g. a bare "PRODUCTS" title under a spec-shaped
 * numId) is invisible to THIS gate, but is NOT lost: hasStructuralNumbering marks it
 * structural, and a structural item enclosed by an open region trips the classifier's
 * drift guard (NoteScanItem.isStructural), disengaging the asterisk convention for
 * the document rather than swallowing the heading. See note-roles.test.ts.
 */
function isHeadingParagraph(para: DocxParagraph): boolean {
  if (isPartHeading(para.text)) return true;
  const match = matchTextSignal(para.text);
  return match !== null && (match.nodeType === 'part' || match.nodeType === 'article');
}

/**
 * Signal 1 (numbering.xml) presence: the paragraph carries its own live list
 * numbering. numId is the OOXML suppress sentinel at 0, so only a positive numId is
 * real structural numbering. This is the drift signal the classifier uses to detect
 * an out-of-phase asterisk region (see NoteScanItem.isStructural): the numbering-only
 * PART/article headings and numbered list items that a text-pattern heading gate
 * cannot see (a bare "PRODUCTS", a manufacturer name) are exactly the structural
 * content a merged/unpaired asterisk wall would otherwise swallow.
 */
function hasStructuralNumbering(para: DocxParagraph): boolean {
  return para.numId !== undefined && para.numId > 0;
}

/**
 * Index-aligned with `paragraphs`. Maps each DocxParagraph to a NoteScanItem via its
 * raw text, heading gate, and numbering signal, then delegates to the shared
 * classifier. Pure function of the paragraph's text/heading/numbering facts alone —
 * safe to call twice on identical input, as classifyWithOptionalProfile (index.ts,
 * #317) already does for the profiled and base inference passes.
 */
export function computeNoteRoles(paragraphs: readonly DocxParagraph[]): readonly NoteRole[] {
  const items: NoteScanItem[] = paragraphs.map((paragraph) => ({
    text: paragraph.text,
    isHeading: isHeadingParagraph(paragraph),
    isStructural: hasStructuralNumbering(paragraph),
  }));
  return classifyNoteRoles(items);
}
