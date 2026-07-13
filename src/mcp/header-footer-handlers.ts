import { z } from 'zod';
import {
  deleteHeaderFooterConfig,
  findHeaderFooterConfig,
  findLibraryById,
  HeaderFooterScopeError,
  HeaderFooterValidationError,
  upsertHeaderFooterConfig,
} from '../db/index.js';
import type { HeaderFooterScopeInput } from '../db/index.js';
import { HeaderFooterCompositionSchema } from '../ast/index.js';
import type { HeaderFooterComposition } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

type ScopeKind = 'client' | 'project' | 'package' | 'revision';

interface ScopeMeta {
  readonly argKey: 'libraryId' | 'projectId' | 'packageId' | 'revisionId';
  readonly toScopeInput: (id: string) => HeaderFooterScopeInput;
}

// Dispatch table shared by every runner below — mirrors SCOPE_META in
// src/api/header-footer.ts so the four scopes' only real difference (which
// arg key they're keyed on) stays out of the run*/handle* bodies.
const SCOPE_META: Record<ScopeKind, ScopeMeta> = {
  client: { argKey: 'libraryId', toScopeInput: (id) => ({ clientLibraryId: id }) },
  project: { argKey: 'projectId', toScopeInput: (id) => ({ projectId: id }) },
  package: { argKey: 'packageId', toScopeInput: (id) => ({ packageId: id }) },
  revision: { argKey: 'revisionId', toScopeInput: (id) => ({ revisionId: id }) },
};

export const LibraryHeaderFooterShape = {
  libraryId: z.uuid().describe('Client library UUID (from list_libraries)'),
};
export const ProjectHeaderFooterShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
};
export const PackageHeaderFooterShape = {
  packageId: z.uuid().describe('Design package UUID'),
};
export const RevisionHeaderFooterShape = {
  revisionId: z.uuid().describe('Package revision UUID'),
};

// CORRECTED (spike finding #1): nest the whole body as one opaque `config`
// field rather than spreading `HeaderFooterCompositionSchema.shape` into the
// args shape. That schema's catchall sits at the TOP level (unlike nested-
// field precedents elsewhere in this codebase), so flattening it into a
// plain z.object args shape would silently strip unrecognized top-level
// extension keys — verified live: HeaderFooterCompositionSchema.safeParse
// round-trips an extension key; z.object({...spread}).safeParse drops it.
export const SetLibraryHeaderFooterShape = {
  ...LibraryHeaderFooterShape,
  config: HeaderFooterCompositionSchema,
};
export const SetProjectHeaderFooterShape = {
  ...ProjectHeaderFooterShape,
  config: HeaderFooterCompositionSchema,
};
export const SetPackageHeaderFooterShape = {
  ...PackageHeaderFooterShape,
  config: HeaderFooterCompositionSchema,
};
export const SetRevisionHeaderFooterShape = {
  ...RevisionHeaderFooterShape,
  config: HeaderFooterCompositionSchema,
};

const LibraryArgs = z.object(LibraryHeaderFooterShape);
const ProjectArgs = z.object(ProjectHeaderFooterShape);
const PackageArgs = z.object(PackageHeaderFooterShape);
const RevisionArgs = z.object(RevisionHeaderFooterShape);

const SetLibraryArgs = z.object(SetLibraryHeaderFooterShape);
const SetProjectArgs = z.object(SetProjectHeaderFooterShape);
const SetPackageArgs = z.object(SetPackageHeaderFooterShape);
const SetRevisionArgs = z.object(SetRevisionHeaderFooterShape);

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

// HeaderFooterValidationError/HeaderFooterScopeError are semantic write
// rejections from the DB layer (malformed config, wrong-tier client scope,
// etc.) — surface their message as a tool error. Anything else is
// unexpected and goes through internalError instead.
function headerFooterToolError(err: unknown): ToolResult | null {
  if (err instanceof HeaderFooterValidationError || err instanceof HeaderFooterScopeError) {
    return toolError(err.message);
  }
  return null;
}

// Client scope is the one kind whose anchor (a library) has no other lookup
// that already errors on its absence, and whose DB-layer existence check
// (assertClientLibrary) throws the same error class for "not found" as it
// does for "wrong tier" — so without this pre-flight, a write against a
// missing library id would surface a generic write-rejection message
// instead of a clear "library not found".
async function requireClientLibrary(libraryId: string): Promise<ToolResult | null> {
  const library = await findLibraryById(libraryId);
  if (!library) return toolError(`library not found: id=${libraryId}`);
  return null;
}

