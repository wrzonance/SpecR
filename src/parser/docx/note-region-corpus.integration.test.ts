import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, globSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import JSZip from 'jszip';
import { parseDocx } from './index.js';
import { renderMarkdown } from '../../generator/markdown.js';

// ─── Drift-guard fixtures (#292) ────────────────────────────────────────────────
//
// The #430 hand-authored corpus numbers PARTs manually and walls its specifier notes
// with asterisk rules that are frequently UNPAIRED — a closing wall gets merged into
// the note prose ("…Waste Management *****") or dropped. The naive open/close toggle
// then drifts out of phase and swallows real structure (PART headings, articles,
// manufacturer lists) as notes. The classifier's drift guard (note-delimiters.ts)
// detects a numbered structural item enclosed by an open region and DISENGAGES the
// asterisk convention for the whole document, so these files parse exactly as they
// did before the feature existed. Each pin is named for the part-count regression it
// guards; the assertion is the module boundary (parseDocx → 3 visible PARTs, no PART
// heading rendered as a [NOTE]).
const DRIFT_REGRESSIONS: ReadonlyArray<{
  file: string;
  symptom: string;
  swallowed: readonly string[];
}> = [
  {
    file: 'more-parsing-examples-works.docx',
    symptom: 'unpaired asterisk wall must not swallow PART heading — 3→1',
    swallowed: [
      'PRODUCTS',
      'ACCEPTABLE MANUFACTURERS – CABLES',
      'Kerite (Marmon Utility)',
      'Southwire',
    ],
  },
  {
    file: 'more-broken-parsing.docx',
    symptom: 'drifted region must not swallow every PART — 3→0',
    swallowed: ['GENERAL', 'PRODUCTS', 'EXECUTION'],
  },
  {
    file: 'even-more-parsing-breaking.docx',
    symptom: 'drifted region must not swallow EXECUTION — 3→2',
    swallowed: ['EXECUTION'],
  },
  {
    file: 'even-more-parsing-breaking-dff.docx',
    symptom: 'drifted region must not swallow EXECUTION — 3→2',
    swallowed: ['EXECUTION'],
  },
];

const DRIFT_DISENGAGED = new Set(DRIFT_REGRESSIONS.map((r) => r.file));

// Body objects (#300, ADR-072): a captured table/text-box's cell text is a faithful,
// out-of-band, VERBATIM mirror of the original document — never re-run through the
// paragraph-tier note-region engine (that's a Signal-classification concern the object
// capture pass sits entirely outside of, ADR-072 decision 8). hidden-text-test.docx has
// a real submittal-matrix table whose cells include an asterisk-rule row a spec author
// used as in-cell visual separation; #300 now renders that table's content (previously
// dropped silently — see the `table-content-skipped` warning it used to only count), so
// the row surfaces verbatim, same as any other cell. Suppressing it would mean silently
// reinterpreting locked table content, the opposite of this file's own no-silent-loss
// contract (see markdown.test.ts:423 for the unit-level pin of this exact fallback
// rendering). Excluded from the sweep below for that reason; its 16 paragraph-tier
// `[NOTE]` blocks (unrelated to the table) are unaffected and untouched by #300 —
// verified directly against origin/main's parse of the same file.
const OBJECT_VERBATIM_TABLE = new Set(['hidden-text-test.docx']);

// Corpus-wide guard for asterisk-rule note regions (#292): a BARE asterisk-only rule
// row (5+ '*' and nothing else) must never survive as its own line into rendered
// output. Where the asterisk convention ENGAGES, each rule row is suppressed as a
// pure delimiter and the prose it encloses renders as `> **[NOTE]**`.
//
// The DRIFT_DISENGAGED files are excluded: their unpaired/merged walls trip the drift
// guard, which deliberately falls back to the pre-feature parse — INCLUDING any stray
// bare wall base already rendered (asserting otherwise would force the feature back on
// and re-open the part-loss regression). Their structural integrity is pinned by the
// drift-guard block below instead. The #430 MANUFACTURER_EXAMPLES fixture that still
// engages the convention at the PARAGRAPH tier (paring-fixes) keeps this sweep live.
const REF = resolve('docs/references');
const CORPUS = existsSync(REF)
  ? globSync(`${REF}/**/*.docx`).sort((a, b) => a.localeCompare(b))
  : [];

// 11_53_00nle.docx is a corrupt/non-docx download (see corpus-parts.integration.test.ts)
// and must be rejected before it reaches renderMarkdown at all.
const INVALID = new Set(['11_53_00nle.docx']);

describe.skipIf(CORPUS.length === 0)(
  'DOCX corpus — asterisk rule rows never leak into rendered markdown',
  () => {
    for (const file of CORPUS) {
      const name = basename(file);
      if (INVALID.has(name) || DRIFT_DISENGAGED.has(name) || OBJECT_VERBATIM_TABLE.has(name)) {
        continue;
      }

      it(`${name}: no bare rule-row line (5+ asterisks) survives to render`, async () => {
        const tree = await parseDocx(readFileSync(file));
        const render = renderMarkdown(tree);
        const ruleRows = render.split('\n').filter((line) => /^\*{5,}$/.test(line.trim()));
        expect(ruleRows).toEqual([]);
      });
    }
  }
);

