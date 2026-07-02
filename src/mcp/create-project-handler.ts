import { createProject, pool, InvalidSourceLibraryError } from '../db/index.js';
import { CreateProjectBodySchema } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, type ToolResult } from './handlers.js';

export async function handleCreateProject(args: unknown): Promise<ToolResult> {
  const parsed = CreateProjectBodySchema.safeParse(args);
  if (!parsed.success) {
    return toolError(
      `invalid create_project input: ${parsed.error.issues.map((i) => i.message).join('; ')}`
    );
  }
  try {
    const project = await createProject(parsed.data, pool);
    return { content: [{ type: 'text' as const, text: JSON.stringify(project, null, 2) }] };
  } catch (err) {
    if (err instanceof InvalidSourceLibraryError) return toolError(err.message);
    logger.error({ err }, 'mcp tool create_project failed');
    return toolError('Internal error — project creation failed');
  }
}
