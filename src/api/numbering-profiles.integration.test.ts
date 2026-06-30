import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool } from '../db/index.js';
import type { NumberingProfileRow } from '../db/index.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000000';

let server: Server;
let baseUrl: string;
let libraryId: string;

const createdProfileIds: string[] = [];
const createdSpecIds: string[] = [];

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

  // Use the seeded UFGS Reference library as target library.
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM libraries WHERE name = 'UFGS Reference' LIMIT 1`
  );
  const row = res.rows[0];
  if (!row) throw new Error('UFGS Reference library not found — run pnpm seed');
  libraryId = row.id;
});

afterAll(async () => {
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
  await pool.end();
});

afterEach(async () => {
  if (createdSpecIds.length > 0) {
    await pool.query(`DELETE FROM specs WHERE id = ANY($1::uuid[])`, [createdSpecIds.splice(0)]);
  }
  if (createdProfileIds.length > 0) {
    await pool.query(
      `DELETE FROM numbering_profiles WHERE id = ANY($1::uuid[]) AND library_id IS NOT NULL`,
      [createdProfileIds.splice(0)]
    );
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patch(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function put(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function del(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: 'DELETE' });
}

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
}

async function makeProfile(name: string): Promise<NumberingProfileRow> {
  const minimalRules = {
    tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
    numbering: [],
    styleLadder: [],
  };
  const res = await post(`/libraries/${libraryId}/numbering-profiles`, {
    name,
    rules: minimalRules,
  });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { success: true; data: NumberingProfileRow };
  createdProfileIds.push(json.data.id);
  return json.data;
}

async function makeSpec(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source, library_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    ['27 21 00', 'NP Test Spec', `np-test-${randomUUID().slice(0, 8)}`, libraryId]
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('failed to insert spec');
  createdSpecIds.push(id);
  return id;
}

// ─── GET /libraries/:id/numbering-profiles ────────────────────────────────────

describe('GET /libraries/:id/numbering-profiles', () => {
  it('200 — includes the CSI Default built-in plus any library profiles', async () => {
    const name = `np-list-${randomUUID().slice(0, 8)}`;
    await makeProfile(name);

    const res = await get(`/libraries/${libraryId}/numbering-profiles`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: NumberingProfileRow[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    // CSI Default (libraryId null) should be present
    expect(body.data.some((p) => p.libraryId === null)).toBe(true);
    // The profile we just created should appear
    expect(body.data.some((p) => p.name === name)).toBe(true);
  });

  it('400 — non-uuid library id', async () => {
    const res = await get('/libraries/not-a-uuid/numbering-profiles');
    expect(res.status).toBe(400);
  });
});

// ─── POST /libraries/:id/numbering-profiles ───────────────────────────────────

describe('POST /libraries/:id/numbering-profiles', () => {
  it('201 — creates a profile and returns the row', async () => {
    const name = `np-create-${randomUUID().slice(0, 8)}`;
    const rules = {
      tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
      numbering: [],
      styleLadder: [],
    };
    const res = await post(`/libraries/${libraryId}/numbering-profiles`, { name, rules });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { success: boolean; data: NumberingProfileRow };
    expect(body.success).toBe(true);
    expect(body.data.name).toBe(name);
    expect(body.data.libraryId).toBe(libraryId);
    createdProfileIds.push(body.data.id);
  });

  it('404 — unknown library', async () => {
    const res = await post(`/libraries/${UNKNOWN_UUID}/numbering-profiles`, {
      name: 'x',
      rules: {
        tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
        numbering: [],
        styleLadder: [],
      },
    });
    expect(res.status).toBe(404);
  });

  it('422 — missing required fields', async () => {
    const res = await post(`/libraries/${libraryId}/numbering-profiles`, { name: 'x' });
    expect(res.status).toBe(422);
  });
});

// ─── GET /numbering-profiles/:id ─────────────────────────────────────────────

describe('GET /numbering-profiles/:id', () => {
  it('200 — returns the profile', async () => {
    const profile = await makeProfile(`np-get-${randomUUID().slice(0, 8)}`);

    const res = await get(`/numbering-profiles/${profile.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: NumberingProfileRow };
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(profile.id);
    expect(body.data.name).toBe(profile.name);
  });

  it('404 — unknown profile', async () => {
    const res = await get(`/numbering-profiles/${UNKNOWN_UUID}`);
    expect(res.status).toBe(404);
  });

  it('400 — non-uuid id', async () => {
    const res = await get('/numbering-profiles/not-a-uuid');
    expect(res.status).toBe(400);
  });
});

// ─── PATCH /numbering-profiles/:id ───────────────────────────────────────────

describe('PATCH /numbering-profiles/:id', () => {
  it('200 — updates the name', async () => {
    const profile = await makeProfile(`np-patch-${randomUUID().slice(0, 8)}`);
    const newName = `np-patched-${randomUUID().slice(0, 8)}`;

    const res = await patch(`/numbering-profiles/${profile.id}`, { name: newName });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: NumberingProfileRow };
    expect(body.success).toBe(true);
    expect(body.data.name).toBe(newName);
    expect(body.data.id).toBe(profile.id);
  });

  it('404 — unknown profile', async () => {
    const res = await patch(`/numbering-profiles/${UNKNOWN_UUID}`, { name: 'x' });
    expect(res.status).toBe(404);
  });
});

// ─── DELETE /numbering-profiles/:id ──────────────────────────────────────────

