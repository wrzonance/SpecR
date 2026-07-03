import { z } from 'zod';
import {
  createPackage,
  listPackages,
  setPackageSpecs,
  deletePackage,
  PackageNotFoundError,
  SpecNotInProjectError,
  pool,
} from '../db/index.js';
import { CreatePackageBodySchema, SetPackageSpecsBodySchema } from '../ast/index.js';
import { getPgCode } from '../lib/pg-errors.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Shapes reuse the REST body schemas via .shape (one source of truth), plus path params.
export const ProjectIdShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
};
const ProjectIdArgs = z.object(ProjectIdShape);

export const PackageIdShape = {
  packageId: z.uuid().describe('Design package UUID (from list_packages)'),
};
const PackageIdArgs = z.object(PackageIdShape);

export const CreatePackageShape = {
  ...ProjectIdShape,
  ...CreatePackageBodySchema.shape,
};
const CreateArgs = z.object(CreatePackageShape);

export const SetPackageSpecsShape = {
  ...PackageIdShape,
  ...SetPackageSpecsBodySchema.shape,
};
const SetSpecsArgs = z.object(SetPackageSpecsShape);

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

export async function handleListPackages(args: unknown): Promise<ToolResult> {
  const parsed = ProjectIdArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid list_packages input: projectId must be a UUID');
  }
  try {
    const packages = await listPackages(parsed.data.projectId, pool);
    if (packages === null) return toolError(`project not found: id=${parsed.data.projectId}`);
    return ok(packages);
  } catch (err) {
    return internalError(err, 'list_packages');
  }
}

export async function handleCreatePackage(args: unknown): Promise<ToolResult> {
  const parsed = CreateArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid create_package input: ${issues(parsed.error)}`);
  }
  const { projectId, name } = parsed.data;
  try {
    return ok(await createPackage(projectId, name, pool));
  } catch (err) {
    if (getPgCode(err) === '23503') return toolError(`project not found: id=${projectId}`);
    if (getPgCode(err) === '23505') {
      return toolError('package name already exists in this project');
    }
    return internalError(err, 'create_package');
  }
}

export async function handleSetPackageSpecs(args: unknown): Promise<ToolResult> {
  const parsed = SetSpecsArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid set_package_specs input: ${issues(parsed.error)}`);
  }
  const { packageId, specIds } = parsed.data;
  try {
    const specs = await setPackageSpecs(packageId, specIds, pool);
    return ok({ packageId, specs });
  } catch (err) {
    if (err instanceof PackageNotFoundError) return toolError(`package not found: id=${packageId}`);
    if (err instanceof SpecNotInProjectError) return toolError(err.message);
    return internalError(err, 'set_package_specs');
  }
}

export async function handleDeletePackage(args: unknown): Promise<ToolResult> {
  const parsed = PackageIdArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid delete_package input: packageId must be a UUID');
  }
  const { packageId } = parsed.data;
  try {
    const deleted = await deletePackage(packageId, pool);
    if (!deleted) return toolError(`package not found: id=${packageId}`);
    return ok({ deleted: true, packageId });
  } catch (err) {
    return internalError(err, 'delete_package');
  }
}
