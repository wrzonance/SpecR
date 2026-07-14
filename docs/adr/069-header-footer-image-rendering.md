# ADR-069: header/footer image rendering (logo egress)

## Status

Accepted

## Context

#301 (the header/footer fidelity umbrella) shipped the v2 composition
schema (ADR-040, #302), the capture pipeline (ADR-068, #306), and
text/field rendering (#303) — all deliberately excluding image content to
keep that first renderer slice small. #308 is the follow-up: render
supported image/logo content that a firm or client header/footer
composition carries, so the acceptance criteria left open by #301
("Logo fixture renders into header/footer output", "Unknown image
properties remain preserved or warned", "Existing text/field H/F
rendering does not regress") are met.

`HeaderFooterFieldSchema` (`src/ast/header-footer-schemas.ts`) is the
same open, `.catchall(JsonValue)` shape ADR-021 established for every
JSONB-backed config object in this repo: known keys are typed, unknown
keys pass through unchanged. Adding an `'image'` field kind means the
generator (`src/generator/header-footer-fields.ts`,
`header-footer-regions.ts`, `header-footer.ts`) needs to actually turn
image bytes into a rendered `docx.ImageRun`, sitting alongside the
existing `TextRun` fields resolved by `FIELD_RESOLVERS`
(`resolveValueField`, `resolveSectionNumber`, `resolvePageNumber`,
`resolveLiteral`).

A pre-implementation spike (per this repo's design-first loop) surfaced
two corrections to the original task design, recorded below. Neither
changes the shapes in the design — one removes dead defensive code found
to be genuinely unreachable, the other decomposes one function to satisfy
this repo's enforced `complexity: 10` ESLint rule. Both are recorded here
so a future reader sees *why*, not just *what*.

## Decision

### A new field kind, not a new node type

`'image'` is added to `HeaderFooterFieldKindSchema`
(`src/ast/header-footer-schemas.ts`) as a thirteenth member alongside the
existing twelve (`date`, `sectionTitle`, `sectionNumber`, `pageNumber`,
`packageName`, `revisionName`, `revisionLabel`, `projectName`,
`projectNumber`, `clientName`, `clientNumber`, `literal`). An image field
lives in `HeaderFooterCell.content[]` exactly like a text field — a cell
can mix text and image fields in any order — rather than introducing a
parallel `region.image` slot. This keeps the left/center/right cell
model (ADR-040) as the single place content is authored, and means the
existing tab-stop layout (`regionChildren`,
`header-footer-regions.ts`) does not need a second code path for image
placement.

The field gains five new, all-optional, flat properties on
`HeaderFooterFieldSchema`: `imageData` (base64), `imageMediaType`
(open string, mirroring `ruleLine.style`'s pattern of an unconstrained
round-trippable value rather than a closed enum), `widthEmu`/`heightEmu`
(positive integers — EMU, matching OOXML's own native drawing unit so no
lossy pixel/twip conversion happens at the schema boundary), and
`altText`. `imageData`'s `.refine()` caps its base64 *string* length at
`MAX_IMAGE_BASE64_LENGTH` (`src/lib/image-media-type.ts`) rather than a
decoded-byte cap, so oversized payloads are rejected by Zod before any
buffer is materialized — the same encoded-length-first posture
`decodeBase64Payload` (`src/lib/decode-base64.ts`) already uses for MCP
file payloads.

### Media type is sniffed from bytes, never trusted from the field

`imageMediaType` is round-tripped as open, author-supplied metadata (a
capture might record what the source OOXML declared), but rendering
never trusts it. `sniffImageMediaType` (`src/lib/image-media-type.ts`)
reads the image's magic-byte signature and returns one of the four types
`docx`'s `ImageRun` actually supports (`image/png`, `image/jpeg`,
`image/gif`, `image/bmp`) or `undefined`. `renderImageRun` always passes
the **sniffed** type to `ImageRun`'s `type` option, never the declared
`imageMediaType` — a mismatched or stale declared type (e.g. captured
from a source document that mislabeled it) cannot make the renderer emit
a `type` that disagrees with the actual bytes, which would produce a
corrupt document Word refuses to open. A declared/sniffed mismatch is
instead surfaced as a warning (`mediaTypeMismatchWarning`), not silently
corrected and not fatal.

### `renderImageRun` is pure and total — no try/catch, by verified fact, not by design assumption

The original task design specified `renderImageRun` wrapping the
`ImageRun` construction in a try/catch, logging a warning via the pino
logger on failure, matching the "never throws" contract this module's
neighboring functions already document (`resolveFieldChildren`,
`renderHeaderFooterComposition`). The spike disproved the premise that
there is a reachable failure to catch: `docx`'s `ImageRun` constructor
(`node_modules/docx@9.7.1/dist/index.d.ts`) performs no content
validation on the image buffer — it only computes a content hash of the
bytes to deduplicate the media part by filename
(`CoreMediaData.data` → `Media` dedup, confirmed against the shared
default/first/even fixture case below). Constructing
`new ImageRun({ type: 'png', data: Buffer.alloc(0), transformation: {
width: 0, height: 0 } })` does not throw. Every actual failure mode this
feature can encounter — malformed base64, an unsniffable signature,
missing dimensions — is already caught **before** `ImageRun` is ever
constructed, by `renderImageRun`'s own guard-clause returns
(`decodeBase64Payload` failure, `sniffImageMediaType` returning
`undefined`, absent `widthEmu`/`heightEmu`). There is no code path left
that reaches `new ImageRun(...)` with data that could make it throw.

Given that, keeping the try/catch would be dead defensive code — a
`catch` block that can never execute, logging a warning that can never
fire. This repo's `code.md` house rule ("no dead code, no `TODO` left as
a landmine") argues for removing it, and `renderImageRun` is written
`Pure, total, NEVER THROWS` with no logger dependency, matching (not
merely resembling) the contract its neighbors already claim.

**This is the one place the removal is a genuine tradeoff, not a free
lunch — recorded as an accepted residual risk, not a mitigated case:**
a byte sequence with a *valid* magic-byte signature (passes
`sniffImageMediaType`) but a *corrupt or truncated* body (e.g. a PNG
header followed by garbage, or a file cut off mid-stream during
capture/storage) will not throw anywhere in this pipeline. `ImageRun`
happily wraps it, `Packer` happily serializes it, and the resulting
`.docx` opens in Word with a broken/blank image in that slot — no
warning, no error, no log line. Detecting this would require actually
decoding the image (parsing the PNG/JPEG/GIF/BMP structure past the
magic bytes), which this slice does not do and which the original
design's try/catch would **not** have caught either — the throw the
original design guarded against does not exist in `docx`'s
implementation, so removing the catch changes nothing about this risk's
likelihood or detectability. It is accepted, not mitigated, because:
(1) the failure is cosmetic (one image slot renders broken, not document
corruption or a crash), (2) the source is either a capture pipeline
(ADR-068, which already validates readable image bytes when it captures
them) or a spec-author-supplied upload, both of which are far more
likely to produce well-formed images than corrupt-but-signature-valid
ones, and (3) a future slice that wants real coverage here should add
decode-level validation as a first-class feature (with its own test
fixtures for truncated/corrupt images per format), not resurrect a
try/catch around a constructor call that was never actually able to
detect this class of corruption.

### `imageFieldWarnings` is decomposed into four single-purpose guard predicates

The original task design sketched `imageFieldWarnings` as one function
inline-checking all four warning conditions (missing dimensions,
unreadable/undecodable data, declared/sniffed media-type mismatch, and
unsupported catchall keys like `rotationDegrees`/`flipHorizontal`/
`flipVertical`). Written that way it measures `complexity: 13` against
this repo's enforced cap of 10 (`eslint.config.js`, `CLAUDE.md`
"ESLint is enforced, not advisory"). Rather than raise the cap or
suppress the rule — both rejected by `code.md`'s "don't abstract so hard
... two clear functions beat one parameterized knot," read here as
"don't smuggle complexity past a rule instead of shrinking it" — the
function is split into four private guard clauses, each independently
readable and independently testable in isolation, composed by a thin
public function:

```typescript
function missingDimensionsWarning(field: HeaderFooterField): string | undefined;
function unreadableDataWarning(field: HeaderFooterField): string | undefined;
function mediaTypeMismatchWarning(field: HeaderFooterField): string | undefined;
function unsupportedKeyWarnings(field: HeaderFooterField): readonly string[];

export function imageFieldWarnings(
  field: HeaderFooterField,
  location: string
): readonly string[];
```

Each predicate returns `undefined` (or `[]` for the multi-key scanner)
when its specific condition does not apply — no shared mutable state, no
flags threaded between them. `imageFieldWarnings` itself concats the
non-undefined results and prefixes each with `location`, and is the only
one of the five exported from the module. Confirmed clean (`complexity`
well under 10 for all five functions) via `npx eslint` after the split.

### `decodeBase64Payload` is reused, not reimplemented

The original task design did not identify `src/lib/decode-base64.ts` as
a dependency — it predates this feature (added for MCP inline file
payloads: `parse_document`, `import_template`). The spike found its
contract — validate well-formed base64 via `BASE64_RE`, reject malformed
padding, cap decoded size from the *encoded* length before allocating —
is an exact fit for `imageData`'s decode step, and reusing it is a direct
application of this repo's "reuse before reinventing" house rule.
`renderImageRun` and `unreadableDataWarning` both call
`decodeBase64Payload(field.imageData, MAX_IMAGE_BYTES)` rather than
duplicating a base64-decode-with-size-cap routine.

### EMU → pixel conversion happens once, at the render boundary

`docx`'s `IMediaTransformation.width`/`.height` (the `ImageRun`
`transformation` option) are pixel counts, not EMU — `docx` converts
pixels to EMU internally when it builds the underlying
`<a:ext cx="..." cy="..."/>` drawing XML. The AST schema stores
`widthEmu`/`heightEmu` (OOXML's native unit, avoiding a lossy conversion
at capture time — ADR-068's capture side reads `w:extent`'s `cx`/`cy`
directly, already in EMU). `renderImageRun` is therefore the single
place the EMU → pixel conversion happens:
`Math.round(widthEmu / 9525)` / `Math.round(heightEmu / 9525)` — 9525
EMU/pixel is the standard OOXML DrawingML constant (914400 EMU/inch ÷ 96
DPI), not a SpecR-invented figure.

### Shared images across variants need no dedup code of our own

A composition can set the same image in more than one page variant (e.g.
a firm logo in both `variants.default` and `variants.first`). The spike
built the shared-image fixture case explicitly to check this: `docx`'s
own `Media` component dedups by content hash of the image bytes when
building the package's media parts, so two `ImageRun`s constructed from
identical `imageData` across different variants resolve to the same
physical media part in the output `.docx` with zero special-casing
required in `header-footer.ts`/`header-footer-regions.ts`. This is
confirmed behavior (fixture-tested), not an assumption carried over
unverified from the design.

### `HeaderFooterRunChild` widens the render pipeline's child type

`renderCellRuns`'s return type widens from `readonly TextRun[]` to
`readonly HeaderFooterRunChild[]` (`= TextRun | ImageRun`), and
`regionChildren`/`buildRegionParagraph` follow through the same widening.
`FIELD_RESOLVERS`'s `Record<HeaderFooterFieldKind, FieldResolver>`
exhaustiveness check (already relied on at compile time — see
`header-footer-fields.ts`'s own comment on that pattern) gains an
`image: () => []` entry: `resolveFieldChildren`'s `FieldValue` union
(`'text'` | `'pageField'`) has no image variant, and is not extended
with one — image rendering happens in the new
`header-footer-images.ts` module via `renderImageRun`, called directly
from `renderCellRuns`, bypassing `resolveFieldChildren` entirely for
image fields. The `image: () => []` resolver entry exists solely to keep
the `Record` exhaustive at compile time; it is never invoked at runtime
because `renderCellRuns` special-cases `field.kind === 'image'` before
reaching `resolveFieldChildren`.

## Consequences

- Acceptance criteria are met by construction: a logo fixture with
  well-formed `imageData`/`widthEmu`/`heightEmu` renders as a real
  `ImageRun` in the output header/footer (criterion 1); missing
  dimensions, undecodable data, a declared/sniffed media-type mismatch,
  and unsupported catchall keys (`rotationDegrees`, `flipHorizontal`,
  `flipVertical`) each produce a warning without ever throwing or
  dropping the surrounding region's other content (criterion 2);
  existing text/field resolution (`FIELD_RESOLVERS`, `renderFieldRun`)
  is untouched — only its return type's container (`HeaderFooterRunChild`
  vs `TextRun`) widens (criterion 3).
- The accepted residual risk (corrupt-but-signature-valid image bytes
  render as a broken image with no warning) is a known, documented gap,
  not a silent one — a future slice adding decode-level image validation
  is the natural place to close it, and this ADR is where that future
  reader should start.
- `docxImageType`/`renderImageRun`/`imageFieldWarnings` (and their four
  private guard predicates) live in a new
  `src/generator/header-footer-images.ts` module rather than growing
  `header-footer-fields.ts` further, keeping every touched generator file
  under the repo's 400-line cap.
- `src/lib/image-media-type.ts`'s `sniffImageMediaType` is deliberately
  scoped to the four `docx`-`ImageRun`-supported raster types
  (`png`/`jpeg`/`gif`/`bmp`) — `image/svg+xml` and other vector or
  unsupported formats sniff to `undefined` and are treated as
  undecodable (an `unreadableDataWarning`, not a crash), matching
  ADR-021's "unknown but present" preservation posture: the field's raw
  `imageData`/`imageMediaType` still round-trip in the JSONB composition
  even though this slice cannot render them.
- No DB migration, no `openapi.yaml` route/status change — this is a
  request/response *shape* addition (`content[].kind` enum member plus
  five sibling properties on the shared `&headerFooterCell` anchor),
  which fans out to all six existing header/footer PUT endpoints through
  the pre-existing anchor/alias without a separate edit per endpoint.
- Out of scope, unchanged from #301's boundaries: resolving image
  content across the client → project → package → revision scope chain
  (#304), and any visual-fidelity round-trip verification beyond what
  this render-only slice can assert on its own (tracked against
  #150/#305).