async function runGetHeaderFooter(kind: ScopeKind, id: string, tool: string): Promise<ToolResult> {
  try {
    const found = await findHeaderFooterConfig(SCOPE_META[kind].toScopeInput(id));
    if (!found) return toolError('header/footer config not found');
    return ok(found);
  } catch (err) {
    return headerFooterToolError(err) ?? internalError(err, tool);
  }
}

async function runSetHeaderFooter(
  kind: ScopeKind,
  id: string,
  config: HeaderFooterComposition,
  tool: string
): Promise<ToolResult> {
  try {
    if (kind === 'client') {
      const guard = await requireClientLibrary(id);
      if (guard) return guard;
    }
    const saved = await upsertHeaderFooterConfig(SCOPE_META[kind].toScopeInput(id), config);
    return ok(saved);
  } catch (err) {
    return headerFooterToolError(err) ?? internalError(err, tool);
  }
}

async function runClearHeaderFooter(
  kind: ScopeKind,
  id: string,
  tool: string
): Promise<ToolResult> {
  try {
    if (kind === 'client') {
      const guard = await requireClientLibrary(id);
      if (guard) return guard;
    }
    const deleted = await deleteHeaderFooterConfig(SCOPE_META[kind].toScopeInput(id));
    if (!deleted) return toolError('header/footer config not found');
    return ok({ [SCOPE_META[kind].argKey]: id, cleared: true });
  } catch (err) {
    return headerFooterToolError(err) ?? internalError(err, tool);
  }
}

// ─── Library (client) scope ─────────────────────────────────────────────

export async function handleGetLibraryHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = LibraryArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid get_library_header_footer input: ${issues(parsed.error)}`);
  }
  return runGetHeaderFooter('client', parsed.data.libraryId, 'get_library_header_footer');
}

export async function handleSetLibraryHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = SetLibraryArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid set_library_header_footer input: ${issues(parsed.error)}`);
  }
  return runSetHeaderFooter(
    'client',
    parsed.data.libraryId,
    parsed.data.config,
    'set_library_header_footer'
  );
}

export async function handleClearLibraryHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = LibraryArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid clear_library_header_footer input: ${issues(parsed.error)}`);
  }
  return runClearHeaderFooter('client', parsed.data.libraryId, 'clear_library_header_footer');
}

// ─── Project scope ───────────────────────────────────────────────────────

export async function handleGetProjectHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = ProjectArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid get_project_header_footer input: ${issues(parsed.error)}`);
  }
  return runGetHeaderFooter('project', parsed.data.projectId, 'get_project_header_footer');
}

export async function handleSetProjectHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = SetProjectArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid set_project_header_footer input: ${issues(parsed.error)}`);
  }
  return runSetHeaderFooter(
    'project',
    parsed.data.projectId,
    parsed.data.config,
    'set_project_header_footer'
  );
}

export async function handleClearProjectHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = ProjectArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid clear_project_header_footer input: ${issues(parsed.error)}`);
  }
  return runClearHeaderFooter('project', parsed.data.projectId, 'clear_project_header_footer');
}

// ─── Package scope ───────────────────────────────────────────────────────

export async function handleGetPackageHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = PackageArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid get_package_header_footer input: ${issues(parsed.error)}`);
  }
  return runGetHeaderFooter('package', parsed.data.packageId, 'get_package_header_footer');
}

export async function handleSetPackageHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = SetPackageArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid set_package_header_footer input: ${issues(parsed.error)}`);
  }
  return runSetHeaderFooter(
    'package',
    parsed.data.packageId,
    parsed.data.config,
    'set_package_header_footer'
  );
}

export async function handleClearPackageHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = PackageArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid clear_package_header_footer input: ${issues(parsed.error)}`);
  }
  return runClearHeaderFooter('package', parsed.data.packageId, 'clear_package_header_footer');
}

// ─── Revision scope ──────────────────────────────────────────────────────

export async function handleGetRevisionHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = RevisionArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid get_revision_header_footer input: ${issues(parsed.error)}`);
  }
  return runGetHeaderFooter('revision', parsed.data.revisionId, 'get_revision_header_footer');
}

export async function handleSetRevisionHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = SetRevisionArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid set_revision_header_footer input: ${issues(parsed.error)}`);
  }
  return runSetHeaderFooter(
    'revision',
    parsed.data.revisionId,
    parsed.data.config,
    'set_revision_header_footer'
  );
}

export async function handleClearRevisionHeaderFooter(args: unknown): Promise<ToolResult> {
  const parsed = RevisionArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid clear_revision_header_footer input: ${issues(parsed.error)}`);
  }
  return runClearHeaderFooter('revision', parsed.data.revisionId, 'clear_revision_header_footer');
}
