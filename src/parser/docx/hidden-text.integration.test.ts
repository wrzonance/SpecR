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
    expect(all.some((node) => /^\*{5,}$/.test(node.text.trim()))).toBe(false);
    expect(tree.hiddenTables?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(tree.warnings?.some((warning) => warning.type === 'table-content-skipped')).toBe(true);
  });
});
