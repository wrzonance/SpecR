import { z } from 'zod';
import { acquireLock, releaseLock, getLock, findSpecById } from '../db/index.js';
import { AcquireLockBodySchema, ReleaseLockBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, type ToolResult } from './handlers.js';

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export const SpecLockIdShape = {
  specId: z.uuid().describe('Spec UUID (from search_library, list_sections, or get_spec)'),
};
const SpecIdArgs = z.object(SpecLockIdShape);

// Advisory soft-lock (ADR-018 D2): a visibility hint ("someone is editing this"),
// never a write block — the edit gate governs writes. holder is the caller's identity.
export const LockSpecShape = {
  ...SpecLockIdShape,
  ...AcquireLockBodySchema.shape,
};
const LockSpecArgs = z.object(LockSpecShape);

export const UnlockSpecShape = {
  ...SpecLockIdShape,
  ...ReleaseLockBodySchema.shape,
};
const UnlockSpecArgs = z.object(UnlockSpecShape);

export async function handleGetSpecLock(args: unknown): Promise<ToolResult> {
  const parsed = SpecIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid get_spec_lock input: specId must be a UUID');
  try {
    const lock = await getLock(parsed.data.specId);
    return ok({ locked: lock !== null, lock });
  } catch (err) {
    logger.error({ err }, 'mcp tool get_spec_lock failed');
    return toolError('Internal error — lock read failed');
  }
}

export async function handleLockSpec(args: unknown): Promise<ToolResult> {
  const parsed = LockSpecArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid lock_spec input: specId (UUID) and holder (non-empty) are required');
  }
  const { specId, holder, ttlSeconds } = parsed.data;
  try {
    if (!(await findSpecById(specId))) return toolError(`spec not found: id=${specId}`);
    const result = await acquireLock(specId, holder, ttlSeconds);
    if (result.status === 'held') {
      return toolError(`spec is locked by ${result.holder} until ${result.expiresAt}`);
    }
    return ok(result.lock);
  } catch (err) {
    logger.error({ err }, 'mcp tool lock_spec failed');
    return toolError('Internal error — lock acquire failed');
  }
}

export async function handleUnlockSpec(args: unknown): Promise<ToolResult> {
  const parsed = UnlockSpecArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      'invalid unlock_spec input: specId (UUID) and holder (non-empty) are required'
    );
  }
  try {
    const result = await releaseLock(parsed.data.specId, parsed.data.holder);
    if (!result.released) return toolError('no lock held by this holder');
    return ok({ released: true });
  } catch (err) {
    logger.error({ err }, 'mcp tool unlock_spec failed');
    return toolError('Internal error — lock release failed');
  }
}
