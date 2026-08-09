import {
  getTextBoxesReport,
  ProjectNotFoundError,
  SpecNotFoundError,
  type TextBoxScope,
} from '../db/index.js';
import type { ToolError, ToolResult } from './tool-result.js';

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

function resolveScope(
  specId: string | undefined,
  projectId: string | undefined
): TextBoxScope | ToolError {
  if (specId && projectId) {
    return toolErr('Provide exactly one of specId or projectId, not both');
  }
  if (specId) return { kind: 'spec', specId };
  if (projectId) return { kind: 'project', projectId };
  return toolErr('Provide one of specId (see get_spec) or projectId (see list_projects)');
}

export async function handleTextBoxesReport({
  specId,
  projectId,
}: {
  specId?: string | undefined;
  projectId?: string | undefined;
}): Promise<ToolResult> {
  const scope = resolveScope(specId, projectId);
  if ('isError' in scope) return scope;
  try {
    const report = await getTextBoxesReport(scope);
    return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
  } catch (err) {
    if (err instanceof SpecNotFoundError || err instanceof ProjectNotFoundError) {
      return toolErr(err.message);
    }
    return toolErr('Internal error — text-boxes report failed');
  }
}
