import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, DatabaseError } from '../index.js';
import { getStandardsRollup, recordStandardVerification } from './standards-read.js';
import { ProjectNotFoundError } from './derive.js';
import { LibraryNotFoundError } from './libraries.js';

const suffix = randomUUID().slice(0, 8);
const source = suffix; // specs.source is varchar(20); keep the label short
// Synthetic org so this file's registry writes never collide with real orgs or with
// other test files sharing the same standards table (the registry is global).
const ORG = `TSTA${suffix.toUpperCase()}`;
const specIds: string[] = [];
let projectId: string;
let libraryId: string;
let concrete: string; // 03 30 00 — cites `${ORG} C150` (x2) + `${ORG} C920`
let sealants: string; // 07 92 00 — cites `${ORG} C920`

async function insertSpec(section: string, title: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [section, title, `${source}_${section}`, libraryId]
  );
  const id = r.rows[0]!.id;
  specIds.push(id);
  return id;
}

async function insertStandardRef(specId: string, standardCode: string): Promise<void> {
  const p = await pool.query<{ id: string }>(
    `INSERT INTO paragraphs (spec_id, node_type, text, position) VALUES ($1,'pr1',$2,1) RETURNING id`,
    [specId, `cites ${standardCode}`]
  );
  await pool.query(
    `INSERT INTO spec_references (source_spec_id, source_paragraph_id, target_type, standard_code, reference_text)
     VALUES ($1,$2,'standard',$3,$4)`,
    [specId, p.rows[0]!.id, standardCode, standardCode]
  );
}

beforeAll(async () => {
  const lib = await pool.query<{ id: string }>(
    `INSERT INTO libraries (tier, name) VALUES ('company',$1) RETURNING id`,
    [`Std Lib ${suffix}`]
  );
  libraryId = lib.rows[0]!.id;
  const proj = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`Std Proj ${suffix}`]
  );
  projectId = proj.rows[0]!.id;

  concrete = await insertSpec('03 30 00', 'Cast-in-Place Concrete');
  sealants = await insertSpec('07 92 00', 'Joint Sealants');
  await insertStandardRef(concrete, `${ORG} C150`);
  await insertStandardRef(concrete, `${ORG} C150`);
  await insertStandardRef(concrete, `${ORG} C920`);
  await insertStandardRef(sealants, `${ORG} C920`);

  for (const [i, id] of specIds.entries()) {
    await pool.query(
      `INSERT INTO project_specs (project_id, spec_id, position) VALUES ($1,$2,$3)`,
      [projectId, id, i]
    );
  }
});

afterAll(async () => {
  await pool.query(`DELETE FROM standards WHERE org_code = $1`, [ORG]);
  if (projectId) await pool.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
  for (const id of specIds) await pool.query(`DELETE FROM specs WHERE id = $1`, [id]);
  if (libraryId) await pool.query(`DELETE FROM libraries WHERE id = $1`, [libraryId]);
  await pool.end();
});

describe('getStandardsRollup', () => {
  it('compiles distinct cited standards for a library with anchors to citing paragraphs', async () => {
    const rollup = await getStandardsRollup({ kind: 'library', id: libraryId });
    expect(rollup.scope).toEqual({ type: 'library', id: libraryId });
    const codes = rollup.standards.map((s) => `${s.orgCode} ${s.standardCode}`);
    expect(codes).toEqual([`${ORG} C150`, `${ORG} C920`]);
    const c150 = rollup.standards.find((s) => s.standardCode === 'C150')!;
    expect(c150.citationCount).toBe(2);
    expect(c150.citingSpecs).toEqual([{ specId: concrete, section: '03 30 00' }]);
    expect(c150.anchors).toHaveLength(2);
    const c920 = rollup.standards.find((s) => s.standardCode === 'C920')!;
    expect(c920.citingSpecs.map((s) => s.section)).toEqual(['03 30 00', '07 92 00']);
  });

  it('compiles the same standards for the project scope', async () => {
    const rollup = await getStandardsRollup({ kind: 'project', id: projectId });
    expect(rollup.standards.map((s) => `${s.orgCode} ${s.standardCode}`)).toEqual([
      `${ORG} C150`,
      `${ORG} C920`,
    ]);
  });

  it('throws for unknown scope ids', async () => {
    await expect(getStandardsRollup({ kind: 'project', id: randomUUID() })).rejects.toBeInstanceOf(
      ProjectNotFoundError
    );
    await expect(getStandardsRollup({ kind: 'library', id: randomUUID() })).rejects.toBeInstanceOf(
      LibraryNotFoundError
    );
  });
});

describe('recordStandardVerification + rollup round-trip', () => {
  it('records a verdict and reflects it in the next rollup, incl. a superseded finding', async () => {
    const rec = await recordStandardVerification({
      orgCode: ORG.toLowerCase(), // lower-case in → normalized to uppercase
      standardCode: 'C150',
      status: 'superseded',
      currentVersion: 'C150/C150M-22',
      sourceUrl: 'https://example.test/astm-c150',
    });
    expect(rec.orgCode).toBe(ORG);
    expect(rec.status).toBe('superseded');
    expect(rec.lastVerifiedAt).not.toBeNull();

    const rollup = await getStandardsRollup({ kind: 'library', id: libraryId });
    const c150 = rollup.standards.find((s) => s.standardCode === 'C150')!;
    expect(c150.registered).toBe(true);
    expect(c150.status).toBe('superseded');
    expect(c150.currentVersion).toBe('C150/C150M-22');
    expect(c150.lastVerifiedAt).toBe(rec.lastVerifiedAt);

    const finding = rollup.findings.find((f) => f.standardCode === 'C150');
    expect(finding?.type).toBe('standard_superseded');
    expect(finding?.citingSpecs).toEqual([{ specId: concrete, section: '03 30 00' }]);
    expect(rollup.summary.superseded).toBe(1);
  });

  it('upsert is idempotent on the (org, code) key and refreshes last_verified_at', async () => {
    const first = await recordStandardVerification({
      orgCode: ORG,
      standardCode: 'C920',
      status: 'current',
    });
    const second = await recordStandardVerification({
      orgCode: ORG,
      standardCode: 'C920',
      status: 'withdrawn',
    });
    expect(second.id).toBe(first.id); // same row, not a duplicate
    expect(second.status).toBe('withdrawn');
    expect(second.currentVersion).toBeNull(); // PUT-replace: omitted field reset
  });

  // A whitespace-only code trims to '' — the org-only key ADR-064 §2 reserves for
  // ambiguous citations. The guard rejects it before the INSERT ever runs.
  it('rejects a blank (whitespace-only) orgCode or standardCode before the upsert', async () => {
    await expect(
      recordStandardVerification({ orgCode: '   ', standardCode: 'C150' })
    ).rejects.toBeInstanceOf(DatabaseError);
    await expect(
      recordStandardVerification({ orgCode: ORG, standardCode: '   ' })
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});
