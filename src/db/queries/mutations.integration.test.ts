import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  pool,
  getSpecTree,
  deleteParagraph,
  updateParagraphText,
  deleteReference,
  deleteSpec,
} from '../index.js';

// Demo-edit mutations (Feature A: delete paragraph + contained reference;
// Feature B: edit paragraph then delete/keep references). These prove the
// deterministic, schema-driven cascades the mockup UI demonstrates.

const SPEC_A = 'dddddddd-0000-0000-0000-00000000000a'; // the spec being edited
const SPEC_B = 'dddddddd-0000-0000-0000-00000000000b'; // a spec cited by SPEC_A
const PART = 'dddddddd-0000-0000-0000-0000000000a1';
const ART = 'dddddddd-0000-0000-0000-0000000000a2';
const PARA1 = 'dddddddd-0000-0000-0000-0000000000a3'; // contains the citation to 09 22 00
const PARA2 = 'dddddddd-0000-0000-0000-0000000000a4'; // contains a citation to a standard

let ref1Id: string; // PARA1 -> section 09 22 00 (resolved to SPEC_B)
let ref2Id: string; // PARA2 -> standard ASTM C840

async function insertPara(
  id: string,
  parentId: string | null,
  nodeType: string,
  text: string,
  position: number
): Promise<void> {
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, SPEC_A, parentId, nodeType, text, position]
  );
}

async function insertRef(
  paragraphId: string,
  targetType: 'section' | 'standard',
  targetSection: string | null,
  targetSpecId: string | null,
  standardCode: string | null,
  referenceText: string
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type,
        target_spec_section, target_spec_id, standard_code, reference_text)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [SPEC_A, paragraphId, targetType, targetSection, targetSpecId, standardCode, referenceText]
  );
  return res.rows[0]!.id;
}

beforeEach(async () => {
  // Wipe any leftover from a crashed run, by id and by (section, source).
  await pool.query(`DELETE FROM specs WHERE id = ANY($1) OR source = 'test-mut'`, [
    [SPEC_A, SPEC_B],
  ]);
  await pool.query(
    `INSERT INTO specs (id, section, title, source, library_id) VALUES
       ($1, '09 29 00', 'Gypsum Board', 'test-mut', (SELECT id FROM libraries WHERE name = 'UFGS Reference')),
       ($2, '09 22 00', 'Supports for Plaster', 'test-mut', (SELECT id FROM libraries WHERE name = 'UFGS Reference'))`,
    [SPEC_A, SPEC_B]
  );
  await insertPara(PART, null, 'part', 'GENERAL', 1);
  await insertPara(ART, PART, 'article', 'REFERENCES', 1);
  await insertPara(PARA1, ART, 'pr1', 'Comply with Section 09 22 00 for framing.', 1);
  await insertPara(PARA2, ART, 'pr1', 'Install per ASTM C840 requirements.', 2);
  ref1Id = await insertRef(PARA1, 'section', '09 22 00', SPEC_B, null, '09 22 00');
  ref2Id = await insertRef(PARA2, 'standard', null, null, 'ASTM C840', 'ASTM C840');
});

afterEach(async () => {
  await pool.query(`DELETE FROM specs WHERE id = ANY($1)`, [[SPEC_A, SPEC_B]]);
});

describe('getSpecTree references (id + sourceParagraphId)', () => {
  it('exposes each reference id and the paragraph that contains it', async () => {
    const result = await getSpecTree(SPEC_A);
    expect(result).not.toBeNull();
    const sectionRef = result!.references.find((r) => r.targetSection === '09 22 00');
    expect(sectionRef).toBeDefined();
    expect(sectionRef!.id).toBe(ref1Id);
    expect(sectionRef!.sourceParagraphId).toBe(PARA1);
    expect(sectionRef!.targetSpecId).toBe(SPEC_B);
    expect(sectionRef!.isResolved).toBe(true);
  });
});

