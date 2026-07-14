// Pure header/footer scope-resolution helpers for the demo's Effective
// Resolution panel (#477).
//
// GET /projects/:id/header-footer/resolved returns a `ResolvedHeaderFooterConfig`
// (src/db/queries/header-footer.ts) verbatim — `context` + `layers` + the
// merged `config`, with NO invented `winningScope` field (see
// src/api/header-footer-resolve.ts's response comment: "the winning scope is
// layers[layers.length - 1].scope"). This module derives that same coarse
// read client-side so the demo panel can badge which scope actually won,
// without ever re-deriving the server's per-key/per-region merge itself —
// that logic stays server-only, always.
//
// Every export here is pure: no DOM, no fetch, never mutates an argument
// (house rule).

/**
 * The scope that won the merge, or `null` when `layers` is empty — no
 * override configured anywhere in the chain, so the resolved config is the
 * generator's hard-coded default. Deliberately coarse: the LAST layer in the
 * array wins in full, not a per-field composite — mirrors
 * src/db/queries/header-footer.ts's resolution order exactly. Never derive
 * this from `context` or by inspecting `config` instead; `layers` is the one
 * source of truth for "who won". Tolerates a null/undefined/non-array
 * `layers` without throwing.
 */
export function winningScope(layers) {
  const list = Array.isArray(layers) ? layers : [];
  return list.at(-1)?.scope ?? null;
}

// Mirrors src/db/queries/header-footer.ts's HeaderFooterScope union exactly
// (kept in hand-lockstep — see header-footer-fields.mjs's module doc for why
// the demo can't import src/*.ts directly).
const SCOPE_KINDS = ['client', 'project', 'package', 'revision'];

/**
 * A human-readable label for `scope` — a `HeaderFooterScope` as returned by
 * {@link winningScope}, or exactly `null` for "no override configured
 * anywhere in the chain". Exhaustive over all 4 scope kinds plus `null`:
 * throws on any other value (an unrecognized `kind`, a missing `kind`, or
 * `undefined` — only the literal `null` means "no override") rather than
 * returning a blank/default label, so a scope kind added to the schema
 * without a matching demo label fails loudly instead of silently
 * mislabeling the winning scope.
 */
export function scopeLabel(scope) {
  const kind = scope === null ? null : scope?.kind;
  switch (kind) {
    case null:
      return 'No override configured';
    case 'client':
      return 'Client library';
    case 'project':
      return 'Project';
    case 'package':
      return 'Package';
    case 'revision':
      return 'Revision';
    default:
      throw new Error(
        `scopeLabel: unrecognized header/footer scope kind '${String(kind)}' — expected one of ${SCOPE_KINDS.join(', ')}, or null`
      );
  }
}
