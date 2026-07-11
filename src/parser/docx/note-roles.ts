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
 * Deliberately does NOT consult Signal 1 (numbering.xml) or Signal 2 (style chain) —
 * note-role classification runs on raw paragraph text ahead of the 5-signal engine,
 * so numbering/style facts are not yet available to it.
 *
 * KNOWN AMBIGUITY: a heading whose PART/article status is carried entirely by
 * numbering.xml or a style (no literal "PART n" / "N.N" text — e.g. a bare
 * "GENERAL" title under a spec-shaped numId) is invisible to this gate and will not
 * force-close an open note region. See note-roles.test.ts for the pinned case.
 */
function isHeadingParagraph(para: DocxParagraph): boolean {
  if (isPartHeading(para.text)) return true;
  const match = matchTextSignal(para.text);
  return match !== null && (match.nodeType === 'part' || match.nodeType === 'article');
}

/**
 * Index-aligned with `paragraphs`. Maps each DocxParagraph to a NoteScanItem via its
 * raw text and heading gate, then delegates to the shared classifier. Pure function
 * of paragraph.text alone — safe to call twice on identical input, as
 * classifyWithOptionalProfile (index.ts, #317) already does for the profiled and
 * base inference passes.
 */
export function computeNoteRoles(paragraphs: readonly DocxParagraph[]): readonly NoteRole[] {
  const items: NoteScanItem[] = paragraphs.map((paragraph) => ({
    text: paragraph.text,
    isHeading: isHeadingParagraph(paragraph),
  }));
  return classifyNoteRoles(items);
}
