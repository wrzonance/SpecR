import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from '../index.js';
import {
  recordParagraphHistory,
  resolveActorUserId,
  resolveHistoryContext,
  PARAGRAPH_HISTORY_OPS,
  SYSTEM_ACTOR_LABEL,
} from './paragraph-history.js';

// Namespace reserved by this file: labels 'ph-test-<suffix>-...' and specs/paragraphs created
// under a dedicated spec row per test run. Mirrors users.integration.test.ts /
// paragraph-insert.integration.test.ts conventions.
const suffix = randomUUID().slice(0, 8);
const label = (name: string): string => `ph-test-${suffix}-${name}`;

const specIds: string[] = [];

async function newSpec(section: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, 'arcat', (SELECT id FROM libraries WHERE name = 'Default Company Master'))
     RETURNING id`,
    [section, `Paragraph History Test ${section}`]
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error(`newSpec: no id for ${section}`);
  specIds.push(id);
  return id;
}

async function newParagraph(specId: string, text: string, position: number): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position)
     VALUES ($1, $2, NULL, 'pr1', $3, $4)`,
    [id, specId, text, position]
  );
  return id;
}

/** recordParagraphHistory/resolveHistoryContext are gate-free DB cores, transaction-managed
 *  by the caller — exercising them directly requires owning the transaction here (mirrors
 *  paragraph-insert.integration.test.ts's runInTransaction). */
async function runInTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function contentVersion(specId: string): Promise<number> {
  const res = await pool.query<{ content_version: number }>(
    'SELECT content_version FROM specs WHERE id = $1',
    [specId]
  );
  return res.rows[0]?.content_version ?? -1;
}

interface HistoryRow {
  readonly user_id: string | null;
  readonly content_version: number | null;
}

async function historyRow(paragraphId: string, version: number): Promise<HistoryRow | null> {
  const res = await pool.query<HistoryRow>(
    `SELECT user_id, content_version FROM paragraph_versions
     WHERE paragraph_id = $1 AND version = $2`,
    [paragraphId, version]
  );
  return res.rows[0] ?? null;
}

