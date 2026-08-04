import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SpecNode } from '../../ast/types.js';
import { parse } from '../index.js';

const FIXTURE = resolve('docs/references/MANUFACTURER_EXAMPLES/hidden-text-test.docx');

describe.runIf(existsSync(FIXTURE))('hidden-text-test.docx end-to-end (#294)', () => {
  it('keeps a clean hierarchy, strips asterisk walls, and retains hidden tables', async () => {
    const { tree } = await parse(readFileSync(FIXTURE), 'hidden-text-test.docx');
    const collect = (node: SpecNode): readonly SpecNode[] => [
      node,
      ...node.children.flatMap(collect),
    ];
    const all = tree.parts.flatMap(collect);

    expect(tree.parts.filter((node) => node.type === 'part')).toHaveLength(3);
    // #633 investigation (ADR-092): PARAGRAPH-tier asterisk-rule walls must
    // never survive — that's the paragraph-tier note-region engine's
    // suppression contract (ADR-086, classifyOne's role === 'rule' check).
    // `objectText` nodes are excluded from this check on purpose: they are a
    // captured table/text-box's interior text, which ADR-072 decision 14
    // (#300) already establishes is a VERBATIM, out-of-band mirror of the
    // source document, never re-run through paragraph-tier suppression. This
    // fixture's body table legitimately contributes 4 verbatim asterisk-rule
    // `objectText` cells — pinned directly by
    // note-region-corpus.integration.test.ts's own OBJECT_VERBATIM_TABLE-scoped
    // regression test for this same file. The original assertion here (no
    // bare-asterisk node anywhere, `objectText` included) never accounted for
    // that later ADR-072 decision; this is a test-scoping fix, not a change
    // to parser behavior.
    expect(
      all.some((node) => node.type !== 'objectText' && /^\*{5,}$/.test(node.text.trim()))
    ).toBe(false);
    expect(tree.hiddenTables?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(tree.warnings?.some((warning) => warning.type === 'table-content-skipped')).toBe(true);
  });
});
