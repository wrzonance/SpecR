// src/mcp/coordination-handler.ts
import { getCoordinationReport, ProjectNotFoundError, PackageNotFoundError } from '../db/index.js';
import { anchorsFromReport, anchorsMeta } from './anchors.js';

type ToolOk = {
  readonly content: { readonly type: 'text'; readonly text: string }[];
  readonly _meta?: Record<string, unknown>;
};
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
    const meta = anchorsMeta(anchorsFromReport(report.findings));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      ...(meta ? { _meta: meta } : {}),
    };
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof PackageNotFoundError) {
      return toolErr(err.message);
    }
    return toolErr('Internal error — coordination report failed');
  }
}