async function countHistoryRows(paragraphId: string, version: number): Promise<number> {
  const res = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM paragraph_versions WHERE paragraph_id = $1 AND version = $2`,
    [paragraphId, version]
  );
  return Number(res.rows[0]?.count ?? '0');
}

beforeAll(async () => {
  await newSpec('99 99 77');
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = ANY($1)', [specIds]);
  await pool.query(`DELETE FROM users WHERE label LIKE $1`, [`ph-test-${suffix}-%`]);
});

describe('recordParagraphHistory (integration)', () => {
  it('is idempotent on (paragraph_id, version): a retried write never duplicates the row', async () => {
    const specId = specIds[0];
    if (specId === undefined) throw new Error('missing fixture spec');
    const paragraphId = await newParagraph(specId, 'first text', 1);

    const write = async (text: string): Promise<void> => {
      await runInTransaction(async (client) => {
        const userId = await resolveActorUserId(client, label('idempotent'));
        await recordParagraphHistory(client, {
          paragraphId,
          specId,
          version: 1,
          text,
          nodeType: 'pr1',
          op: 'edit',
          contentVersion: 2,
          userId,
        });
      });
    };

    await write('first text');
    await write('a different text — must NOT overwrite the first snapshot');

    expect(await countHistoryRows(paragraphId, 1)).toBe(1);
    const res = await pool.query<{ text: string }>(
      'SELECT text FROM paragraph_versions WHERE paragraph_id = $1 AND version = 1',
      [paragraphId]
    );
    expect(res.rows[0]?.text).toBe('first text');
  });

  it('every row written has a non-null user_id pointing at a real users row', async () => {
    const specId = specIds[0];
    if (specId === undefined) throw new Error('missing fixture spec');
    const paragraphId = await newParagraph(specId, 'attributed text', 2);

    await runInTransaction(async (client) => {
      const userId = await resolveActorUserId(client, label('attributed'));
      await recordParagraphHistory(client, {
        paragraphId,
        specId,
        version: 1,
        text: 'attributed text',
        nodeType: 'pr1',
        op: 'edit',
        contentVersion: 2,
        userId,
      });
    });

    const row = await historyRow(paragraphId, 1);
    expect(row?.user_id).not.toBeNull();

    const joined = await pool.query<{ label: string }>(
      `SELECT u.label FROM paragraph_versions v
       JOIN users u ON u.id = v.user_id
       WHERE v.paragraph_id = $1 AND v.version = 1`,
      [paragraphId]
    );
    expect(joined.rows[0]?.label).toBe(label('attributed'));
  });

  it('falls back to the SYSTEM_ACTOR_LABEL user when no actorLabel is supplied — still a real, non-null user_id', async () => {
    const specId = specIds[0];
    if (specId === undefined) throw new Error('missing fixture spec');
    const paragraphId = await newParagraph(specId, 'unattributed text', 3);

    await runInTransaction(async (client) => {
      const userId = await resolveActorUserId(client, undefined);
      await recordParagraphHistory(client, {
        paragraphId,
        specId,
        version: 1,
        text: 'unattributed text',
        nodeType: 'pr1',
        op: 'edit',
        contentVersion: 2,
        userId,
      });
    });

    const joined = await pool.query<{ label: string }>(
      `SELECT u.label FROM paragraph_versions v
       JOIN users u ON u.id = v.user_id
       WHERE v.paragraph_id = $1 AND v.version = 1`,
      [paragraphId]
    );
    expect(joined.rows[0]?.label).toBe(SYSTEM_ACTOR_LABEL);
  });

  it("rejects an op outside the CHECK constraint's closed vocabulary", async () => {
    const specId = specIds[0];
    if (specId === undefined) throw new Error('missing fixture spec');
    const paragraphId = await newParagraph(specId, 'bad op text', 4);

    await expect(
      runInTransaction(async (client) => {
        const userId = await resolveActorUserId(client, label('bad-op'));
        await client.query(
          `INSERT INTO paragraph_versions
             (paragraph_id, spec_id, version, text, node_type, op, content_version, user_id)
           VALUES ($1, $2, 1, 'x', 'pr1', 'not-a-real-op', 1, $3)`,
          [paragraphId, specId, userId]
        );
      })
    ).rejects.toThrow();
  });

  it('accepts every op in PARAGRAPH_HISTORY_OPS — keeps the migration CHECK constraint in lockstep', async () => {
    const specId = specIds[0];
    if (specId === undefined) throw new Error('missing fixture spec');
    const paragraphId = await newParagraph(specId, 'op vocabulary text', 7);

    // One version per op so ON CONFLICT (paragraph_id, version) can't mask a
    // rejection. If PARAGRAPH_HISTORY_OPS and migration 046's
    // paragraph_versions_op_check ever drift, one of these INSERTs throws and
    // this test — not a silent production write — catches it.
    await runInTransaction(async (client) => {
      const userId = await resolveActorUserId(client, label('op-vocab'));
      let version = 100;
      for (const op of PARAGRAPH_HISTORY_OPS) {
        version += 1;
        await recordParagraphHistory(client, {
          paragraphId,
          specId,
          version,
          text: `text for ${op}`,
          nodeType: 'pr1',
          op,
          contentVersion: 2,
          userId,
        });
      }
    });

    const stored = await pool.query<{ op: string }>(
      'SELECT op FROM paragraph_versions WHERE paragraph_id = $1',
      [paragraphId]
    );
    const byName = (a: string, b: string): number => a.localeCompare(b);
    const storedOps = [...new Set(stored.rows.map((r) => r.op))].sort(byName);
    expect(storedOps).toEqual([...PARAGRAPH_HISTORY_OPS].sort(byName));
  });
});

describe('resolveHistoryContext (integration)', () => {
  it('the content_version stamped on every row a transaction writes equals specs.content_version immediately after commit', async () => {
    const specId = specIds[0];
    if (specId === undefined) throw new Error('missing fixture spec');
    const paragraphA = await newParagraph(specId, 'ctx text a', 5);
    const paragraphB = await newParagraph(specId, 'ctx text b', 6);

    const before = await contentVersion(specId);

    await runInTransaction(async (client) => {
      // Mirrors assertSpecWritable's contract: it returns the PRE-bump content_version
      // while holding the row lock through to the caller's own bump.
      const ctx = await resolveHistoryContext(client, before, label('ctx'));
      await recordParagraphHistory(client, {
        paragraphId: paragraphA,
        specId,
        version: 1,
        text: 'ctx text a',
        nodeType: 'pr1',
        op: 'edit',
        contentVersion: ctx.contentVersion,
        userId: ctx.userId,
      });
      await recordParagraphHistory(client, {
        paragraphId: paragraphB,
        specId,
        version: 1,
        text: 'ctx text b',
        nodeType: 'pr1',
        op: 'edit',
        contentVersion: ctx.contentVersion,
        userId: ctx.userId,
      });
      await client.query(
        `UPDATE specs SET content_version = content_version + 1, updated_at = now() WHERE id = $1`,
        [specId]
      );
    });

    const after = await contentVersion(specId);
    expect(after).toBe(before + 1);

    const rowA = await historyRow(paragraphA, 1);
    const rowB = await historyRow(paragraphB, 1);
    expect(rowA?.content_version).toBe(after);
    expect(rowB?.content_version).toBe(after);
  });
});
