import type { PoolClient } from 'pg';

/**
 * Increment `specs.content_version` (the optimistic-concurrency / project-copy
 * drift token) for one spec inside the caller's already-open transaction.
 *
 * Every content write path bumps it exactly once per outer write — never once
 * per row touched (ADR-018). The gate-free DB cores (`insertSiblingRow`,
 * `setVanishRow`) deliberately do NOT call this; only their owning service does,
 * so a merge applying N added/deleted ops still advances the token once. Callers
 * must hold the spec row lock (via `assertSpecWritable`) before invoking this.
 */
export async function bumpSpecContentVersion(client: PoolClient, specId: string): Promise<void> {
  await client.query(
    `UPDATE specs SET content_version = content_version + 1, updated_at = now() WHERE id = $1`,
    [specId]
  );
}
