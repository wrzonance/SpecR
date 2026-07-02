import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { McpError } from './error.js';

export type ToolTier = 'read' | 'write' | 'destructive';
export const TOOL_TIER_VALUES: readonly ToolTier[] = ['read', 'write', 'destructive'];

export function isToolTier(v: string): v is ToolTier {
  return (TOOL_TIER_VALUES as readonly string[]).includes(v);
}

export function parseAllowedTiers(raw: string): ReadonlySet<ToolTier> {
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const tiers = new Set<ToolTier>();
  for (const token of tokens) {
    if (!isToolTier(token)) {
      throw new McpError(
        `invalid MCP capability tier "${token}" (expected read|write|destructive)`
      );
    }
    tiers.add(token);
  }
  return tiers;
}

export function tierAnnotations(tier: ToolTier): ToolAnnotations {
  if (tier === 'read') return { readOnlyHint: true };
  if (tier === 'destructive') return { readOnlyHint: false, destructiveHint: true };
  return { readOnlyHint: false, destructiveHint: false };
}

// Single source of truth for every registered tool's capability tier. The contract
// test (Task 6) fails the build if a registered tool is missing here, and the registrar
// (Task 3) throws at boot for the same reason — so this map cannot fall out of date.
export const TOOL_TIERS: ReadonlyMap<string, ToolTier> = new Map([
  // reads
  ['search_library', 'read'],
  ['list_libraries', 'read'],
  ['list_sections', 'read'],
  ['list_projects', 'read'],
  ['get_references', 'read'],
  ['get_spec', 'read'],
  ['get_paragraph', 'read'],
  ['get_spec_lineage', 'read'],
  ['get_spec_diff', 'read'],
  ['get_numbering_profile', 'read'],
  ['generate_docx', 'read'],
  ['coordination_report', 'read'],
  ['submittal_register', 'read'],
  ['open_comments_report', 'read'],
  ['get_onboarding_report', 'read'],
  ['review_editability', 'read'],
  // writes (persist state)
  ['create_project', 'write'],
  ['parse_document', 'write'],
  ['load_files', 'write'],
  ['set_editability_override', 'write'],
  ['clear_editability_override', 'write'],
  ['reclassify_spec', 'write'],
]);
