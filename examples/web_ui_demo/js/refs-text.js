// Section-number text analysis shared by the sheet renderer (tree.js) and the
// WYSIWYG inline editor (inline-edit.js): the citation matcher, its
// canonicalizer, and the occurrence-count diff that detects citations an edit
// removed. Pure text — no DOM.

// Matches CSI section numbers, including UFGS agency variants (01 32 01.00 10).
// Whitespace-tolerant: Word text routinely separates the digit groups with
// non-breaking spaces or doubled spaces (\s covers   in JS). The server
// extractor normalizes those at ingest, so the stored targetSection has single
// spaces — matched text must be normalized the same way before lookups.
// Two tiers, mirroring the server (lib/section-number.ts): the canonical
// three-group form is matched anywhere in prose; the mis-grouped DISPLAY variants
// a spec author (or OCR) can produce — spaced-compact "01 8813", compact "271123",
// dotted "01.88.13" — are admitted ONLY right after a "SECTION" keyword, the same
// strong context the server trusts. Without that gate a bare 6-digit number in
// prose would read as a phantom section. normalizeSection() re-groups whatever
// matched into the canonical shape, and the statusFor() gate in linkifyText means
// only numbers that resolve to a real section are ever linked or re-rendered.
export const SECTION_PATTERN =
  /(?<![\d.])(?:\d{2}\s+\d{2}\s+\d{2}(?:\.\d{2}(?!\d)(?:[^\S\r\n]+\d{2}(?!\d))?)?|(?<=\bSECTION\s{1,4})(?:\d{2}\s+\d{4}|\d{6}|\d{2}\.\d{2}\.\d{2})(?:\.\d{2}(?!\d))?(?:[^\S\r\n]+\d{2}(?!\d))?)(?!\.?\d)/gi;

// Canonicalize a matched section number to the expanded CSI shape
// "NN NN NN(.NN)( NN)": collapse whitespace, then re-group the strong-context
// display variants (spaced-compact / compact / dotted) so both the status lookup
// and the rendered label use the canonical form the server stores. An already
// canonical value (or anything unrecognized) is returned whitespace-collapsed.
export function normalizeSection(text) {
  const s = text.replace(/\s+/g, ' ').trim();
  if (/^\d{2} \d{2} \d{2}(?:\.\d{2})?(?: \d{2})?$/.test(s)) return s;
  let m;
  if ((m = /^(\d{2}) (\d{2})(\d{2})((?:\.\d{2})?(?: \d{2})?)$/.exec(s)))
    return `${m[1]} ${m[2]} ${m[3]}${m[4]}`;
  if ((m = /^(\d{2})(\d{2})(\d{2})((?:\.\d{2})?(?: \d{2})?)$/.exec(s)))
    return `${m[1]} ${m[2]} ${m[3]}${m[4]}`;
  if ((m = /^(\d{2})\.(\d{2})\.(\d{2})((?:\.\d{2})?(?: \d{2})?)$/.exec(s)))
    return `${m[1]} ${m[2]} ${m[3]}${m[4]}`;
  return s;
}

// Every citation match in a block of text, with the verbatim slice preserved —
// the WYSIWYG editor must reconstruct the paragraph byte-for-byte around the
// non-editable chips, so the raw matched text (not the display form) is kept.
export function sectionMatches(text) {
  const matches = [];
  for (const match of text.matchAll(SECTION_PATTERN)) {
    matches.push({
      section: normalizeSection(match[0]),
      raw: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return matches;
}

// How many times each normalized section number appears in a block of text.
export function sectionCounts(text) {
  const counts = new Map();
  for (const { section } of sectionMatches(text)) {
    counts.set(section, (counts.get(section) ?? 0) + 1);
  }
  return counts;
}

// References this edit removed. Compares per-section OCCURRENCE counts (not mere
// presence) so deleting ONE of two identical citations in a paragraph is still
// detected — set membership can't express that delta. Only references whose
// number actually appeared in the original body can be judged from text alone.
export function removedReferences(originalText, newText, paraRefs) {
  const before = sectionCounts(originalText);
  const after = sectionCounts(newText);
  const bySection = new Map();
  for (const ref of paraRefs) {
    if (!ref.targetSection) continue;
    bySection.set(ref.targetSection, [...(bySection.get(ref.targetSection) ?? []), ref]);
  }
  const removed = [];
  for (const [section, refs] of bySection) {
    const delta = (before.get(section) ?? 0) - (after.get(section) ?? 0);
    if (delta > 0) removed.push(...refs.slice(0, delta));
  }
  return removed;
}
