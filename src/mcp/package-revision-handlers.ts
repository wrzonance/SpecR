import { z } from 'zod';
import {
  createPackageRevision,
  getPackageRevision,
  PackageNotFoundError,
  SnapshotValidationError,
  RevisionNomenclatureValidationError,
  pool,
} from '../db/index.js';
import { StructuredCreateRevisionBodySchema } from '../ast/index.js';
import { getPgCode } from '../lib/pg-errors.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// Only the structured revision form is exposed (type + optional date/sortOrder/
// attributes); the legacy { label } body is deprecated. Reuse the REST schema's
// .shape so advertising and validation share one source of truth.
export const IssuePackageRevisionShape = {
  packageId: z.uuid().describe('Design package UUID (from list_packages)'),
  ...StructuredCreateRevisionBodySchema.shape,
};
const IssueArgs = z.object(IssuePackageRevisionShape);

export const GetRevisionShape = {
  revisionId: z.uuid().describe('Issued revision UUID (from issue_package_revision)'),
};
const GetArgs = z.object(GetRevisionShape);

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

function internalError(err: unknown, tool: string): ToolResult {
  logger.error({ err }, `mcp tool ${tool} failed`);
  return toolError(`Internal error — ${tool} failed`);
}

export async function handleIssuePackageRevision(args: unknown): Promise<ToolResult> {
  const parsed = IssueArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid issue_package_revision input: ${issues(parsed.error)}`);
  }
  const { packageId, ...body } = parsed.data;
  try {
    return ok(await createPackageRevision(packageId, body, pool));
  } catch (err) {
    if (err instanceof PackageNotFoundError) return toolError(`package not found: id=${packageId}`);
    // A member tree could not be snapshotted losslessly, or the type is not in the
    // project's revision-nomenclature profile — both are unprocessable inputs.
    if (err instanceof SnapshotValidationError) return toolError(err.message);
    if (err instanceof RevisionNomenclatureValidationError) return toolError(err.message);
    if (getPgCode(err) === '23505') return toolError('revision already exists for this package');
    return internalError(err, 'issue_package_revision');
  }
}

export async function handleGetRevision(args: unknown): Promise<ToolResult> {
  const parsed = GetArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid get_revision input: revisionId must be a UUID');
  }
  try {
    const revision = await getPackageRevision(parsed.data.revisionId, pool);
    if (revision === null) return toolError(`revision not found: id=${parsed.data.revisionId}`);
    return ok(revision);
  } catch (err) {
    // A snapshot that fails validation on read is a data-integrity failure, not a
    // client error — surface a generic internal error without leaking internals.
    return internalError(err, 'get_revision');
  }
}
