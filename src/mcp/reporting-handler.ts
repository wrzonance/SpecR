import { buildComparisonReport, ReportingError, SpecNotFoundError } from '../reporting/index.js';
import { logger } from '../lib/logger.js';
import { anchorsMeta, type McpAnchor } from './anchors.js';
import type { ComparisonReport } from '../reporting/index.js';
import type { ToolError, ToolResult } from './tool-result.js';

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

/** Every present cell → a navigation anchor (section + real spec + paragraph
 *  UUID), so a UI client can trace each grounded fact back to its source. */
function anchorsFromReport(report: ComparisonReport): McpAnchor[] {
  const bySpec = new Map(report.columns.map((c) => [c.specId, c.section]));
  const out: McpAnchor[] = [];
  for (const row of report.rows) {
    for (const cell of row.cells) {
      if (!cell.present) continue;
      const section = bySpec.get(cell.specId);
      if (section !== undefined) {
        out.push({ section, specId: cell.specId, paragraphId: cell.paragraphUuid });
      }
    }
  }
  return out;
}

export async function handleCompareSpecs({
  sources,
  baseline,
  alignment,
  include,
}: {
  sources: string[];
  baseline?: string | undefined;
  alignment?: 'origin' | 'structure' | 'auto' | undefined;
  include?: 'all' | 'differences' | undefined;
}): Promise<ToolResult> {
  try {
    const report = await buildComparisonReport(sources, {
      ...(baseline !== undefined ? { baseline } : {}),
      ...(alignment !== undefined ? { alignment } : {}),
      ...(include !== undefined ? { include } : {}),
    });
    const meta = anchorsMeta(anchorsFromReport(report));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      ...(meta ? { _meta: meta } : {}),
    };
  } catch (err) {
    if (err instanceof SpecNotFoundError || err instanceof ReportingError) {
      return toolErr(err.message);
    }
    logger.error({ err }, 'mcp tool compare_specs failed');
    return toolErr('Internal error — comparison failed');
  }
}
