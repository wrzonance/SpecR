import { describe, it, expect } from 'vitest';
import { parse } from './index.js';

// A minimal SpecsIntact .SEC document with two PART-1 articles: one standard
// (REFERENCES → references) and one non-standard (no role). The real .SEC
// grammar nests articles as <SPT><TTL>…</TTL></SPT> inside <PRT> (see
// src/parser/sec/index.test.ts WITH_PARTS). Exercises the parse chokepoint
// end-to-end without binary fixtures.
const SEC = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 09 91 26</SCN>
  <STL>INTERIOR PAINTING</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>REFERENCES</TTL>
      <TXT>The publications listed below form a part of this specification.</TXT>
    </SPT>
    <SPT>
      <TTL>SYSTEM DESCRIPTION</TTL>
      <TXT>Describes the painting system.</TXT>
    </SPT>
  </PRT>
</SEC>`;

describe('parse() tags article roles on the .SEC path', () => {
  it('sets meta.articleRole on the REFERENCES article, none on the unknown one', async () => {
    const { tree } = await parse(Buffer.from(SEC), 'test.sec');
    const articles = tree.parts.flatMap((p) => p.children).filter((n) => n.type === 'article');
    const refs = articles.find((a) => /REFERENCES/i.test(a.text));
    const other = articles.find((a) => /SYSTEM/i.test(a.text));
    expect(refs?.meta.articleRole).toBe('references');
    expect(other?.meta.articleRole).toBeUndefined();
  });
});
