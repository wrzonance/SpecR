import { z } from 'zod';
import type { Request, Response } from 'express';

const UUID_SCHEMA = z.uuid();

/**
 * Validates a UUID-typed path param before it ever reaches a query. Every
 * uuid-typed column in this codebase rejects a malformed value with pg
 * 22P02, which `src/lib/pg-errors.ts` does not map — left unguarded that
 * surfaces as an unmapped 500 for what is a plain client input error (#568).
 *
 * On success, returns the parsed uuid string and writes nothing. On failure
 * (missing or malformed), writes the 400 response — byte-identical to the
 * pattern already used by `src/api/templates-crud.ts`'s `parseId` and the
 * five pre-existing inline `z.uuid().safeParse` sites in `projects.ts` — and
 * returns `null`. The caller must `return` immediately on `null`; this
 * function never throws and never imports `../db/index.js`, so a DB round
 * trip on an invalid id is structurally unreachable.
 */
export function parsePathUuid(
  req: Request,
  res: Response,
  label: string,
  paramName = 'id'
): string | null {
  const result = UUID_SCHEMA.safeParse(req.params[paramName]);
  if (!result.success) {
    res.status(400).json({ success: false, error: `invalid ${label}` });
    return null;
  }
  return result.data;
}
