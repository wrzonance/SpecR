import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { pool } from '../db/index.js';
import { loadFiles } from './file-loader.js';

const PROJECT_ROOT = path.resolve(process.cwd());
const SEC_FIXTURE = path.join(PROJECT_ROOT, 'docs/references/UFGS/DIVISION_27/27_10_00.SEC');

afterAll(async () => {
  await pool.end();
});

describe('loadFiles() integration', () => {
  it('loads a .SEC file — rows appear in specs and paragraphs tables', async () => {
    const result = await loadFiles([SEC_FIXTURE]);

    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);

    const row = await pool.query<{ id: string; section: string }>(
      `SELECT id, section FROM specs WHERE section = '27 10 00' AND source = 'ufgs' LIMIT 1`
    );
    expect(row.rows[0]?.section).toBe('27 10 00');

    const paras = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM paragraphs WHERE spec_id = $1`,
      [row.rows[0]?.id]
    );
    expect(parseInt(paras.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
  });

  it('is idempotent — re-loading same file does not duplicate the spec row or paragraphs', async () => {
    await loadFiles([SEC_FIXTURE]);

    const specRow = await pool.query<{ id: string }>(
      `SELECT id FROM specs WHERE section = '27 10 00' AND source = 'ufgs' LIMIT 1`
    );
    const specId = specRow.rows[0]?.id;
    expect(specId).toBeDefined();

    const parasBefore = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM paragraphs WHERE spec_id = $1`,
      [specId]
    );
    const countBefore = parseInt(parasBefore.rows[0]?.count ?? '0', 10);
    expect(countBefore).toBeGreaterThan(0);

    // Second load — must not duplicate
    await loadFiles([SEC_FIXTURE]);

    const parasAfter = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM paragraphs WHERE spec_id = $1`,
      [specId]
    );
    const countAfter = parseInt(parasAfter.rows[0]?.count ?? '0', 10);
    expect(countAfter).toBe(countBefore);

    const specCount = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM specs WHERE section = '27 10 00' AND source = 'ufgs'`
    );
    expect(parseInt(specCount.rows[0]?.count ?? '0', 10)).toBe(1);
  });

  it('reports failure for non-existent file, continues processing remaining files', async () => {
    const result = await loadFiles(['/nonexistent/file.sec', SEC_FIXTURE]);

    expect(result.total).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.errors[0]?.file).toBe('/nonexistent/file.sec');
  });

  it('dryRun — parse succeeds, nothing written to DB for new spec', async () => {
    // Use 27_41_00.SEC (section "27 41 00") to test dryRun isolation
    const altFixture = path.join(PROJECT_ROOT, 'docs/references/UFGS/DIVISION_27/27_41_00.SEC');
    // Delete any pre-existing row to ensure clean state
    await pool.query(`DELETE FROM specs WHERE section = '27 41 00' AND source = 'ufgs'`);

    const result = await loadFiles([altFixture], { dryRun: true });

    expect(result.succeeded).toBe(1);

    const row = await pool.query(
      `SELECT id FROM specs WHERE section = '27 41 00' AND source = 'ufgs'`
    );
    expect(row.rows).toHaveLength(0);
  });

  const AGENCY_FIXTURE = path.join(
    PROJECT_ROOT,
    'docs/references/UFGS/DIVISION_01/01_32_01.00_10.SEC'
  );

  it('e2e: agency-suffixed corpus file loads with section intact', async () => {
    const result = await loadFiles([AGENCY_FIXTURE]);
    expect(result.succeeded).toBe(1);

    const row = await pool.query<{ section: string }>(
      `SELECT section FROM specs WHERE section = '01 32 01.00 10' AND source = 'ufgs' LIMIT 1`
    );
    expect(row.rows[0]?.section).toBe('01 32 01.00 10');
  });

  it('e2e: ref targeting an agency-suffixed section resolves by exact match', async () => {
    const { persistParsedSpec } = await import('../db/index.js');
    const target = await pool.query<{ id: string }>(
      `SELECT id FROM specs WHERE section = '01 32 01.00 10' AND source = 'ufgs' LIMIT 1`
    );
    expect(target.rows[0]?.id).toBeDefined();

    const sourceNodeId = '00000000-0000-4000-8000-00000000aaaa';
    const specId = await persistParsedSpec({
      tree: {
        id: '00000000-0000-4000-8000-00000000bbbb',
        section: '99 88 77',
        title: 'Ref Source',
        parts: [
          {
            id: sourceNodeId,
            type: 'part',
            text: 'See Section 01 32 01.00 10.',
            children: [],
            meta: { source: 'ufgs' },
          },
        ],
      },
      refs: [
        {
          sourceNodeId,
          targetType: 'section',
          targetSpecSection: '01 32 01.00 10',
          referenceText: 'See Section 01 32 01.00 10.',
        },
      ],
    });

    try {
      const refRow = await pool.query<{ target_spec_id: string | null }>(
        `SELECT target_spec_id FROM spec_references WHERE source_spec_id = $1`,
        [specId]
      );
      expect(refRow.rows[0]?.target_spec_id).toBe(target.rows[0]?.id);
    } finally {
      await pool.query(`DELETE FROM specs WHERE id = $1`, [specId]);
    }
  });

  it('e2e: catalog join + division filter — suffixed section listed in database for division 01', async () => {
    const { listSpecSections } = await import('../db/index.js');
    const sections = await listSpecSections('01');
    const entry = sections.find((s) => s.section === '01 32 01.00 10');
    // catalog row exists (pnpm seed) AND exact-equality join sees the loaded spec
    expect(entry).toBeDefined();
    expect(entry?.inDatabase).toBe(true);
  });
});