describe('deleteParagraph', () => {
  it('removes the paragraph AND cascades to the reference it contains', async () => {
    const ok = await deleteParagraph(PARA1, SPEC_A);
    expect(ok).toBe(true);

    const tree = await getSpecTree(SPEC_A);
    const ids = collectIds(tree!.tree.parts);
    expect(ids).not.toContain(PARA1);
    expect(ids).toContain(PARA2); // sibling untouched
    // The contained reference is gone via ON DELETE CASCADE...
    expect(tree!.references.some((r) => r.id === ref1Id)).toBe(false);
    // ...but the unrelated reference in PARA2 survives.
    expect(tree!.references.some((r) => r.id === ref2Id)).toBe(true);
  });

  it('cascades to descendant paragraphs and their references', async () => {
    const ok = await deleteParagraph(ART, SPEC_A);
    expect(ok).toBe(true);
    const tree = await getSpecTree(SPEC_A);
    const ids = collectIds(tree!.tree.parts);
    expect(ids).not.toContain(ART);
    expect(ids).not.toContain(PARA1);
    expect(ids).not.toContain(PARA2);
    expect(tree!.references).toHaveLength(0);
  });

  it('will not delete a paragraph through the wrong spec id', async () => {
    const ok = await deleteParagraph(PARA1, SPEC_B);
    expect(ok).toBe(false);
    const tree = await getSpecTree(SPEC_A);
    expect(collectIds(tree!.tree.parts)).toContain(PARA1);
  });

  it('returns false for an unknown paragraph id', async () => {
    const ok = await deleteParagraph('00000000-0000-0000-0000-000000000000', SPEC_A);
    expect(ok).toBe(false);
  });
});

describe('updateParagraphText', () => {
  it('replaces the body text and leaves references untouched', async () => {
    const result = await updateParagraphText(SPEC_A, PARA1, 'Comply with framing requirements.');
    expect(result.status).toBe('updated');
    if (result.status !== 'updated') throw new Error('expected updated status');
    expect(result.node.id).toBe(PARA1);
    expect(result.node.text).toBe('Comply with framing requirements.');

    const tree = await getSpecTree(SPEC_A);
    const para = findNode(tree!.tree.parts, PARA1);
    expect(para!.text).toBe('Comply with framing requirements.');
    // The reference row still exists — the caller deletes it explicitly.
    expect(tree!.references.some((r) => r.id === ref1Id)).toBe(true);
  });

  it('reports wrong-spec when the paragraph belongs to another spec', async () => {
    const result = await updateParagraphText(SPEC_B, PARA1, 'nope');
    expect(result.status).toBe('wrong-spec');
  });
});

describe('deleteReference', () => {
  it('removes one reference and leaves the paragraph and sibling refs intact', async () => {
    const ok = await deleteReference(ref1Id, SPEC_A);
    expect(ok).toBe(true);
    const tree = await getSpecTree(SPEC_A);
    expect(tree!.references.some((r) => r.id === ref1Id)).toBe(false);
    expect(tree!.references.some((r) => r.id === ref2Id)).toBe(true);
    // The containing paragraph survives a reference-only delete.
    expect(collectIds(tree!.tree.parts)).toContain(PARA1);
  });

  it('returns false when the reference belongs to a different spec', async () => {
    const ok = await deleteReference(ref1Id, SPEC_B);
    expect(ok).toBe(false);
  });
});

describe('deleteSpec', () => {
  it('deletes the target spec and nulls inbound references (SET NULL)', async () => {
    const ok = await deleteSpec(SPEC_B);
    expect(ok).toBe(true);
    expect(await getSpecTree(SPEC_B)).toBeNull();

    // SPEC_A's citation of 09 22 00 loses its resolved target (ON DELETE SET NULL),
    // so it now reads as unresolved — the citation row itself remains.
    const tree = await getSpecTree(SPEC_A);
    const ref = tree!.references.find((r) => r.id === ref1Id);
    expect(ref).toBeDefined();
    expect(ref!.targetSpecId).toBeNull();
    expect(ref!.isResolved).toBe(false);
  });

  it('returns false for an unknown spec id', async () => {
    const ok = await deleteSpec('00000000-0000-0000-0000-000000000000');
    expect(ok).toBe(false);
  });
});

interface TreeNode {
  readonly id: string;
  readonly text: string;
  readonly children: readonly TreeNode[];
}

function collectIds(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((n) => [n.id, ...collectIds(n.children)]);
}

function findNode(nodes: readonly TreeNode[], id: string): TreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}
