import type { SourceFacts, SourceColorFact } from '../ast/types.js';

// Strip a render-derived CSI "PART n -" prefix from a heading's text, leaving
// only the part name (e.g. "PART 3 - EXECUTION" → "EXECUTION", "PART 1 – GENERAL"
// → "GENERAL", "PART 2 PRODUCTS" → "PRODUCTS"). The "PART n -" label is
// reconstructed at render time (generator/markdown getLabel), so the canonical
// AST stores only the name — otherwise the label doubles to "PART 3 - PART 3 - …".
//
// Shared by every parser that emits PART headings (.SEC, text, DOCX): the same
// numbering can supply the prefix (bare-name text) or the author can bake it into
// the literal run text, and both must normalize to the same canonical name.
//
// Strip "PART n" and its separators down to the name. This MUST cover every input
// the PART classifiers accept — isPartHeading() (heuristics.ts) and the text/PDF
// PART_RE (signals.ts) both test /^PART\s+\d+/i on TRIMMED text — because whatever
// they route to a part node, the render-time "PART n -" label (generator/markdown
// getLabel) re-adds; any prefix left here doubles into "PART 1 - PART 1 …".
//
// Match: optional leading whitespace (the classifiers trim), "PART <digits>", any
// run of separators (whitespace / "." / ":" / hyphen / en-dash / em-dash), then
// REQUIRE a letter — the start of the name. Requiring a letter is what makes this
// safe: it strips a de-spaced "PART 1GENERAL" → "GENERAL" (lossy PDF/text) yet
// leaves a version-like "PART 1.0 …" intact (the char after the separators is a
// digit, not a letter) and a bare "PART 1" / "PARTITION 1" untouched (no letter
// follows / no whitespace after PART). No stray punctuation can survive the cut.
const PART_PREFIX = /^\s*PART\s+\d+[\s.:—–-]*(?=[a-z])/i;

export function stripPartPrefix(text: string): string {
  return text.replace(PART_PREFIX, '').trim();
}

/**
 * Strip the "PART n -" prefix and report how many leading characters were removed,
 * so a caller can rebase text-relative metadata (source facts). Returns null when
 * there is no prefix to strip, or when stripping would empty the text (a bare
 * "PART n" with no name) — in both cases the caller keeps the original text.
 */
export function planPartStrip(text: string): { text: string; removed: number } | null {
  const match = PART_PREFIX.exec(text);
  if (!match) return null;
  const stripped = text.replace(PART_PREFIX, '').trim();
  if (stripped.length === 0) return null;
  return { text: stripped, removed: match[0].length };
}

type Range = readonly [number, number];

// Shift a [start, end] range left by `removed`, clamped into [0, newLen]. Returns
// null when the range lies entirely within the stripped prefix. A point anchor
// (zero-length range, e.g. a w:commentReference) survives iff it sits at or after
// the cut; a span survives iff any of its extent remains after the cut.
function shiftRange(range: Range, removed: number, newLen: number): Range | null {
  const start = Math.min(Math.max(range[0] - removed, 0), newLen);
  const end = Math.min(Math.max(range[1] - removed, 0), newLen);
  if (range[0] === range[1]) return range[0] >= removed ? [start, end] : null;
  return end > start ? [start, end] : null;
}

function rebaseColor(
  color: SourceColorFact,
  removed: number,
  newLen: number
): SourceColorFact | null {
  const spans = color.spans
    .map((span) => shiftRange(span, removed, newLen))
    .filter((span): span is Range => span !== null);
  if (spans.length === 0) return null;
  const covered = spans.reduce((sum, [start, end]) => sum + (end - start), 0);
  return { color: color.color, coverage: newLen > 0 ? covered / newLen : 0, spans };
}

function nonEmpty<T>(items: readonly T[] | undefined): readonly T[] | undefined {
  return items && items.length > 0 ? items : undefined;
}

/**
 * Rebase a part heading's source-fact offsets after planPartStrip removed a leading
 * "PART n -" run (`removed` chars, leaving text of length `newLen`). Comment, color,
 * and choice-token anchors are shifted so they keep pointing at the right characters
 * of the now-shorter text; facts that lived entirely inside the stripped prefix are
 * dropped, and color coverage is recomputed against the new length. Non-positional
 * facts (banner, vanish) pass through. A no-op when `removed` is 0.
 */
export function rebaseSourceFacts(
  facts: SourceFacts,
  removed: number,
  newLen: number
): SourceFacts {
  if (removed <= 0) return facts;
  const comments = nonEmpty(
    facts.comments
      ?.map((comment) => ({ comment, anchor: shiftRange(comment.anchor, removed, newLen) }))
      .flatMap(({ comment, anchor }) => (anchor ? [{ ...comment, anchor }] : []))
  );
  const colors = nonEmpty(
    facts.colors
      ?.map((color) => rebaseColor(color, removed, newLen))
      .filter((color): color is SourceColorFact => color !== null)
  );
  const choiceTokens = nonEmpty(
    facts.choiceTokens
      ?.map((token) => ({ token, span: shiftRange(token.span, removed, newLen) }))
      .flatMap(({ token, span }) => (span ? [{ ...token, span }] : []))
  );
  // Rebuild without the three positional keys (so empties are omitted, not set to
  // undefined — exactOptionalPropertyTypes), preserving banner/vanish and any extras.
  const rest: Record<string, unknown> = { ...facts };
  delete rest.comments;
  delete rest.colors;
  delete rest.choiceTokens;
  return {
    ...rest,
    ...(comments ? { comments } : {}),
    ...(colors ? { colors } : {}),
    ...(choiceTokens ? { choiceTokens } : {}),
  };
}
