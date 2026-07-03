import { z } from 'zod';
import {
  listRequiredSections,
  setRequiredSections,
  seedRequiredSections,
  RequiredSectionsProjectNotFoundError,
  RequiredSectionsPackageNotFoundError,
  RequiredSectionsSeedConflictError,
  RequiredSectionsInvalidSeedError,
  pool,
} from '../db/index.js';
import type { RequiredScope, SeedSource, RequiredSection } from '../db/index.js';
import { RequiredSectionsBodySchema } from '../ast/index.js';
import type { RequiredSectionsBody } from '../ast/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Shapes exported so the tools advertise exactly what the handlers validate. The body
// (sections XOR seedFrom, with its cross-field refine) is validated separately from the
// path ids so the refine survives (RequiredSectionsBodySchema strips the id keys).
export const RequiredSectionsProjectShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
};
const ProjectScopeArgs = z.object(RequiredSectionsProjectShape);

export const RequiredSectionsPackageShape = {
  ...RequiredSectionsProjectShape,
  packageId: z.uuid().describe('Design-package UUID (from get_project / list_packages)'),
};
const PackageScopeArgs = z.object(RequiredSectionsPackageShape);

export const SetRequiredSectionsShape = {
  ...RequiredSectionsProjectShape,
  ...RequiredSectionsBodySchema.shape,
};
export const SetPackageRequiredSectionsShape = {
  ...RequiredSectionsPackageShape,
  ...RequiredSectionsBodySchema.shape,
};

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function seedSourceFrom(seedFrom: NonNullable<RequiredSectionsBody['seedFrom']>): SeedSource {
  if (seedFrom === 'baseline') return { from: 'baseline' };
  if (seedFrom === 'toc') return { from: 'toc' };
  return { from: 'package', packageId: seedFrom.packageId };
}

// Seed from a source, or set an explicit list — mirrors the REST applyBody.
async function applyRequiredSections(
  scope: RequiredScope,
  body: RequiredSectionsBody
): Promise<readonly RequiredSection[]> {
  if (body.seedFrom !== undefined) {
    return seedRequiredSections(scope, seedSourceFrom(body.seedFrom), pool);
  }
  return setRequiredSections(scope, body.sections ?? [], pool);
}

// Map the typed required-sections errors to tool errors (REST 404/409/422); else null.
function requiredSectionsToolError(err: unknown): ToolResult | null {
  if (
    err instanceof RequiredSectionsProjectNotFoundError ||
    err instanceof RequiredSectionsPackageNotFoundError ||
    err instanceof RequiredSectionsSeedConflictError ||
    err instanceof RequiredSectionsInvalidSeedError
  ) {
    return toolError(err.message);
  }
  return null;
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

export async function handleGetRequiredSections(args: unknown): Promise<ToolResult> {
  const parsed = ProjectScopeArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid get_required_sections input: projectId must be a UUID');
  }
  try {
    return ok(await listRequiredSections({ kind: 'baseline', projectId: parsed.data.projectId }));
  } catch (err) {
    return requiredSectionsToolError(err) ?? internalError(err, 'get_required_sections');
  }
}

export async function handleSetRequiredSections(args: unknown): Promise<ToolResult> {
  const scope = ProjectScopeArgs.safeParse(args);
  if (!scope.success) {
    return toolError('invalid set_required_sections input: projectId must be a UUID');
  }
  const body = RequiredSectionsBodySchema.safeParse(args);
  if (!body.success) {
    return toolError(`invalid set_required_sections input: ${issues(body.error)}`);
  }
  try {
    const scopeRef: RequiredScope = { kind: 'baseline', projectId: scope.data.projectId };
    return ok(await applyRequiredSections(scopeRef, body.data));
  } catch (err) {
    return requiredSectionsToolError(err) ?? internalError(err, 'set_required_sections');
  }
}

export async function handleGetPackageRequiredSections(args: unknown): Promise<ToolResult> {
  const parsed = PackageScopeArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(
      'invalid get_package_required_sections input: projectId and packageId must be UUIDs'
    );
  }
  try {
    const { projectId, packageId } = parsed.data;
    return ok(await listRequiredSections({ kind: 'package', projectId, packageId }));
  } catch (err) {
    return requiredSectionsToolError(err) ?? internalError(err, 'get_package_required_sections');
  }
}

export async function handleSetPackageRequiredSections(args: unknown): Promise<ToolResult> {
  const scope = PackageScopeArgs.safeParse(args);
  if (!scope.success) {
    return toolError(
      'invalid set_package_required_sections input: projectId and packageId must be UUIDs'
    );
  }
  const body = RequiredSectionsBodySchema.safeParse(args);
  if (!body.success) {
    return toolError(`invalid set_package_required_sections input: ${issues(body.error)}`);
  }
  try {
    const { projectId, packageId } = scope.data;
    const scopeRef: RequiredScope = { kind: 'package', projectId, packageId };
    return ok(await applyRequiredSections(scopeRef, body.data));
  } catch (err) {
    return requiredSectionsToolError(err) ?? internalError(err, 'set_package_required_sections');
  }
}
