/**
 * The `w:tag` value prefix SpecR stamps on every `w:sdt` content control it
 * emits, marking the control as a round-trip merge anchor (ADR-004) keyed by
 * paragraph UUID: `w:tag w:val="specr-uuid-<uuid>"`.
 *
 * Single-sourced here — the foundational `ast/` layer — so every writer and
 * reader of the tag imports the same literal instead of re-declaring it.
 * Before #300 this had already drifted into two independent module-private
 * copies (`generator/controls.ts`, which writes the tag, and
 * `merge/extract.ts`, which reads it back); ADR-072 relocates both to this
 * single source rather than adding a third copy for the body-object anchor
 * writer (`parser/docx/object-anchor.ts`).
 */
export const UUID_TAG_PREFIX = 'specr-uuid-';
