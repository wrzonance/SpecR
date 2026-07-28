import { buildComparisonReport, ReportingError, SpecNotFoundError } from '../reporting/index.js';
import { logger } from '../lib/logger.js';
import { anchorsMeta, type McpAnchor } from './anchors.js';
import type { ComparisonReport, CompareSource } from '../reporting/index.js';
import type { ToolError, ToolResult } from './tool-result.js';

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

/** Every present cell → a navigation anchor (section + real spec + paragraph
 *  UUID), so a UI client can trace each grounded fact back to its source.
 *  `row.cells` is index-aligned to `report.columns` (ComparisonMatrixRow,
 *  src/reporting/types.ts), so each cell is matched to its own column
 *  positionally — never by a `specId`-keyed lookup. Two columns can legally
 *  share a specId (the same spec frozen at two different revisions, or a
 *  live spec vs. its own frozen snapshot, #392), and a specId-keyed map would
 *  collapse to one column's section for every such cell. */
function anchorsFromReport(report: ComparisonReport): McpAnchor[] {
  const out: McpAnchor[] = [];
  for (const row of report.rows) {
    row.cells.forEach((cell, columnIndex) => {
      if (!cell.present) return;
      const column = report.columns[columnIndex];
      if (column !== undefined) {
        out.push({ section: column.section, specId: cell.specId, paragraphId: cell.paragraphUuid });
      }
    });
  }
  return out;
}

export async function handleCompareSpecs({
  sources,
  baseline,
  alignment,
  include,
}: {
  sources: CompareSource[];
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
