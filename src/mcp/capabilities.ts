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
  ['get_project', 'read'],
  ['get_references', 'read'],
  ['get_spec', 'read'],
  ['get_paragraph', 'read'],
  ['get_spec_lineage', 'read'],
  ['get_spec_diff', 'read'],
  ['get_numbering_profile', 'read'],
  ['generate_docx', 'read'],
  ['coordination_report', 'read'],
  ['get_project_keynotes', 'read'],
  ['list_revit_links', 'read'],
  ['compare_specs', 'read'],
  ['submittal_register', 'read'],
  ['open_comments_report', 'read'],
  ['get_onboarding_report', 'read'],
  ['review_editability', 'read'],
  // writes (persist state)
  ['create_project', 'write'],
  ['update_project', 'write'],
  ['restore_project', 'write'],
  ['parse_document', 'write'],
  ['load_files', 'write'],
  ['set_editability_override', 'write'],
  ['clear_editability_override', 'write'],
  ['reclassify_spec', 'write'],
  // wave 3 — paragraphs, associations, comment resolution
  ['update_paragraph', 'write'],
  ['insert_paragraph', 'write'], // sibling insert after an anchor (#372)
  ['remove_paragraph', 'write'], // reversible soft removal (vanish), not a hard delete
  ['list_associations', 'read'],
  ['create_association', 'write'],
  ['accept_comment_as_note', 'write'],
  // wave 4 — spec lifecycle
  ['update_spec', 'write'],
  ['finalize_spec', 'write'],
  ['reopen_spec', 'write'],
  ['restore_spec', 'write'],
  // wave 5 — merge
  ['apply_merge', 'write'],
  // wave 6 — assignment (numbering profile / style source / lock); all reversible config
  ['get_spec_lock', 'read'],
  ['lock_spec', 'write'],
  ['unlock_spec', 'write'],
  ['assign_style_source', 'write'],
  ['clear_style_source', 'write'],
  ['assign_numbering_profile', 'write'],
  ['clear_numbering_profile', 'write'],
  // wave 7a — style-template config CRUD
  ['list_templates', 'read'],
  ['get_template', 'read'],
  ['create_template', 'write'],
  ['update_template', 'write'],
  ['upsert_template_rules', 'write'],
  ['import_template', 'write'],
  // wave 7b — editing-convention config CRUD
  ['list_conventions', 'read'],
  ['get_library_conventions', 'read'],
  ['set_library_conventions', 'write'],
  ['clone_conventions', 'write'],
  // wave 7c — required-sections config (project + package scope)
  ['get_required_sections', 'read'],
  ['get_package_required_sections', 'read'],
  ['set_required_sections', 'write'],
  ['set_package_required_sections', 'write'],
  // wave 7d — revision-nomenclature config (project scope)
  ['list_revision_nomenclature_profiles', 'read'],
  ['get_project_revision_nomenclature', 'read'],
  ['set_project_revision_nomenclature', 'write'],
  ['clone_project_revision_nomenclature', 'write'],
  ['clear_project_revision_nomenclature', 'write'], // clears override (reversible), not destructive
  // wave 7e — numbering-profile management (library-scoped CRUD + snapshot)
  ['list_library_numbering_profiles', 'read'],
  ['get_numbering_profile_by_id', 'read'],
  ['snapshot_numbering_profile', 'read'], // pure extraction from an uploaded .docx, persists nothing
  ['create_library_numbering_profile', 'write'],
  ['update_numbering_profile', 'write'],
  // wave 7f — library management (rename / list specs / create client library)
  ['list_library_specs', 'read'],
  ['rename_library', 'write'],
  ['create_client_library', 'write'],
  // wave 7g — division general-spec (library + project scope). The "get" tools are
  // write-tier: despite mirroring a REST GET, they auto-resolve by persisting the
  // exact-section config (upsertExactConfig writes division_general_specs), so the
  // capability model must gate them as writes — a read-only agent must not trigger a DB write.
  ['get_library_general_spec', 'write'],
  ['get_project_general_spec', 'write'],
  ['set_library_general_spec', 'write'],
  ['set_project_general_spec', 'write'],
  // wave 2a — project section membership + sources
  ['add_project_section', 'write'],
  ['set_project_sources', 'write'],
  // wave 2b — design packages
  ['list_packages', 'read'],
  ['create_package', 'write'],
  ['set_package_specs', 'write'],
  // wave 2c — package revisions (issue / read) — final ops for full REST↔MCP parity
  ['get_revision', 'read'],
  ['issue_package_revision', 'write'],
  // destructive (gated off by default — MCP_ALLOWED_TIERS excludes it)
  ['delete_project', 'destructive'],
  ['delete_association', 'destructive'], // hard delete of the link row
  ['delete_spec', 'destructive'], // soft withdraw of a library master (ADR-030)
  ['delete_template', 'destructive'], // hard delete of a style template (RESTRICT if in use)
  ['delete_numbering_profile', 'destructive'], // hard delete (RESTRICT if assigned to any spec)
  ['remove_project_section', 'destructive'], // hard delete of the project's cloned section (force can drop edits)
  ['delete_package', 'destructive'], // hard delete; CASCADEs membership + issued revisions + snapshots
]);
