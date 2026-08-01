// src/lib/discipline-filter.ts
// Single shared normalization for the optional `discipline` listing filter (ADR-065), imported by
// the REST routes (GET /libraries/{id}/specs, GET /projects/{id}/specs) and the MCP
// list_library_specs / list_project_specs tools so the two surfaces cannot drift (#548).
//
// A blank or whitespace-only value means "no filter", not "match the empty discipline key":
// a caller that builds a query string from a cleared form field sends `?discipline=`, and
// answering that with `[]` from a library that demonstrably has specs is a silent wrong answer.
// Blank is normalized, never rejected — `?discipline=` conventionally means unset, and a 400 /
// tool error is worse for agent callers than treating it as absent.

import { z } from 'zod';

/**
 * Optional discipline filter: trims the value, and yields `undefined` (no filter) for an
 * absent, empty, or whitespace-only value. A non-string input — e.g. a repeated
 * `?discipline=a&discipline=b` arriving as an array — still fails to parse, so each surface
 * keeps its existing "must be a single value" 400 / tool error.
 *
 * The transform is deliberately idempotent: on the MCP path the SDK parses `args` against the
 * tool's input shape before the handler runs, and the handler then re-parses the same value.
 */
export const DisciplineFilter = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  });