describe('DELETE /numbering-profiles/:id', () => {
  it('204 — deletes a free profile', async () => {
    const profile = await makeProfile(`np-delete-${randomUUID().slice(0, 8)}`);
    // Remove from cleanup list (we're deleting it here)
    const idx = createdProfileIds.indexOf(profile.id);
    if (idx !== -1) createdProfileIds.splice(idx, 1);

    const res = await del(`/numbering-profiles/${profile.id}`);
    expect(res.status).toBe(204);
  });

  it('404 — unknown profile', async () => {
    const res = await del(`/numbering-profiles/${UNKNOWN_UUID}`);
    expect(res.status).toBe(404);
  });

  it('409 — profile in use by a spec', async () => {
    const profile = await makeProfile(`np-restrict-${randomUUID().slice(0, 8)}`);
    const specId = await makeSpec();

    await put(`/specs/${specId}/numbering-profile`, { profileId: profile.id });

    const res = await del(`/numbering-profiles/${profile.id}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('in use');

    // Profile must still exist
    const check = await pool.query(`SELECT 1 FROM numbering_profiles WHERE id = $1`, [profile.id]);
    expect(check.rows).toHaveLength(1);
  });

  it('DELETE /numbering-profiles/:id — refuses to delete the built-in CSI Default (409), built-in remains resolvable', async () => {
    const row = await pool.query<{ id: string }>(
      `SELECT id FROM numbering_profiles WHERE library_id IS NULL LIMIT 1`
    );
    expect(row.rows).toHaveLength(1);
    const builtInId = row.rows[0]!.id;

    const res = await del(`/numbering-profiles/${builtInId}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toContain('built-in');

    // Built-in must still exist in the database after the refused delete
    const check = await pool.query(`SELECT 1 FROM numbering_profiles WHERE id = $1`, [builtInId]);
    expect(check.rows).toHaveLength(1);
  });
});

// ─── PUT /specs/:id/numbering-profile ────────────────────────────────────────

describe('PUT /specs/:id/numbering-profile', () => {
  it('200 — assigns profile and returns { profileId, name }', async () => {
    const profile = await makeProfile(`np-assign-${randomUUID().slice(0, 8)}`);
    const specId = await makeSpec();

    const res = await put(`/specs/${specId}/numbering-profile`, { profileId: profile.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { profileId: string; name: string };
    };
    expect(body.success).toBe(true);
    expect(body.data.profileId).toBe(profile.id);
    expect(body.data.name).toBe(profile.name);
  });

  it('404 — unknown spec', async () => {
    const profile = await makeProfile(`np-assign-ns-${randomUUID().slice(0, 8)}`);
    const res = await put(`/specs/${UNKNOWN_UUID}/numbering-profile`, { profileId: profile.id });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('spec not found');
  });

  it('404 — unknown profile', async () => {
    const specId = await makeSpec();
    const res = await put(`/specs/${specId}/numbering-profile`, { profileId: UNKNOWN_UUID });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('numbering profile not found');
  });

  it('re-assign replaces the previous profile', async () => {
    const firstProfile = await makeProfile(`np-reassign-a-${randomUUID().slice(0, 8)}`);
    const secondProfile = await makeProfile(`np-reassign-b-${randomUUID().slice(0, 8)}`);
    const specId = await makeSpec();

    await put(`/specs/${specId}/numbering-profile`, { profileId: firstProfile.id });
    const res = await put(`/specs/${specId}/numbering-profile`, { profileId: secondProfile.id });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { profileId: string } };
    expect(body.data.profileId).toBe(secondProfile.id);
  });
});

// ─── DELETE /specs/:id/numbering-profile ─────────────────────────────────────

describe('DELETE /specs/:id/numbering-profile', () => {
  it('204 — clears an assigned profile', async () => {
    const profile = await makeProfile(`np-clear-${randomUUID().slice(0, 8)}`);
    const specId = await makeSpec();
    await put(`/specs/${specId}/numbering-profile`, { profileId: profile.id });

    const res = await del(`/specs/${specId}/numbering-profile`);
    expect(res.status).toBe(204);
  });

  it('is idempotent — clearing when no profile is set returns 204', async () => {
    const specId = await makeSpec();
    const res = await del(`/specs/${specId}/numbering-profile`);
    expect(res.status).toBe(204);
  });

  it('404 — unknown spec', async () => {
    const res = await del(`/specs/${UNKNOWN_UUID}/numbering-profile`);
    expect(res.status).toBe(404);
  });
});

// ─── POST /numbering-profiles/snapshot ───────────────────────────────────────

describe('POST /numbering-profiles/snapshot', () => {
  it('200 — returns a valid NumberingProfile from a DOCX', async () => {
    const docx = readFileSync(resolve('tests/fixtures/libreoffice/csi-spec-sample.docx'));
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(docx)], { type: DOCX_MIME }), 'sample.docx');

    const res = await fetch(`${baseUrl}/numbering-profiles/snapshot`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('tiers');
    expect(body.data).toHaveProperty('numbering');
    expect(body.data).toHaveProperty('styleLadder');
    expect(Array.isArray(body.data['numbering'])).toBe(true);
    expect(Array.isArray(body.data['styleLadder'])).toBe(true);
  });

  it('400 — no file uploaded', async () => {
    const form = new FormData();
    const res = await fetch(`${baseUrl}/numbering-profiles/snapshot`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('400 — non-docx extension', async () => {
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'sample.txt');
    const res = await fetch(`${baseUrl}/numbering-profiles/snapshot`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
  });
});
