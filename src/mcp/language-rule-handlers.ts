import { z } from 'zod';
import {
  findLanguageRuleProfile,
  upsertLanguageRuleProfile,
  deleteLanguageRuleProfile,
  LanguageRuleValidationError,
  LanguageRuleScopeError,
} from '../db/index.js';
import type { LanguageRuleScopeKind } from '../db/index.js';
import { LanguageRulesSchema } from '../ast/index.js';
import type { LanguageRules } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// #411 / ADR-080 — MCP surface for a scope's language-rule profile (library
// or project). Mirrors src/api/language-rule-profiles.ts's REST handlers,
// which mirror src/mcp/header-footer-handlers.ts's SCOPE_META dispatch. No
// owner-existence pre-check is needed here either: findLanguageRuleProfile
// treats "no owner" and "no profile" as the same not-found result on read,
// and upsertLanguageRuleProfile's own assertOwnerExists already throws
// LanguageRuleScopeError for a missing owner on write.

interface ScopeMeta {
  readonly argKey: 'libraryId' | 'projectId';
}

const SCOPE_META: Record<LanguageRuleScopeKind, ScopeMeta> = {
  library: { argKey: 'libraryId' },
  project: { argKey: 'projectId' },
};

export const LibraryLanguageRulesShape = {
  libraryId: z.uuid().describe('Library UUID (from list_libraries)'),
};
export const ProjectLanguageRulesShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
};

export const SetLibraryLanguageRulesShape = {
  ...LibraryLanguageRulesShape,
  rules: LanguageRulesSchema,
};
export const SetProjectLanguageRulesShape = {
  ...ProjectLanguageRulesShape,
  rules: LanguageRulesSchema,
};

const LibraryArgs = z.object(LibraryLanguageRulesShape);
const ProjectArgs = z.object(ProjectLanguageRulesShape);
const SetLibraryArgs = z.object(SetLibraryLanguageRulesShape);
const SetProjectArgs = z.object(SetProjectLanguageRulesShape);

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

// LanguageRuleValidationError (unsafe/oversized regex) and LanguageRuleScopeError
// (write targeted a library/project that does not exist) are semantic write
// rejections from the DB layer — surface their message as a tool error.
// Anything else is unexpected and goes through internalError instead.
function languageRuleToolError(err: unknown): ToolResult | null {
  if (err instanceof LanguageRuleValidationError || err instanceof LanguageRuleScopeError) {
    return toolError(err.message);
  }
  return null;
}

async function runGet(kind: LanguageRuleScopeKind, id: string, tool: string): Promise<ToolResult> {
  try {
    const profile = await findLanguageRuleProfile({ scope: kind, ownerId: id });
    if (!profile) return toolError('no language-rule profile configured');
    return ok(profile);
  } catch (err) {
    return internalError(err, tool);
  }
}

async function runSet(
  kind: LanguageRuleScopeKind,
  id: string,
  rules: LanguageRules,
  tool: string
): Promise<ToolResult> {
  try {
    const saved = await upsertLanguageRuleProfile({ scope: kind, ownerId: id }, rules);
    return ok(saved);
  } catch (err) {
    return languageRuleToolError(err) ?? internalError(err, tool);
  }
}

async function runClear(
  kind: LanguageRuleScopeKind,
  id: string,
  tool: string
): Promise<ToolResult> {
  try {
    const deleted = await deleteLanguageRuleProfile({ scope: kind, ownerId: id });
    if (!deleted) return toolError('no language-rule profile configured');
    return ok({ [SCOPE_META[kind].argKey]: id, cleared: true });
  } catch (err) {
    return internalError(err, tool);
  }
}

// ─── Library scope ───────────────────────────────────────────────────────

export async function handleGetLibraryLanguageRules(args: unknown): Promise<ToolResult> {
  const parsed = LibraryArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid get_library_language_rules input: libraryId must be a UUID');
  }
  return runGet('library', parsed.data.libraryId, 'get_library_language_rules');
}

export async function handleSetLibraryLanguageRules(args: unknown): Promise<ToolResult> {
  const parsed = SetLibraryArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid set_library_language_rules input: ${issues(parsed.error)}`);
  }
  return runSet('library', parsed.data.libraryId, parsed.data.rules, 'set_library_language_rules');
}

export async function handleClearLibraryLanguageRules(args: unknown): Promise<ToolResult> {
  const parsed = LibraryArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid clear_library_language_rules input: libraryId must be a UUID');
  }
  return runClear('library', parsed.data.libraryId, 'clear_library_language_rules');
}

// ─── Project scope ───────────────────────────────────────────────────────

export async function handleGetProjectLanguageRules(args: unknown): Promise<ToolResult> {
  const parsed = ProjectArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid get_project_language_rules input: projectId must be a UUID');
  }
  return runGet('project', parsed.data.projectId, 'get_project_language_rules');
}

export async function handleSetProjectLanguageRules(args: unknown): Promise<ToolResult> {
  const parsed = SetProjectArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid set_project_language_rules input: ${issues(parsed.error)}`);
  }
  return runSet('project', parsed.data.projectId, parsed.data.rules, 'set_project_language_rules');
}

export async function handleClearProjectLanguageRules(args: unknown): Promise<ToolResult> {
  const parsed = ProjectArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid clear_project_language_rules input: projectId must be a UUID');
  }
  return runClear('project', parsed.data.projectId, 'clear_project_language_rules');
}
