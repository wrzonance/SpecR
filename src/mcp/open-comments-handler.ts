// src/mcp/open-comments-handler.ts
import {
  getOpenCommentsReport,
  SpecNotFoundError,
  ProjectNotFoundError,
  type OpenCommentsScope,
} from '../db/index.js';

type ToolOk = { readonly content: { readonly type: 'text'; readonly text: string }[] };
type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
type ToolResult = ToolOk | ToolError;

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

// Resolve the scope from the two optional inputs: exactly one of specId/projectId.
function resolveScope(
  specId: string | undefined,
  projectId: string | undefined
): OpenCommentsScope | ToolError {
  if (specId && projectId) {
    return toolErr('Provide exactly one of specId or projectId, not both');
  }
  if (specId) return { kind: 'spec', specId };
  if (projectId) return { kind: 'project', projectId };
  return toolErr('Provide one of specId (see get_spec) or projectId (see list_projects)');
}

export async function handleOpenCommentsReport({
  specId,
  projectId,
}: {
  specId?: string | undefined;
  projectId?: string | undefined;
}): Promise<ToolResult> {
  const scope = resolveScope(specId, projectId);
  if ('isError' in scope) return scope;
  try {
    const report = await getOpenCommentsReport(scope);
    return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
  } catch (err) {
    if (err instanceof SpecNotFoundError || err instanceof ProjectNotFoundError) {
      return toolErr(err.message);
    }
    return toolErr('Internal error — open-comments report failed');
  }
}
