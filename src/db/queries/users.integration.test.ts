import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { pool } from '../index.js';
import { resolveOrCreateUserByLabel, listUsers, getUser } from './users.js';

// Namespace reserved by this file: labels 'users-test-<suffix>-...'. The per-file random
// suffix (mirrors coordination.integration.test.ts) keeps this run's rows distinguishable
// from any other, and cleanup is scoped to that suffix so a concurrent worker or another
// integration run sharing the same Postgres never deletes this run's — or another's — rows.
const suffix = randomUUID().slice(0, 8);
const label = (name: string): string => `users-test-${suffix}-${name}`;

afterEach(async () => {
  await pool.query(`DELETE FROM users WHERE label LIKE $1`, [`users-test-${suffix}-%`]);
});

describe('users query module (integration)', () => {
  it(
    'resolveOrCreateUserByLabel is a pure idempotent upsert: repeat calls for the same ' +
      'label return the same row and the unique constraint keeps exactly one row behind',
    async () => {
      const first = await resolveOrCreateUserByLabel(label('idempotent'));
      const second = await resolveOrCreateUserByLabel(label('idempotent'));

      expect(second).toEqual(first);

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM users WHERE label = $1`,
        [label('idempotent')]
      );
      expect(rows[0]?.count).toBe('1');
    }
  );

  it(
    'resolveOrCreateUserByLabel: concurrent calls for the same label race-free onto a ' +
      'single row (upsert, not check-then-insert)',
    async () => {
      const concurrentLabel = label('concurrent');
      const [a, b] = await Promise.all([
        resolveOrCreateUserByLabel(concurrentLabel),
        resolveOrCreateUserByLabel(concurrentLabel),
      ]);

      expect(a.id).toBe(b.id);

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM users WHERE label = $1`,
        [concurrentLabel]
      );
      expect(rows[0]?.count).toBe('1');
    }
  );

  it('resolveOrCreateUserByLabel creates a distinct row per distinct label', async () => {
    const a = await resolveOrCreateUserByLabel(label('distinct-a'));
    const b = await resolveOrCreateUserByLabel(label('distinct-b'));

    expect(a.id).not.toBe(b.id);
  });

  it(
    'users.label uniqueness is byte-exact, not case-folded: labels differing only in ' +
      'case resolve to two distinct rows (openapi.yaml: "label is case-sensitive")',
    async () => {
      const lowerLabel = label('case-alice');
      const upperLabel = label('case-ALICE');

      const lower = await resolveOrCreateUserByLabel(lowerLabel);
      const upper = await resolveOrCreateUserByLabel(upperLabel);

      expect(lower.id).not.toBe(upper.id);

      const { rows } = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM users WHERE label IN ($1, $2)`,
        [lowerLabel, upperLabel]
      );
      expect(rows[0]?.count).toBe('2');
    }
  );

  it(
    'listUsers is deterministic and total: orders by label and reflects every created ' +
      'user, not a subset',
    async () => {
      // Created out of alphabetical order to prove the ORDER BY, not insertion order, wins.
      await resolveOrCreateUserByLabel(label('list-b'));
      await resolveOrCreateUserByLabel(label('list-a'));
      await resolveOrCreateUserByLabel(label('list-c'));

      // Assert only this run's rows: a global count (before/after) races concurrent workers
      // on the shared Postgres, and the run-scoped ordered-label check below already proves
      // listUsers reflects every created fixture in label order.
      const after = await listUsers();
      const created = after.filter((u) => u.label.startsWith(label('list-')));
      expect(created.map((u) => u.label)).toEqual([
        label('list-a'),
        label('list-b'),
        label('list-c'),
      ]);
    }
  );

  it('getUser returns the created row by id', async () => {
    const created = await resolveOrCreateUserByLabel(label('get-hit'));
    const fetched = await getUser(created.id);
    expect(fetched).toEqual(created);
  });

  it(
    'getUser returns null for a syntactically valid but unknown id (never throws ' + 'not-found)',
    async () => {
      expect(await getUser('00000000-0000-0000-0000-000000000000')).toBeNull();
    }
  );
});
