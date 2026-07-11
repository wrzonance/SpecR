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
  currentVersion: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Current published version/designation'),
  sourceUrl: z.url().max(2000).optional().describe('Authoritative source URL for the standard'),
  title: z.string().min(1).max(500).optional().describe('Standard title'),
  notes: z.string().max(5000).optional().describe('Reviewer notes'),
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
