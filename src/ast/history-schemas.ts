import { z } from 'zod';

const ContentVersionAnchorSchema = z.preprocess((value) => {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return Number(value);
  return value;
}, z.number().int().min(1));

/** Prefix distinguishing a checkpoint anchor from a bare revision UUID — both
 *  are otherwise-indistinguishable 36-char strings on the wire. */
export const CHECKPOINT_ANCHOR_PREFIX = 'checkpoint:';

const UUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_PATTERN = new RegExp(`^${UUID_SOURCE}$`);
const CHECKPOINT_ANCHOR_PATTERN = new RegExp(`^${CHECKPOINT_ANCHOR_PREFIX}${UUID_SOURCE}$`);

const CheckpointAnchorSchema = z
  .string()
  .regex(CHECKPOINT_ANCHOR_PATTERN, 'expected checkpoint:<uuid>');

/** A stored-state anchor accepted by both REST query strings and MCP input:
 *  `origin` | `current` | a content_version integer | an immutable package
 *  revision UUID | `checkpoint:<uuid>` (ADR-052 D3/D9, issue #380). */
export const HistoryAnchorSchema = z.union([
  z.enum(['origin', 'current']),
  z.uuid(),
  ContentVersionAnchorSchema,
  CheckpointAnchorSchema,
]);

export type HistoryAnchorInput = z.infer<typeof HistoryAnchorSchema>;

/** Extracts the checkpoint id from a `checkpoint:<uuid>` anchor string, or
 *  null when `anchor` is not in that shape (a plain revision UUID, a
 *  content_version, or `origin`/`current`). The single parse point for this
 *  shape — history-diff.ts's resolveSnapshot reuses it rather than
 *  re-deriving the prefix/pattern. */
export function parseCheckpointAnchor(anchor: string): string | null {
  if (!anchor.startsWith(CHECKPOINT_ANCHOR_PREFIX)) return null;
  const id = anchor.slice(CHECKPOINT_ANCHOR_PREFIX.length);
  return UUID_PATTERN.test(id) ? id : null;
}
