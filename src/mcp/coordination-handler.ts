// src/mcp/coordination-handler.ts
import { getCoordinationReport, ProjectNotFoundError, PackageNotFoundError } from '../db/index.js';

type ToolOk = { readonly content: { readonly type: 'text'; readonly text: string }[] };
type ToolError = {
  readonly isError: true;
  readonly content: { readonly type: 'text'; readonly text: string }[];
};
type ToolResult = ToolOk | ToolError;

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

export async function handleCoordinationReport({
  projectId,
  packageId,
}: {
  projectId: string;
  packageId?: string | undefined;
}): Promise<ToolResult> {
  try {
    const report = await getCoordinationReport(projectId, packageId);
    return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof PackageNotFoundError) {
      return toolErr(err.message);
    }
    return toolErr('Internal error — coordination report failed');
  }
}
