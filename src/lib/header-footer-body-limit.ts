// src/lib/header-footer-body-limit.ts
//
// Shared source of truth for the header/footer composition JSON transport
// budget (#490, ADR-070). Lives in `lib/` — not `api/`, where the constant
// originally lived — because two consumers need it and module-boundaries.md
// forbids the dependency direction the old location implied:
//   - `src/api/header-footer-body-limit.ts` sizes the route-scoped
//     `express.json({ limit })` instance for the four composition PUT routes.
//   - `src/ast/header-footer-schemas.ts` enforces the SAME limit as a
//     parse-time invariant on the WRITE schema
//     (`HeaderFooterCompositionWriteSchema`) — every level of the composition
//     is `.catchall(JsonValue)`, so a structurally-valid write could still
//     carry unbounded extension data. The invariant is scoped to writes only;
//     the structural `HeaderFooterCompositionSchema` (reads/resolution/DOCX
//     capture) deliberately omits it so a merged multi-layer read never
//     inherits the per-write transport budget.
// `ast/` may only import `lib/` and its own siblings (never `api/`, which
// orchestrates every other module), so the constant has to live somewhere
// both can reach — `lib/` is exactly that shared leaf.
import { MAX_IMAGE_BASE64_LENGTH } from './image-media-type.js';

/**
 * Headroom above one max-sized image for the surrounding JSON structure — the
 * composition envelope, other header/footer cells, and their non-image text
 * runs. Deliberately generous: a composition with several near-max-sized
 * images can still exceed this derived limit despite each field individually
 * passing the AST schema's own per-field bound — an accepted limitation, not
 * a bug, since the byte budget here covers exactly the one-image case the
 * issue describes (see ADR-070, "Single-image sizing is an accepted,
 * documented limitation").
 */
export const HEADER_FOOTER_BODY_ENVELOPE_BYTES = 262_144; // 256 KiB

/**
 * Route-scoped JSON body-size limit for header/footer composition writes,
 * derived from (never hardcoded independently of) `MAX_IMAGE_BASE64_LENGTH`
 * so it can never silently fall out of sync with the image cap it exists to
 * accommodate. This is the SAME number both the transport dispatch
 * (`src/api/header-footer-body-limit.ts`) and the schema's own size
 * invariant (`src/ast/header-footer-schemas.ts`) enforce — a single derived
 * constant, not two hand-copied ones that could drift apart.
 */
export const HEADER_FOOTER_JSON_BODY_LIMIT_BYTES =
  MAX_IMAGE_BASE64_LENGTH + HEADER_FOOTER_BODY_ENVELOPE_BYTES;
