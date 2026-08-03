// src/ast/adr-080-literal-term-bound.test.ts
//
// #541 task 5/6 — ADR-080's "Negative / trade-offs" section explicitly
// deferred a literal-term count/length bound ("no count or length bound...
// not needed to ship v1"). This ships now: LanguageRulesWriteSchema
// (MAX_LITERAL_TERM_LENGTH / MAX_LITERAL_TERMS) closes that deferral, and
// the O(terms × paragraphs) scan-cost concern the deferral cited is fixed by
// precompiling matchers once per category instead of once per (paragraph,
// term) pair. Nothing else re-reads docs/adr/080-language-lint-profile.md,
// so a stale ADR (still claiming "unbounded"/"deferred" after the bound
// shipped) would sit undetected forever without this pin. This test reads
// the ADR's own prose the same way header-footer-table-openapi.test.ts pins
// openapi.yaml prose — a plain readFileSync + string assertion, not a
// runtime behavior check.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ADR_PATH = resolve('docs/adr/080-language-lint-profile.md');

function negativeTradeOffsSection(adr: string): string {
  const start = adr.indexOf('**Negative / trade-offs**');
  const end = adr.indexOf('## Related');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      'docs/adr/080-language-lint-profile.md: could not locate the "Negative / trade-offs" ' +
        'section between its heading and "## Related" — ADR structure changed, update this test'
    );
  }
  return adr.slice(start, end);
}

describe('docs/adr/080-language-lint-profile.md — literal-term bound deferral is closed (#541)', () => {
  const adr = readFileSync(ADR_PATH, 'utf8');
  const negatives = negativeTradeOffsSection(adr);

  it('no longer claims literal terms have no count or length bound', () => {
    expect(
      negatives,
      'ADR-080 still claims literal terms have "no count or length bound" — update the ' +
        'Negative/trade-offs bullet now that LanguageRulesWriteSchema enforces one'
    ).not.toMatch(/no count or length bound/i);
  });

  it('no longer defers the bound as a "not needed to ship v1" follow-up', () => {
    expect(
      negatives,
      'ADR-080 still frames the literal-term bound as an unshipped future follow-up'
    ).not.toMatch(/not needed to ship v1/i);
  });

  it('records the closed bound values and the write-only enforcement mechanism', () => {
    expect(negatives, 'ADR-080 must name MAX_LITERAL_TERM_LENGTH').toMatch(
      /MAX_LITERAL_TERM_LENGTH/
    );
    expect(negatives, 'ADR-080 must name MAX_LITERAL_TERMS').toMatch(/MAX_LITERAL_TERMS/);
    expect(negatives, 'ADR-080 must record the 500 bound values').toMatch(/500/);
    expect(
      negatives,
      'ADR-080 must name LanguageRulesWriteSchema as the enforcement mechanism'
    ).toMatch(/LanguageRulesWriteSchema/);
    expect(
      negatives,
      'ADR-080 must cite the HeaderFooterCompositionWriteSchema/ADR-070 write-only-schema precedent'
    ).toMatch(/HeaderFooterCompositionWriteSchema/);
    expect(negatives, 'ADR-080 must cite ADR-070 by number').toMatch(/ADR-070/);
  });

  it('records the matcher-precompile fix that resolves the cited O(terms × paragraphs) cost', () => {
    expect(
      negatives,
      'ADR-080 must record that matcher construction is now precompiled once per category, ' +
        'not once per (paragraph, term) pair'
    ).toMatch(/precompil/i);
  });
});
