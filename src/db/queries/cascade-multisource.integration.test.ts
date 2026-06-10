import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { pool, removeSpecFromProject } from '../index.js';

// Regression for the broken-ref cascade in removeSpecFromProject: removing a
// spec must NOT mark broken a citation that resolved to a *surviving* spec which
// merely shares the removed spec's section number (same section, different
// source — a state the demo board explicitly supports). The cascade's
// section-string fallback is gated on target_spec_id IS NULL precisely so that
// resolved-to-a-survivor references are spared, while genuinely unresolved
// section-only references still break.

const PROJ = 'cccccccc-0000-0000-0000-0000000000f1';
const UFGS = 'cccccccc-0000-0000-0000-000000000001'; // section 07 92 00, removed
const ARCAT = 'cccccccc-0000-0000-0000-000000000002'; // section 07 92 00, survives
const CITER = 'cccccccc-0000-0000-0000-000000000003'; // cites 07 92 00
const PARA = 'cccccccc-0000-0000-0000-0000000000a1';
let resolvedRefId: string; // CITER -> 07 92 00, resolved to ARCAT (survivor)
let unresolvedRefId: string; // CITER -> 07 92 00, never resolved

beforeEach(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [PROJ]);
  await pool.query(`DELETE FROM specs WHERE source IN ('tc-ufgs','tc-arcat')`);
  await pool.query(
    `INSERT INTO specs (id, section, title, source) VALUES
       ($1, '07 92 00', 'Joint Sealants (UFGS)', 'tc-ufgs'),
       ($2, '07 92 00', 'Joint Sealants (ARCAT)', 'tc-arcat'),
       ($3, '09 29 00', 'Gypsum Board', 'tc-ufgs')`,
    [UFGS, ARCAT, CITER]
  );
  await pool.query(`INSERT INTO projects (id, name) VALUES ($1, 'Multi-source cascade')`, [PROJ]);
  await pool.query(
    `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,1),($1,$3,2),($1,$4,3)`,
    [PROJ, UFGS, ARCAT, CITER]
  );
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, NULL, 'pr1', 'Comply with Section 07 92 00.', 1)`,
    [PARA, CITER]
  );
  const resolved = await pool.query<{ id: string }>(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, target_spec_id, reference_text)
     VALUES ($1, $2, 'section', '07 92 00', $3, '07 92 00') RETURNING id`,
    [CITER, PARA, ARCAT]
  );
  resolvedRefId = resolved.rows[0]!.id;
  const unresolved = await pool.query<{ id: string }>(
    `INSERT INTO spec_references
       (source_spec_id, source_paragraph_id, target_type, target_spec_section, target_spec_id, reference_text)
     VALUES ($1, $2, 'section', '07 92 00', NULL, '07 92 00') RETURNING id`,
    [CITER, PARA]
  );
  unresolvedRefId = unresolved.rows[0]!.id;
});

afterEach(async () => {
  await pool.query(`DELETE FROM projects WHERE id = $1`, [PROJ]);
  await pool.query(`DELETE FROM specs WHERE source IN ('tc-ufgs','tc-arcat')`);
});

async function isBroken(refId: string): Promise<boolean> {
  const r = await pool.query<{ is_broken: boolean }>(
    'SELECT is_broken FROM spec_references WHERE id = $1',
    [refId]
  );
  return r.rows[0]!.is_broken;
}

describe('removeSpecFromProject broken-ref cascade — multi-source section', () => {
  it('spares a citation resolved to a surviving same-section spec', async () => {
    await removeSpecFromProject(PROJ, UFGS, pool);
    // ARCAT (section 07 92 00) is still loaded, so its citation must stay valid.
    expect(await isBroken(resolvedRefId)).toBe(false);
  });

  it('still breaks a genuinely unresolved citation of the removed section', async () => {
    await removeSpecFromProject(PROJ, UFGS, pool);
    expect(await isBroken(unresolvedRefId)).toBe(true);
  });
});
