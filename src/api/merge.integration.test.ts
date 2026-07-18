import { randomUUID } from 'node:crypto';
import express from 'express';
import type { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createSpec, insertTree, pool, SYSTEM_ACTOR_LABEL } from '../db/index.js';
import type { DiffResult } from '../merge/index.js';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { historyActor } from '../test-utils/history-actor.js';

const ORIGINAL_TEXT = 'Provide copper patch panels.';
const REVISED_TEXT = 'Provide fiber patch panels.';

let server: Server;
let baseUrl: string;
const cleanupIds: string[] = [];

interface ApiResponse<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: string;
}

interface MergeResult {
  readonly applied: number;
  readonly rejected: number;
}

interface SpecFixture {
  readonly specId: string;
  readonly paragraphId: string;
}

async function createSpecFixture(): Promise<SpecFixture> {
  const partId = randomUUID();
  const articleId = randomUUID();
  const paragraphId = randomUUID();
  const specId = await createSpec({
    section: '27 16 00',
    title: 'Merge Integration Spec',
    source: `d36_${randomUUID().slice(0, 8)}`,
  });
  cleanupIds.push(specId);
  await insertTree(
    {
      id: specId,
      section: '27 16 00',
      title: 'Merge Integration Spec',
      parts: [
        {
          id: partId,
          type: 'part',
          text: 'GENERAL',
          meta: {},
          children: [
            {
              id: articleId,
              type: 'article',
              text: 'SUMMARY',
              meta: {},
              children: [
                {
                  id: paragraphId,
                  type: 'pr1',
                  text: ORIGINAL_TEXT,
                  meta: {},
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    },
    specId,
    pool
  );
  return { specId, paragraphId };
}

function diffFor(paragraphId: string): DiffResult {
  return {
    added: [],
    modified: [
      {
        uuid: paragraphId,
        base: ORIGINAL_TEXT,
        theirs: REVISED_TEXT,
        ours: ORIGINAL_TEXT,
      },
    ],
    deleted: [],
    conflicts: [],
    objectConflicts: [],
    warnings: [],
  };
}

async function postMerge(
  specId: string,
  body: Record<string, unknown>
): Promise<{ readonly status: number; readonly body: ApiResponse<MergeResult> }> {
  const res = await fetch(`${baseUrl}/specs/${specId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as ApiResponse<MergeResult> };
}

async function paragraphState(paragraphId: string): Promise<{
  readonly text: string;
  readonly baseVersion: number;
  readonly versionCount: number;
}> {
  const result = await pool.query<{
    text: string;
    base_version: number;
    version_count: string;
  }>(
    `SELECT p.text, p.base_version, COUNT(v.id) AS version_count
     FROM paragraphs p
     LEFT JOIN paragraph_versions v ON v.paragraph_id = p.id
     WHERE p.id = $1
     GROUP BY p.id`,
    [paragraphId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('paragraph missing');
  return {
    text: row.text,
    baseVersion: row.base_version,
    versionCount: Number.parseInt(row.version_count, 10),
  };
}

beforeAll(async () => {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 3000;
  baseUrl = `http://localhost:${port}`;
});

afterAll(async () => {
  for (const id of cleanupIds) {
    await pool.query('DELETE FROM specs WHERE id = $1', [id]);
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
});

describe('POST /specs/:id/merge (integration)', () => {
  it('accepting one UUID updates text, increments base_version, and inserts a snapshot', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const { status, body } = await postMerge(specId, {
      accept: [paragraphId],
      diff: diffFor(paragraphId),
    });
    const state = await paragraphState(paragraphId);

    expect(status).toBe(200);
    expect(body.data).toEqual({ applied: 1, rejected: 0 });
    expect(state).toEqual({ text: REVISED_TEXT, baseVersion: 2, versionCount: 1 });
  });

  it('empty accept rejects all diff entries without changing the database', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const { status, body } = await postMerge(specId, { accept: [], diff: diffFor(paragraphId) });
    const state = await paragraphState(paragraphId);

    expect(status).toBe(200);
    expect(body.data).toEqual({ applied: 0, rejected: 1 });
    expect(state).toEqual({ text: ORIGINAL_TEXT, baseVersion: 1, versionCount: 0 });
  });

  it('unknown accepted UUID returns 400 with a descriptive error', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const unknown = randomUUID();
    const { status, body } = await postMerge(specId, {
      accept: [unknown],
      diff: diffFor(paragraphId),
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain(unknown);
  });

  it('merge: unknown body property rejected with 400 — strict schema matches OpenAPI additionalProperties:false', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const { status, body } = await postMerge(specId, {
      accept: [],
      diff: diffFor(paragraphId),
      unexpected: 'extra',
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toBe('invalid merge request body');
  });

  it('an addition reusing a uuid from another spec returns 400, not 500', async () => {
    const target = await createSpecFixture();
    const other = await createSpecFixture();
    // other.paragraphId is a real row in `other`; reuse it as the explicit id of an
    // addition into `target`. The global-id pre-check must reject it (400) rather
    // than let ON CONFLICT DO NOTHING surface as an internal error (500).
    const diff: DiffResult = {
      added: [
        {
          uuid: other.paragraphId,
          text: 'Cross-spec orphan',
          index: 0,
          afterUuid: target.paragraphId,
        },
      ],
      modified: [],
      deleted: [],
      conflicts: [],
      objectConflicts: [],
      warnings: [],
    };
    const { status, body } = await postMerge(target.specId, {
      accept: [other.paragraphId],
      diff,
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain(other.paragraphId);
  });

  it('applying the same accepted UUID twice is a no-op on the second call', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const diff = diffFor(paragraphId);
    const first = await postMerge(specId, { accept: [paragraphId], diff });
    const second = await postMerge(specId, { accept: [paragraphId], diff });
    const state = await paragraphState(paragraphId);

    expect(first.body.data).toEqual({ applied: 1, rejected: 0 });
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ applied: 0, rejected: 0 });
    expect(state).toEqual({ text: REVISED_TEXT, baseVersion: 2, versionCount: 1 });
  });
});

describe('POST /specs/:id/merge — actorLabel attribution (#377)', () => {
  it('a supplied actorLabel attributes the merge history row; response shape is unchanged', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const { status, body } = await postMerge(specId, {
      accept: [paragraphId],
      diff: diffFor(paragraphId),
      actorLabel: 'merge.bot',
    });
    expect(status).toBe(200);
    // Response shape unaffected by actorLabel — still exactly { applied, rejected }.
    expect(Object.keys(body.data!).sort((a, b) => a.localeCompare(b))).toEqual([
      'applied',
      'rejected',
    ]);
    expect(await historyActor(pool, paragraphId, 2)).toBe('merge.bot');
  });

  it('omitting actorLabel attributes the merge history row to the SYSTEM_ACTOR_LABEL sentinel', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const { status } = await postMerge(specId, {
      accept: [paragraphId],
      diff: diffFor(paragraphId),
    });
    expect(status).toBe(200);
    expect(await historyActor(pool, paragraphId, 2)).toBe(SYSTEM_ACTOR_LABEL);
  });
});

describe('POST /specs/:id/merge — concurrency + edit gate (ADR-018)', () => {
  it('bumps specs.content_version on an applied merge', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    await postMerge(specId, { accept: [paragraphId], diff: diffFor(paragraphId) });
    const r = await pool.query<{ content_version: number }>(
      'SELECT content_version FROM specs WHERE id = $1',
      [specId]
    );
    expect(r.rows[0]?.content_version).toBe(2); // 1 at create → 2 after merge
  });

  it('merge no-op (applied=0) does NOT bump content_version', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    // Empty accept → every diff entry is rejected → applied=0. A no-op merge
    // must not advance the optimistic token or it would invalidate clients'
    // preconditions and trigger avoidable 409s.
    const { status, body } = await postMerge(specId, { accept: [], diff: diffFor(paragraphId) });
    expect(status).toBe(200);
    expect(body.data).toEqual({ applied: 0, rejected: 1 });
    const r = await pool.query<{ content_version: number }>(
      'SELECT content_version FROM specs WHERE id = $1',
      [specId]
    );
    expect(r.rows[0]?.content_version).toBe(1); // unchanged at create value
  });

  it('rejects a stale expectedVersion with 409 and the current version', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    const { status, body } = await postMerge(specId, {
      accept: [paragraphId],
      diff: diffFor(paragraphId),
      expectedVersion: 99,
    });
    expect(status).toBe(409);
    const withVersion = body as unknown as { currentVersion: number };
    expect(withVersion.currentVersion).toBe(1);
    const state = await paragraphState(paragraphId);
    expect(state.text).toBe(ORIGINAL_TEXT); // unchanged — rolled back
  });

  it('rejects a merge on an archived spec with 409', async () => {
    const { specId, paragraphId } = await createSpecFixture();
    await pool.query(`UPDATE specs SET lifecycle_state = 'archived' WHERE id = $1`, [specId]);
    const { status } = await postMerge(specId, {
      accept: [paragraphId],
      diff: diffFor(paragraphId),
    });
    expect(status).toBe(409);
    const state = await paragraphState(paragraphId);
    expect(state.text).toBe(ORIGINAL_TEXT);
  });
});
