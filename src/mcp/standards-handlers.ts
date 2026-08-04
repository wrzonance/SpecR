import { z } from 'zod';
import {
  getStandardsRollup,
  recordStandardVerification,
  ProjectNotFoundError,
  LibraryNotFoundError,
  type StandardsScope,
  type RecordVerificationInput,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { codePointMax } from '../lib/length-limit.js';
import {
  MAX_CURRENT_VERSION_LENGTH,
  MAX_SOURCE_URL_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_NOTES_LENGTH,
} from '../lib/standards-verification-length.js';
import { toolError, ok, type ToolResult } from './handlers.js';

export const ListLibraryStandardsShape = {
  libraryId: z.uuid().describe('Library UUID (from list_libraries)'),
};
const ListLibraryStandardsArgs = z.object(ListLibraryStandardsShape);

export const ListProjectStandardsShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
};
const ListProjectStandardsArgs = z.object(ListProjectStandardsShape);

export const RecordStandardVerificationShape = {
  // trim before min(1): a whitespace-only code trims to '' downstream, colliding
  // with the org-only key ADR-064 §2 reserves for ambiguous citations.
  orgCode: z
    .string()
    .trim()
    .min(1)
    .describe('Standards org code, e.g. ASTM (normalized to uppercase)'),
  standardCode: z.string().trim().min(1).describe('Standard identifier within the org, e.g. C150'),
  status: z
    .enum(['current', 'superseded', 'withdrawn', 'unknown'])
    .optional()
    .describe('Currency verdict (default unknown)'),
  // #642, ADR-091: bounded in Unicode code points via the MAX_* constants
  // (src/lib/standards-verification-length.ts), shared with the REST twin
  // (VerificationBodySchema, src/api/standards.ts) even though this shape
  // doesn't reuse that validator.
  //
  // `.trim()` before `.min(1)` matches the REST twin exactly, and orgCode /
  // standardCode above for the same reason. It is not cosmetic: without it
  // these two fields NORMALIZED differently across the two surfaces — MCP
  // accepted a whitespace-only title that REST rejects, and counted padding
  // toward the bound that REST trims away. ADR-026 makes openapi.yaml
  // authoritative and ADR-044 binds this tool surface to REST, so REST is the
  // reference side. A shared bound is not parity if the two sides disagree
  // about which string the bound applies to.
  currentVersion: codePointMax(z.string().trim().min(1), MAX_CURRENT_VERSION_LENGTH, {
    description: 'Current published version/designation.',
  }).optional(),
  sourceUrl: codePointMax(z.url(), MAX_SOURCE_URL_LENGTH, {
    description: 'Authoritative source URL for the standard.',
  }).optional(),
  title: codePointMax(z.string().trim().min(1), MAX_TITLE_LENGTH, {
    description: 'Standard title.',
  }).optional(),
  notes: codePointMax(z.string(), MAX_NOTES_LENGTH, {
    description: 'Reviewer notes.',
  }).optional(),
};
const RecordStandardVerificationArgs = z.object(RecordStandardVerificationShape);

function issues(err: z.ZodError): string {
  return err.issues.map((i) => i.message).join('; ');
}

async function rollup(scope: StandardsScope, tool: string): Promise<ToolResult> {
  try {
    return ok(await getStandardsRollup(scope));
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof LibraryNotFoundError) {
      return toolError(err.message);
    }
    logger.error({ err }, `mcp tool ${tool} failed`);
    return toolError(`Internal error — ${tool} failed`);
  }
}

export async function handleListLibraryStandards(args: unknown): Promise<ToolResult> {
  const parsed = ListLibraryStandardsArgs.safeParse(args);
  if (!parsed.success)
    return toolError('invalid list_library_standards input: libraryId must be a UUID');
  return rollup({ kind: 'library', id: parsed.data.libraryId }, 'list_library_standards');
}

export async function handleListProjectStandards(args: unknown): Promise<ToolResult> {
  const parsed = ListProjectStandardsArgs.safeParse(args);
  if (!parsed.success)
    return toolError('invalid list_project_standards input: projectId must be a UUID');
  return rollup({ kind: 'project', id: parsed.data.projectId }, 'list_project_standards');
}

export async function handleRecordStandardVerification(args: unknown): Promise<ToolResult> {
  const parsed = RecordStandardVerificationArgs.safeParse(args);
  if (!parsed.success) {
    return toolError(`invalid record_standard_verification input: ${issues(parsed.error)}`);
  }
  const input: RecordVerificationInput = parsed.data;
  try {
    return ok(await recordStandardVerification(input));
  } catch (err) {
    logger.error({ err }, 'mcp tool record_standard_verification failed');
    return toolError('Internal error — record_standard_verification failed');
  }
}
