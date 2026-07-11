import { z } from 'zod';
import { resolveOrCreateUserByLabel, listUsers, getUser } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

export const UserIdShape = {
  userId: z.uuid().describe('User UUID (from list_users)'),
};
const UserIdArgs = z.object(UserIdShape);

export const ResolveUserShape = {
  label: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      'Actor label to resolve or create (case-sensitive, exact-match identity — spoofable ' +
        'pre-#43, same trust tier as ADR-018 lock holder; idempotent — same label always ' +
        'returns the same user.id)'
    ),
};
const ResolveUserArgs = z.object(ResolveUserShape);

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

export async function handleListUsers(): Promise<ToolResult> {
  try {
    return ok(await listUsers());
  } catch (err) {
    return internalError(err, 'list_users');
  }
}

export async function handleGetUser(args: unknown): Promise<ToolResult> {
  const parsed = UserIdArgs.safeParse(args);
  if (!parsed.success) return toolError('invalid get_user input: userId must be a UUID');
  try {
    const user = await getUser(parsed.data.userId);
    if (!user) return toolError(`user not found: id=${parsed.data.userId}`);
    return ok(user);
  } catch (err) {
    return internalError(err, 'get_user');
  }
}

export async function handleResolveUser(args: unknown): Promise<ToolResult> {
  const parsed = ResolveUserArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid resolve_user input: ${issues(parsed.error)}`);
  }
  try {
    return ok(await resolveOrCreateUserByLabel(parsed.data.label));
  } catch (err) {
    return internalError(err, 'resolve_user');
  }
}
