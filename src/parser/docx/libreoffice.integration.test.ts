import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from './index.js';
import type { SpecNode } from '../../ast/types.js';

const FIXTURE_PATH = resolve('tests/fixtures/libreoffice/csi-spec-sample.docx');
// DOCX is committed — always available in CI.
const FIXTURES_AVAILABLE = existsSync(FIXTURE_PATH);

function allNodes(nodes: readonly SpecNode[]): SpecNode[] {
  return [...nodes, ...nodes.flatMap((n) => allNodes(n.children))];
}

describe.skipIf(!FIXTURES_AVAILABLE)('LibreOffice DOCX fixture parsing', () => {
  it('parses without throwing', async () => {
    const buffer = readFileSync(FIXTURE_PATH);
    await expect(parseDocx(buffer)).resolves.toBeDefined();
  });

  it('produces 3 PART nodes', async () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const tree = await parseDocx(buffer);
    expect(tree.parts.length).toBe(3);
  });

  it('each PART has at least 2 article children', async () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const tree = await parseDocx(buffer);
    for (const part of tree.parts) {
      const articles = part.children.filter((n) => n.type === 'article');
      expect(articles.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('has pr1 nodes (A. paragraphs classified correctly)', async () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const tree = await parseDocx(buffer);
    const nodes = allNodes(tree.parts);
    const pr1Nodes = nodes.filter((n) => n.type === 'pr1');
    expect(pr1Nodes.length).toBeGreaterThan(0);
  });

  it('LibreOffice ol items not misclassified as part (Signal 1 vs Signal 4 conflict)', async () => {
    // KNOWN AMBIGUITY: LibreOffice exports <ol><li> items with numId > 0 and ilvl=0
    // (same ilvl as PART). Signal 1 now requires PART-heading text via isPartHeading guard, so
    // generic ordered-list items are not classified as 'part'. Signal 4 ("1. " pattern) handles
    // them correctly as pr2. If this test fails, the isPartHeading guard in inference.ts has
    // regressed or Signal 1 ilvl=0 handling has changed.
    const buffer = readFileSync(FIXTURE_PATH);
    const tree = await parseDocx(buffer);
    const nodes = allNodes(tree.parts);
    // ol list items start with "1. " — should never become 'part' nodes
    const wrongNodes = nodes.filter((n) => n.type === 'part' && /^\d+\.\s/.test(n.text));
    expect(wrongNodes).toHaveLength(0);
  });

  it('PART nodes have text matching PART N pattern', async () => {
    const buffer = readFileSync(FIXTURE_PATH);
    const tree = await parseDocx(buffer);
    for (const part of tree.parts) {
      expect(part.text).toMatch(/^PART\s+\d+/i);
    }
  });
});
