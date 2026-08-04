/**
 * Unicode-code-point length enforcement (#642, ADR-091 — supersedes ADR-088).
 *
 * JSON Schema's `maxLength` keyword is defined in Unicode CODE POINTS
 * (draft-04 through 2020-12, unchanged wording). Zod's own `.max()` /
 * `z.maxLength()` delegate to `String.prototype.length` — UTF-16 CODE UNITS —
 * so for any character outside the Basic Multilingual Plane (emoji, many CJK
 * Extension B+ characters, mathematical alphanumeric symbols) the two counts
 * diverge by up to 2x. ADR-088 documented that divergence as an interim step;
 * this module is the end state: enforce what the published contract says.
 *
 * `codePointMax` is the ONLY way any call site should bound a string's
 * length. It ties the enforced bound (a `.refine()`) and the published one
 * (a `.meta({ maxLength })`) to a single argument `n`, so the two numbers
 * cannot drift apart by construction — the drift problem ADR-088 named as
 * needing "a deliberate helper plus its own drift gate, not ad-hoc
 * duplication at each site".
 */
import { z } from 'zod';

/** Vendor-extension `.meta()` key every `codePointMax`-built field carries. */
export const LENGTH_UNIT_META_KEY = 'x-length-unit';

/** Value of {@link LENGTH_UNIT_META_KEY} on every `codePointMax`-built field. */
export const CODE_POINT_LENGTH_UNIT = 'unicode-code-point';

/**
 * Unicode code points in `value` — the unit JSON Schema's `maxLength`
 * keyword is defined in. Surrogate-pair aware via `for...of`.
 *
 * When `limit` is given, counting short-circuits the instant the running
 * count exceeds it, so a caller that only needs "is this over the limit"
 * (e.g. the ~7 MB `imageData` field) never materializes a multi-million-
 * element array the way `[...value].length` would on every validation call.
 */
export function codePointLength(value: string, limit?: number): number {
  let count = 0;
  const iterator = value[Symbol.iterator]();
  for (let step = iterator.next(); step.done !== true; step = iterator.next()) {
    count += 1;
    if (limit !== undefined && count > limit) return count;
  }
  return count;
}

export interface CodePointMaxOptions {
  /** Custom rejection message (e.g. imageData's existing custom text). */
  readonly message?: string;
  /**
   * Full replacement description for the field. `codePointMax` must be the
   * terminal call in a field's chain before `.optional()` / `.nullish()` /
   * `.exactOptional()`, so passing this here is the one place to set it.
   */
  readonly description?: string;
}

/**
 * Bounds an already-configured Zod string schema (post `.trim()`, `.min()`,
 * `z.url()`, etc.) to `n` UNICODE CODE POINTS — enforced via `.refine()` and
 * published via `.meta({ maxLength: n, [LENGTH_UNIT_META_KEY]: ... })` from
 * the single argument `n`.
 *
 * Chaining order is `.refine()` then `.meta()`. Verified against the pinned
 * toolchain (zod 4.4.3, MCP SDK 1.29.0) that both orders publish `maxLength`
 * identically through the generated JSON Schema — this order is kept
 * defensively, not because a reorder is the live bug on this toolchain (see
 * ADR-091). The failure mode that DOES reproduce is omitting `.meta()`
 * entirely, which publishes no `maxLength` at all; `length-limit.test.ts`
 * pins that with a mutation-verified assertion on the generated schema.
 */
export function codePointMax<T extends z.ZodType<string, string>>(
  schema: T,
  n: number,
  options: CodePointMaxOptions = {}
): T {
  const described =
    options.description !== undefined ? schema.describe(options.description) : schema;
  return described
    .refine((value: string) => codePointLength(value, n) <= n, {
      error: options.message ?? `must be at most ${n} Unicode code points`,
    })
    .meta({ maxLength: n, [LENGTH_UNIT_META_KEY]: CODE_POINT_LENGTH_UNIT });
}
