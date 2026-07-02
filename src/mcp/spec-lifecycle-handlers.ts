import { z } from 'zod';
import {
  updateSpec,
  withdrawSpec,
  restoreSpec,
  finalizeOnboarding,
  reopenOnboarding,
} from '../db/index.js';
import type { UpdateSpecInput } from '../db/index.js';
import { PatchSpecBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// A project copy has no independent lifecycle — withdraw/restore act on library masters.
const WITHDRAW_PROJECT_COPY =
  'spec is a project copy — delete_spec withdraws library masters only; unassign a project copy from its project instead';
const RESTORE_PROJECT_COPY = 'spec is a project copy — restore applies only to library masters';

export const SpecIdShape = {
  specId: z.uuid().describe('Spec UUID (from search_library, list_sections, or get_spec)'),
};
const SpecIdArgs = z.object(SpecIdShape);

// Path id + the REST PATCH body reused verbatim, so the tool advertises exactly what
// the handler validates. Deliberately stricter than REST: at least one field must change
// (consistent with update_project). REST PATCH /specs treats {} as a no-op, but for an
// agent an empty update is a mistake worth rejecting rather than silently no-op'ing.
export const UpdateSpecShape = {
  ...SpecIdShape,
  ...PatchSpecBodySchema.shape,
};
const UpdateSpecArgs = z
  .object(UpdateSpecShape)
  .refine((v) => v.title !== undefined || v.section !== undefined, {
    message: 'at least one of title or section is required',
  });

export async function handleUpdateSpec(args: unknown): Promise<ToolResult> {
  const parsed = UpdateSpecArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      `invalid update_spec input: ${parsed.error.issues.map((i) => i.message).join('; ')}`
    );
  }
  const { specId, title, section } = parsed.data;
  const input: UpdateSpecInput = {
    ...(title !== undefined ? { title } : {}),
    ...(section !== undefined ? { section } : {}),
  };
  try {
    const spec = await updateSpec(specId, input);
    if (!spec) return toolError(`spec not found: id=${specId}`);
    return ok(spec);
  } catch (err) {
    logger.error({ err }, 'mcp tool update_spec failed');
    return toolError('Internal error — spec update failed');
  }
}

export async function handleFinalizeSpec(args: unknown): Promise<ToolResult> {
  const parsed = SpecIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid finalize_spec input: specId must be a UUID');
  try {
    // review → active (ADR-022 D6). Idempotent: already-active is a success.
    const outcome = await finalizeOnboarding(parsed.data.specId);
    if (outcome.status === 'not-found') {
      return toolError(`spec not found: id=${parsed.data.specId}`);
    }
    return ok({ onboardingStatus: 'active' });
  } catch (err) {
    logger.error({ err }, 'mcp tool finalize_spec failed');
    return toolError('Internal error — spec finalize failed');
  }
}

export async function handleReopenSpec(args: unknown): Promise<ToolResult> {
  const parsed = SpecIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid reopen_spec input: specId must be a UUID');
  try {
    // active → review (ADR-022 D6). Idempotent: already-review is a success.
    const outcome = await reopenOnboarding(parsed.data.specId);
    if (outcome.status === 'not-found') {
      return toolError(`spec not found: id=${parsed.data.specId}`);
    }
    return ok({ onboardingStatus: 'review' });
  } catch (err) {
    logger.error({ err }, 'mcp tool reopen_spec failed');
    return toolError('Internal error — spec reopen failed');
  }
}

export async function handleRestoreSpec(args: unknown): Promise<ToolResult> {
  const parsed = SpecIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid restore_spec input: specId must be a UUID');
  try {
    // Idempotent: restoring an already-active master is a no-op success (ADR-030).
    const outcome = await restoreSpec(parsed.data.specId);
    if (outcome.kind === 'not-found') return toolError(`spec not found: id=${parsed.data.specId}`);
    if (outcome.kind === 'project-copy') return toolError(RESTORE_PROJECT_COPY);
    return ok({ specId: outcome.specId });
  } catch (err) {
    logger.error({ err }, 'mcp tool restore_spec failed');
    return toolError('Internal error — spec restore failed');
  }
}

export async function handleDeleteSpec(args: unknown): Promise<ToolResult> {
  const parsed = SpecIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid delete_spec input: specId must be a UUID');
  try {
    // Soft, idempotent withdraw of a library master (ADR-030) — reversible via restore_spec.
    const outcome = await withdrawSpec(parsed.data.specId);
    if (outcome.kind === 'not-found') return toolError(`spec not found: id=${parsed.data.specId}`);
    if (outcome.kind === 'project-copy') return toolError(WITHDRAW_PROJECT_COPY);
    return ok({ specId: outcome.specId, withdrawnAt: outcome.withdrawnAt });
  } catch (err) {
    logger.error({ err }, 'mcp tool delete_spec failed');
    return toolError('Internal error — spec delete failed');
  }
}
