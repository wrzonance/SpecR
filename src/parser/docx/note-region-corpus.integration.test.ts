import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, globSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { parseDocx } from './index.js';
import { renderMarkdown } from '../../generator/markdown.js';

// Corpus-wide guard for asterisk-rule note regions (#292): a paired (or
// heading-closed) run of asterisk-only rule rows must never survive into rendered
// output — every rule row is suppressed as a pure delimiter, and the prose it
// encloses renders as `> **[NOTE]**`, not as raw text flanked by asterisk walls.
//
// The current ARCAT/MANUFACTURER_CPI corpus does not happen to contain this
// pattern (verified during #292 by scanning every fixture's raw document.xml for a
// paragraph whose full text is 5-or-more asterisks and nothing else — zero hits).
// The synthetic end-to-end pin for the actual suppress+note-tag behavior lives in
// index.test.ts's makeDocx() case, verified RED against the pre-wiring inference.ts.
// This sweep is forward-looking, matching corpus-parts.integration.test.ts's
// structural sweep: it starts protecting the instant a rule-row fixture is added,
// and guards every fixture we do have against a future regression that reopens the
// leak (e.g. an isRuleRow/isDecorationSeparator ordering change).
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
      if (INVALID.has(name)) continue;

      it(`${name}: no bare rule-row line (5+ asterisks) survives to render`, async () => {
        const tree = await parseDocx(readFileSync(file));
        const render = renderMarkdown(tree);
        const ruleRows = render.split('\n').filter((line) => /^\*{5,}$/.test(line.trim()));
        expect(ruleRows).toEqual([]);
      });
    }
  }
);
