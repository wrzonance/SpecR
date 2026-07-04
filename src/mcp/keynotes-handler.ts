import { findProjectById, getProjectKeynotes, pool } from '../db/index.js';
import { logger } from '../lib/logger.js';

type ToolOk = { readonly content: { readonly type: 'text'; readonly text: string }[] };
type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
type ToolResult = ToolOk | ToolError;

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

/**
 * get_project_keynotes — the structured counterpart to GET /projects/:id/keynotes.
 * Returns the project-filtered keynote rows (ADR-016 D2) as JSON rather than the
 * tab-delimited Revit file the REST route renders. getProjectKeynotes yields [] for
 * an unknown project, so existence is checked first to give an agent a real 404
 * signal instead of a silently-empty result.
 */
export async function handleGetProjectKeynotes({
  projectId,
}: {
  projectId: string;
}): Promise<ToolResult> {
  try {
    const project = await findProjectById(projectId, pool);
    if (!project) return toolErr(`project not found: ${projectId}`);
    const keynotes = await getProjectKeynotes(projectId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(keynotes, null, 2) }] };
  } catch (err) {
    logger.error({ err }, 'mcp tool get_project_keynotes failed');
    return toolErr('Internal error — keynote export failed');
  }
}
