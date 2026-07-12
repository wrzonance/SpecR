// src/lib/zod-issues.ts
// Single shared formatter for Zod validation failures surfaced to callers (REST 422 bodies,
// MCP tool error content). Keeps the "; "-joined message shape consistent across both
// surfaces instead of each handler module re-declaring its own `issues()` helper.

import type { z } from 'zod';

/** Joins every issue's message with "; " — no path prefixes, matching existing usage. */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => issue.message).join('; ');
}
