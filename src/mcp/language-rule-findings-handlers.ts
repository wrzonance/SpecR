import { z } from 'zod';
import {
  getLanguageFindingsReport,
  ProjectNotFoundError,
  PackageNotFoundError,
} from '../db/index.js';
import { logger } from '../lib/logger.js';
import { toolError, ok, type ToolResult } from './handlers.js';

// #411 / ADR-080 — mirrors src/mcp/coordination-handler.ts's project +
// optional packageId scope pattern. `configured: false` is a normal
// successful result (opt-in linting, off for every present spec), never a
// tool error — only an unresolvable project/package id is.

export const LanguageFindingsShape = {
  projectId: z.uuid().describe('Project UUID (from list_projects)'),
  packageId: z.uuid().optional().describe('Design package UUID — scope the report to one package'),
};
const LanguageFindingsArgs = z.object(LanguageFindingsShape);

export async function handleGetLanguageFindings(args: unknown): Promise<ToolResult> {
  const parsed = LanguageFindingsArgs.safeParse(args);
  if (!parsed.success) {
    return toolError('invalid get_language_findings input: projectId must be a UUID');
  }
  try {
    const report = await getLanguageFindingsReport(parsed.data.projectId, parsed.data.packageId);
    return ok(report);
  } catch (err) {
    if (err instanceof ProjectNotFoundError || err instanceof PackageNotFoundError) {
      return toolError(err.message);
    }
    logger.error({ err }, 'mcp tool get_language_findings failed');
    return toolError('Internal error — get language findings failed');
  }
}
