import { getCoordinationReport, PackageNotFoundError, pool } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { toolError, type ToolResult } from './handlers.js';

// MCP `coordination_report` tool (#102). Returns project coordination findings:
// present-but-not-required sections, required-but-absent sections, and dangling
// section references. Optional packageId scopes both present specs and authored
// requirements to that package. Never throws — returns { isError } on failure.
export async function handleCoordinationReport({
  projectId,
  packageId,
}: {
  projectId: string;
  packageId: string | undefined;
}): Promise<ToolResult> {
  try {
    const report = await getCoordinationReport(projectId, packageId, pool);
    if (!report) {
      return toolError(`Project not found: id=${projectId}`);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
  } catch (err) {
    if (err instanceof PackageNotFoundError) {
      return toolError(`Package not found: id=${packageId}`);
    }
    logger.error({ err }, 'mcp tool coordination_report failed');
    return toolError('Internal error — coordination report failed');
  }
}
