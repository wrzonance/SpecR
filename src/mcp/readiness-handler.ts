// src/mcp/readiness-handler.ts
//
// ADR-079 (#406) — the readiness_report MCP tool: a dry-run view of the
// issuance-readiness gate, scoped to a single spec or an entire design
// package. Mirrors open-comments-handler.ts's shape exactly (same
// exactly-one-of scope resolution, same SpecNotFoundError/
// PackageNotFoundError -> distinct isError mapping) — a specifier can
// resolve blockers before attempting a Final issuance instead of
// discovering them from the gate's own 422.
import {
  getReadinessReport,
  SpecNotFoundError,
  PackageNotFoundError,
  type ReadinessScope,
} from '../db/index.js';
import type { ToolError, ToolResult } from './tool-result.js';

function toolErr(text: string): ToolError {
  return { isError: true, content: [{ type: 'text' as const, text }] };
}

// Resolve the scope from the two optional inputs: exactly one of specId/packageId.
export function resolveReadinessScope(
  specId: string | undefined,
  packageId: string | undefined
): ReadinessScope | ToolError {
  if (specId && packageId) {
    return toolErr('Provide exactly one of specId or packageId, not both');
  }
  if (specId) return { kind: 'spec', specId };
  if (packageId) return { kind: 'package', packageId };
  return toolErr('Provide one of specId (see get_spec) or packageId (see list_packages)');
}

export async function handleReadinessReport({
  specId,
  packageId,
}: {
  specId?: string | undefined;
  packageId?: string | undefined;
}): Promise<ToolResult> {
  const scope = resolveReadinessScope(specId, packageId);
  if ('isError' in scope) return scope;
  try {
    const report = await getReadinessReport(scope);
    return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
  } catch (err) {
    if (err instanceof SpecNotFoundError || err instanceof PackageNotFoundError) {
      return toolErr(err.message);
    }
    return toolErr('Internal error — readiness report failed');
  }
}
