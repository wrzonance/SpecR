import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { pool } from '../db/index.js';
import {
  handleGetHistoryDiff,
  handleGetParagraphHistory,
  handleGetSpecHistory,
} from '../mcp/history-handlers.js';
import { errorHandler } from './middleware/error.js';
import { router } from './router.js';
import { assertResponse } from '../test-utils/contract/validate-response.js';

const ids = { library: randomUUID(), spec: randomUUID(), paragraph: randomUUID() };
let server: Server;
let baseUrl: string;

function payload(result: Awaited<ReturnType<typeof handleGetSpecHistory>>): unknown {
  if ('isError' in result) throw new Error(result.content[0]?.text ?? 'tool error');
  return JSON.parse(result.content[0]?.text ?? 'null');
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
  baseUrl = `http://127.0.0.1:${port}`;

  await pool.query(`INSERT INTO libraries (id, tier, name) VALUES ($1, 'company', $2)`, [
    ids.library,
    `api-history-${ids.library}`,
  ]);
  await pool.query(
    `INSERT INTO specs
       (id, section, title, source, library_id, content_version, created_at, updated_at)
     VALUES ($1, '09 97 00', 'API History', 'docx', $2, 2, $3, $4)`,
    [ids.spec, ids.library, '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z']
  );
  await pool.query(
    `INSERT INTO paragraphs
       (id, spec_id, node_type, text, position, base_version, created_at, updated_at)
     VALUES ($1, $2, 'pr1', 'After', 1, 2, $3, $4)`,
    [ids.paragraph, ids.spec, '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z']
  );
  await pool.query(
    `INSERT INTO paragraph_versions
       (paragraph_id, spec_id, version, text, node_type, op, content_version, snapshot_at)
     VALUES
       ($1, $2, 1, 'Before', 'pr1', 'insert', 1, '2026-03-01T00:00:00Z'),
       ($1, $2, 2, 'After', 'pr1', 'edit', 2, '2026-03-02T00:00:00Z')`,
    [ids.paragraph, ids.spec]
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM specs WHERE id = $1', [ids.spec]);
  await pool.query('DELETE FROM libraries WHERE id = $1', [ids.library]);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe('version-history REST and MCP surfaces (#378)', () => {
  it('GET paragraph history supports includeOrigin and returns the raw iterations', async () => {
    const response = await fetch(
      `${baseUrl}/specs/${ids.spec}/paragraphs/${ids.paragraph}/history?includeOrigin=true`
    );
    const body = (await response.json()) as { data: readonly { text: string }[] };
    expect(response.status).toBe(200);
    expect(body.data.map((entry) => entry.text)).toEqual(['Before', 'After']);
    await assertResponse('get', '/specs/{id}/paragraphs/{nodeId}/history', 200, body);
  });

  it('GET spec history and diff expose content-version anchors', async () => {
    const timeline = await fetch(`${baseUrl}/specs/${ids.spec}/history`);
    expect(timeline.status).toBe(200);
    const timelineBody = (await timeline.json()) as { data: { currentContentVersion: number } };
    expect(timelineBody.data.currentContentVersion).toBe(2);
    await assertResponse('get', '/specs/{id}/history', 200, timelineBody);

    const diff = await fetch(`${baseUrl}/specs/${ids.spec}/history/diff?from=1&to=current`);
    expect(diff.status).toBe(200);
    const diffBody = (await diff.json()) as { data: { modified: readonly { nodeId: string }[] } };
    expect(diffBody.data.modified.map((entry) => entry.nodeId)).toEqual([ids.paragraph]);
    await assertResponse('get', '/specs/{id}/history/diff', 200, diffBody);
  });

  it('rejects malformed ids, booleans, package ids, and anchors at the boundary', async () => {
    expect((await fetch(`${baseUrl}/specs/nope/paragraphs/${ids.paragraph}/history`)).status).toBe(
      400
    );
    expect(
      (
        await fetch(
          `${baseUrl}/specs/${ids.spec}/paragraphs/${ids.paragraph}/history?includeOrigin=yes`
        )
      ).status
    ).toBe(400);
    expect((await fetch(`${baseUrl}/specs/${ids.spec}/history?packageId=nope`)).status).toBe(400);
    expect(
      (await fetch(`${baseUrl}/specs/${ids.spec}/history/diff?from=nope&to=current`)).status
    ).toBe(400);
  });

  it('MCP tools mirror all three REST reads and never throw on invalid input', async () => {
    const paragraph = payload(
      await handleGetParagraphHistory({ specId: ids.spec, nodeId: ids.paragraph })
    ) as readonly { text: string }[];
    expect(paragraph.map((entry) => entry.text)).toEqual(['Before', 'After']);
    expect(payload(await handleGetSpecHistory({ specId: ids.spec }))).toEqual(
      expect.objectContaining({ currentContentVersion: 2 })
    );
    expect(
      payload(await handleGetHistoryDiff({ specId: ids.spec, from: 1, to: 'current' }))
    ).toEqual(
      expect.objectContaining({ modified: [expect.objectContaining({ nodeId: ids.paragraph })] })
    );
    await expect(handleGetHistoryDiff({ specId: 'nope', from: 1, to: 'current' })).resolves.toEqual(
      expect.objectContaining({ isError: true })
    );
  });
});
