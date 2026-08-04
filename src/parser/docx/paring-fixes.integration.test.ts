import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../index.js';
import type { SpecNode } from '../../ast/types.js';

// Copyrighted manufacturer example — gitignored under docs/references/MANUFACTURER_*/*.docx,
// so this end-to-end test skips in CI and runs only where the file is present locally.
const FIXTURE = resolve('docs/references/MANUFACTURER_EXAMPLES/paring-fixes.docx');
const AVAILABLE = existsSync(FIXTURE);

function flatten(nodes: readonly SpecNode[]): SpecNode[] {
  return [...nodes, ...nodes.flatMap((n) => flatten(n.children))];
}

// Regression (#122): "Related Sections" lists 15 references that Word numbers 1..15.
// SpecR rendered them 5..20 with a blank row and a stray "]" because (a) leading
// specifier-note banners shifted the numbering (PR1: generator/markdown.ts) and
// (b) an empty numId=0 paragraph inherited the numbered style and became a phantom
// numbered node (PR2: inference.ts drops empty paragraphs). The lone "]" is kept —
// Word numbers it too (item 7).
describe.skipIf(!AVAILABLE)('paring-fixes.docx — Related Sections numbering (#122)', () => {
  it('numbers the references 1..15 with no empty/blank node', async () => {
    const { tree } = await parse(readFileSync(FIXTURE), 'paring-fixes.docx');

    const related = flatten(tree.parts).find((n) => n.text.includes('Related Sections'));
    expect(related, 'Related Sections heading not found').toBeDefined();

    const children = related?.children ?? [];
    const numbered = children.filter((n) => n.type !== 'note' && n.type !== 'continuation');

    // 14 real Section references + the retained "]" tailoring artifact = 15.
    expect(numbered).toHaveLength(15);
    // No empty paragraph survived ingestion as a numbered node.
    expect(numbered.every((n) => n.text.trim().length > 0)).toBe(true);
    // The leading specifier-note banners remain, as unnumbered note nodes. Before
    // da0c4656 ("feat(parser): wire note-role classification into inference.ts",
    // PR #461/#292) the pre-existing floor of 4 here included 2 accidental hits:
    // asterisk-rule rows (text: '*****') whose STNoteSpec style matched
    // isNoteParagraph's /note/i regex, so they were misclassified as note nodes
    // instead of being suppressed as rule delimiters. #292's role==='rule' check
    // now runs ahead of that style-based note check and correctly suppresses
    // them, so the genuine STNoteSpec notes here are exactly 2, not 4. Re-pinned
    // per #512/#471/#514 and ADR-086 — see ADR-086 for the full rationale.
    //
    // Pinned by identity, not by a floor: a `>= 2` floor would also pass the exact
    // pre-da0c4656 output (2 prose notes + 2 asterisk rows), so a regression that
    // resurrected the rule rows as notes would slip through it unnoticed.
    const notes = children.filter((n) => n.type === 'note');
    expect(notes).toHaveLength(2);
    expect(notes[0]?.text).toMatch(/^Include the Related Section references/);
    expect(notes[1]?.text).toMatch(/^The list below includes related sections/);
    // The rule rows are 85 asterisks wide in this fixture — none may survive as a note.
    expect(notes.some((n) => /^\*+$/.test(n.text.trim()))).toBe(false);
  });
});
