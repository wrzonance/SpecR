import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';
import { router } from './router.js';
import { errorHandler } from './middleware/error.js';
import { pool, createLibrary } from '../db/index.js';
import { MAX_LITERAL_TERMS } from '../ast/language-rule-schemas.js';

// ─── Test setup ───────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;

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
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err != null ? reject(err) : resolve()));
  });
  await pool.end();
});

afterEach(async () => {
  // Scoped to this file's own fixtures, exactly like the sibling deletes below:
  // an unscoped `DELETE FROM language_rule_profiles` would also wipe rows owned
  // by test files running concurrently against the same database.
  await pool.query(
    `DELETE FROM language_rule_profiles
     WHERE library_id IN (SELECT id FROM libraries WHERE name LIKE 'lang-api-%')
        OR project_id IN (SELECT id FROM projects WHERE name LIKE 'lang-api-%')`
  );
  await pool.query(`DELETE FROM libraries WHERE name LIKE 'lang-api-%'`);
  await pool.query(`DELETE FROM projects WHERE name LIKE 'lang-api-%'`);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function get(path: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`);
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

let counter = 0;
async function makeLibrary(): Promise<string> {
  counter += 1;
  const lib = await createLibrary({ tier: 'client', name: `lang-api-${Date.now()}-${counter}` });
  return lib.id;
}

async function makeProject(): Promise<string> {
  counter += 1;
  const result = await pool.query<{ id: string }>(
    `INSERT INTO projects (name) VALUES ($1) RETURNING id`,
    [`lang-api-${Date.now()}-${counter}`]
  );
  const row = result.rows[0];
  if (!row) throw new Error('failed to create test project');
  return row.id;
}

const MISSING_UUID = '00000000-0000-4000-8000-000000000000';

interface OkData<T> {
  readonly success: true;
  readonly data: T;
}

interface LanguageRuleProfile {
  readonly id: string;
  readonly scope: 'library' | 'project';
  readonly ownerId: string;
  readonly rules: Record<string, unknown>;
}

interface ScopeCase {
  readonly label: 'library' | 'project';
  readonly urlBase: string;
  readonly responseIdField: 'libraryId' | 'projectId';
  readonly makeOwner: () => Promise<string>;
}

const SCOPE_CASES: readonly ScopeCase[] = [
  { label: 'library', urlBase: '/libraries', responseIdField: 'libraryId', makeOwner: makeLibrary },
  { label: 'project', urlBase: '/projects', responseIdField: 'projectId', makeOwner: makeProject },
];

// ─── GET/PUT/DELETE at each scope ───────────────────────────────────────────────

describe.each(SCOPE_CASES)('$label scope: /$label/{id}/language-rules', (scopeCase) => {
  const path = (id: string): string => `${scopeCase.urlBase}/${id}/language-rules`;

  it('404 — no profile configured for a real owner', async () => {
    const ownerId = await scopeCase.makeOwner();
    const res = await get(path(ownerId));
    expect(res.status).toBe(404);
  });

  it('400 — malformed owner id', async () => {
    const res = await get(`${scopeCase.urlBase}/not-a-uuid/language-rules`);
    expect(res.status).toBe(400);
  });

  it('200 — PUT creates then GET round-trips the stored rules', async () => {
    const ownerId = await scopeCase.makeOwner();
    const rules = {
      bannedTerms: [{ term: 'shall', suggestion: 'will' }],
      requiredPhrases: [{ term: 'Owner’s Representative' }],
    };
    const putRes = await put(path(ownerId), { rules });
    expect(putRes.status).toBe(200);
    const putJson = (await putRes.json()) as OkData<LanguageRuleProfile>;
    expect(putJson.data.scope).toBe(scopeCase.label);
    expect(putJson.data.ownerId).toBe(ownerId);
    expect(putJson.data.rules).toEqual(rules);

    const getRes = await get(path(ownerId));
    expect(getRes.status).toBe(200);
    const getJson = (await getRes.json()) as OkData<LanguageRuleProfile>;
    expect(getJson.data.id).toBe(putJson.data.id);
    expect(getJson.data.rules).toEqual(rules);
  });

  it('200 — PUT replaces in place (upsert), not duplicated', async () => {
    const ownerId = await scopeCase.makeOwner();
    const first = await put(path(ownerId), { rules: { bannedTerms: [{ term: 'shall' }] } });
    const firstJson = (await first.json()) as OkData<LanguageRuleProfile>;

    const second = await put(path(ownerId), { rules: { bannedTerms: [{ term: 'must' }] } });
    expect(second.status).toBe(200);
    const secondJson = (await second.json()) as OkData<LanguageRuleProfile>;
    expect(secondJson.data.id).toBe(firstJson.data.id);
    expect(secondJson.data.rules).toEqual({ bannedTerms: [{ term: 'must' }] });
  });

  it('400 — malformed rules body (wrong type)', async () => {
    const ownerId = await scopeCase.makeOwner();
    const res = await put(path(ownerId), { rules: { bannedTerms: 'not-an-array' } });
    expect(res.status).toBe(400);
  });

  it('400 — missing rules field', async () => {
    const ownerId = await scopeCase.makeOwner();
    const res = await put(path(ownerId), {});
    expect(res.status).toBe(400);
  });

  it('422 — unsafe (ReDoS) isRegex term', async () => {
    const ownerId = await scopeCase.makeOwner();
    const res = await put(path(ownerId), {
      rules: { bannedTerms: [{ term: '(a+)+$', isRegex: true }] },
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { success: false; error: string };
    expect(json.error).toMatch(/regex/i);
  });

  it('422 — oversized isRegex term', async () => {
    const ownerId = await scopeCase.makeOwner();
    const res = await put(path(ownerId), {
      rules: { bannedTerms: [{ term: 'a'.repeat(500), isRegex: true }] },
    });
    expect(res.status).toBe(422);
  });

  // #541 review finding — openapi.yaml documents bannedTerms/reinforcingWords/
  // partyVocabulary/requiredPhrases as EACH independently capped at
  // MAX_LITERAL_TERMS (maxItems: 500 per field). The real write-boundary
  // bound is a combined cap of MAX_LITERAL_TERMS literal terms flattened
  // across all 4 categories together. This spreads terms across TWO fields,
  // each comfortably within its own documented per-field maxItems, but whose
  // sum exceeds the combined cap — the exact payload shape a client that
  // trusted only the per-field maxItems would build and expect to succeed.
  it('422 — literal terms spread across 2 fields, each within its own maxItems, but over the combined cap', async () => {
    const ownerId = await scopeCase.makeOwner();
    const perField = Math.ceil((MAX_LITERAL_TERMS + 1) / 2);
    const terms = (prefix: string): Array<{ term: string }> =>
      Array.from({ length: perField }, (_, i) => ({ term: `${prefix}-${i}` }));
    const res = await put(path(ownerId), {
      rules: {
        bannedTerms: terms('banned'),
        reinforcingWords: terms('reinforcing'),
      },
    });
    expect(res.status).toBe(422);
    const json = (await res.json()) as { success: false; error: string };
    // validateRules wraps the underlying Zod issue text (which does say "too
    // many literal terms...") in a generic message at this module boundary —
    // see the LanguageRuleValidationError throw site in
    // src/db/queries/language-rule-profiles.ts. The response body is asserted
    // against what the API actually returns; the point pinned here is the
    // STATUS CODE — that combined-cap enforcement fires even though every
    // individual field stayed within its own documented maxItems.
    expect(json.error).toMatch(/malformed language rules/i);
  });

  it('404 — PUT against a nonexistent owner (scope error, not a 500)', async () => {
    const res = await put(path(MISSING_UUID), { rules: { bannedTerms: [{ term: 'shall' }] } });
    expect(res.status).toBe(404);
  });

  it('200 — DELETE removes an existing profile', async () => {
    const ownerId = await scopeCase.makeOwner();
    await put(path(ownerId), { rules: { bannedTerms: [{ term: 'shall' }] } });

    const res = await del(path(ownerId));
    expect(res.status).toBe(200);
    const json = (await res.json()) as OkData<Record<string, string>>;
    expect(json.data[scopeCase.responseIdField]).toBe(ownerId);

    const getAfter = await get(path(ownerId));
    expect(getAfter.status).toBe(404);
  });

  it('404 — DELETE with no profile configured', async () => {
    const ownerId = await scopeCase.makeOwner();
    const res = await del(path(ownerId));
    expect(res.status).toBe(404);
  });

  it('400 — DELETE with malformed owner id', async () => {
    const res = await del(`${scopeCase.urlBase}/not-a-uuid/language-rules`);
    expect(res.status).toBe(400);
  });
});