// ─── Drift-guard regression pins (#292) ─────────────────────────────────────────

const NOTE_PREFIX = '> **[NOTE]**';

describe('DOCX note-region drift guard — hand-authored unpaired asterisk walls (#292)', () => {
  for (const { file, symptom, swallowed } of DRIFT_REGRESSIONS) {
    const path = resolve('docs/references/MANUFACTURER_EXAMPLES', file);
    it.skipIf(!existsSync(path))(`note-region: ${file} — ${symptom}`, async () => {
      const tree = await parseDocx(readFileSync(path));
      const visibleParts = tree.parts.filter((n) => n.type === 'part' && n.meta.vanish !== true);
      expect(visibleParts.map((p) => p.text)).toEqual(['GENERAL', 'PRODUCTS', 'EXECUTION']);

      // None of the structural headings/list items that the drift used to swallow may
      // render as a note line.
      const noteLines = renderMarkdown(tree)
        .split('\n')
        .filter((line) => line.trimStart().startsWith(NOTE_PREFIX));
      for (const text of swallowed) {
        expect(noteLines.some((line) => line.includes(text))).toBe(false);
      }
    });
  }
});

// ─── Object-table verbatim rendering pin (#300, ADR-072) ───────────────────────
//
// hidden-text-test.docx is excluded from the blanket sweep above (see
// OBJECT_VERBATIM_TABLE) — this pins exactly why that exclusion is safe rather than
// a silent coverage hole: the file's PARAGRAPH-tier asterisk-rule note regions still
// suppress correctly (unaffected by #300), while its body TABLE's asterisk-rule cell
// renders verbatim as locked, out-of-band object content — the two tiers never cross.
describe('DOCX object-table verbatim rendering — hidden-text-test.docx (#300, ADR-072)', () => {
  const path = resolve('docs/references/MANUFACTURER_EXAMPLES', 'hidden-text-test.docx');

  it.skipIf(!existsSync(path))(
    'paragraph-tier note regions still suppress; the body table renders its asterisk-rule cell verbatim',
    async () => {
      const tree = await parseDocx(readFileSync(path));
      const render = renderMarkdown(tree);

      // Exact counts, not just > 0: a > 0 floor would still pass if paragraph-tier
      // `*****` regions REGRESSED and leaked into the render (they would only ADD
      // rows), hiding the very symptom this excluded-fixture pin exists to catch.
      // hidden-text-test.docx renders exactly 16 note blocks; its body table
      // contributes exactly 4 asterisk-rule rows (verbatim, as INDENT-prefixed
      // object-fallback lines) and the paragraph-tier rules contribute none.
      const noteLines = render
        .split('\n')
        .filter((line) => line.trimStart().startsWith(NOTE_PREFIX));
      expect(noteLines.length).toBe(16);

      const ruleRows = render.split('\n').filter((line) => /\*{5,}/.test(line));
      expect(ruleRows.length).toBe(4);
      // Every rule row is object-table fallback content — an INDENT-prefixed
      // (three-space, matching markdown.ts's INDENT) line — never a bare, leaked
      // paragraph line.
      for (const row of ruleRows) {
        expect(row.startsWith('   ')).toBe(true);
      }
    }
  );
});

// ─── Synthetic fixture — the renderMarkdown boundary always has one real case ────

const MINIMAL_STYLES = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>`;

const STRUCTURED_NUMBERING = `<?xml version="1.0" encoding="UTF-8"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:multiLevelType w:val="multilevel"/>
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="PART %1"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const RULE_ROW_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>PART 1 – GENERAL</w:t></w:r></w:p>
    <w:p><w:r><w:t>*****</w:t></w:r></w:p>
    <w:p><w:r><w:t>Delete items below not applicable to this project.</w:t></w:r></w:p>
    <w:p><w:r><w:t>*****</w:t></w:r></w:p>
    <w:p><w:r><w:t>Ordinary body text after the region closes.</w:t></w:r></w:p>
  </w:body>
</w:document>`;

async function makeRuleRowDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('word/styles.xml', MINIMAL_STYLES);
  zip.file('word/document.xml', RULE_ROW_DOC);
  zip.file('word/numbering.xml', STRUCTURED_NUMBERING);
  return zip.generateAsync({ type: 'nodebuffer' });
}

// Runs unconditionally (not gated on docs/references / CORPUS.length) so this
// invariant is never silently vacuous: a paired asterisk-rule note region must
// never survive as raw text into rendered markdown, independent of whether the
// current corpus happens to contain the pattern.
describe('synthetic fixture — asterisk rule rows never leak into rendered markdown', () => {
  it('a paired rule-row region: no bare rule-row line survives, enclosed prose renders as [NOTE]', async () => {
    const tree = await parseDocx(await makeRuleRowDocx());
    const render = renderMarkdown(tree);
    const ruleRows = render.split('\n').filter((line) => /^\*{5,}$/.test(line.trim()));
    expect(ruleRows).toEqual([]);
    expect(render).toContain('[NOTE]');
    expect(render).toContain('Ordinary body text after the region closes.');
  });
});
