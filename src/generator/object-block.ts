// Generator-side bridge for round-tripping captured body objects (#300/#517,
// ADR-072 decision 1): re-emits the EXACT OOXML subtree a captured
// `ObjectBlobNode` blob describes, without reinterpreting its content, by
// walking it into docx's own `ImportedXmlComponent` tree via DIRECT
// CONSTRUCTION (constructor + `push`) — never
// `ImportedXmlComponent.fromXmlString`, which re-parses an XML STRING and
// (verified against the pinned docx@9.7.1 during design synthesis)
// double-wraps an already-parsed tree's root element.

import { FileChild, ImportedXmlComponent } from 'docx';
import type { IContext, IXmlableObject } from 'docx';
import { GeneratorError } from './error.js';
import type { ObjectBlobNode } from '../ast/index.js';

/**
 * Thin `FileChild` wrapper around one built `ImportedXmlComponent` — a
 * captured body object's re-emitted OOXML subtree. `prepForXml` delegates
 * 1:1 to the wrapped component: this class introduces NO wrapper tag of its
 * own. It exists purely so the re-emitted subtree can sit directly in a
 * `Document` section's `children` array alongside `Paragraph`/`SdtBlock`.
 */
export class ImportedObjectBlock extends FileChild {
  private readonly imported: ImportedXmlComponent;

  constructor(imported: ImportedXmlComponent) {
    // The rootKey below is never used for output — prepForXml is fully
    // overridden — but FileChild/XmlComponent's constructor requires one.
    super('w:importedObjectBlock');
    this.imported = imported;
  }

  override prepForXml(context: IContext): IXmlableObject | undefined {
    return this.imported.prepForXml(context);
  }
}

// ─── ObjectBlobNode navigation (preserveOrder-mode; self-contained per the
// established per-module-helper pattern — see parser/docx/body-objects.ts
// and body-order.ts's own private tagOf/childrenOf) ─────────────────────────

// Exactly one non-`:@` key is the preserveOrder invariant for a well-formed
// node (`{ 'w:p': [...], ':@': {...} }` or `{ '#text': '...' }`); a node with
// two element keys (`{ 'w:p': [], 'w:tbl': [] }`) or a mixed `#text`+element
// pair is malformed capture data. Returning `undefined` for it — rather than
// silently picking the first key — lets `buildImportedXmlComponent` reject it
// instead of dropping the sibling branch into a corrupt re-emitted document.
function tagOf(node: ObjectBlobNode): string | undefined {
  const tags = Object.keys(node).filter((key) => key !== ':@');
  return tags.length === 1 ? tags[0] : undefined;
}

// Hand-written type guard, not a bare `Array.isArray` check: TS narrows
// `Array.isArray` over a `readonly ObjectBlobNode[] | string` union to
// `any[]` (lib.es5.d.ts limitation), which would leak an unsafe `any[]` into
// every caller.
function isBlobNodeArray(value: unknown): value is readonly ObjectBlobNode[] {
  return Array.isArray(value);
}

function childrenOf(node: ObjectBlobNode): readonly ObjectBlobNode[] {
  const tag = tagOf(node);
  if (!tag) return [];
  const value = node[tag];
  return isBlobNodeArray(value) ? value : [];
}

function stripAttributePrefix(key: string): string {
  return key.startsWith('@_') ? key.slice(2) : key;
}

// fast-xml-parser's preserveOrder attribute keys carry an `@_` prefix
// (`{ '@_w:val': '...' }`); `ImportedXmlComponent`'s own attribute component
// applies no key mapping (docx's `XmlAttributeComponent` with no `xmlKeys`,
// verified empirically — it re-emits whatever key it is given verbatim), so
// the prefix must be stripped here or every re-emitted attribute name would
// come out wrong (`@_w:val="…"` instead of `w:val="…"`). Values are
// `String()`-coerced since fast-xml-parser's attribute-value parsing may
// have coerced a numeric-looking attribute (e.g. `w:val="1"`) to a JS
// number, and OOXML attribute values are always textual.
function toImportedAttributes(
  attrs: Readonly<Record<string, string | number>>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(attrs).map(([key, value]) => [stripAttributePrefix(key), String(value)])
  );
}

function pushChild(component: ImportedXmlComponent, child: ObjectBlobNode): void {
  if (tagOf(child) === '#text') {
    const text = child['#text'];
    if (typeof text === 'string') component.push(text);
    return;
  }
  component.push(buildImportedXmlComponent(child));
}

// Recursively rebuilds one ObjectBlobNode subtree into docx's own
// ImportedXmlComponent tree. A node without exactly one element tag (an
// `ObjectBlobNode` that is neither a `#text` leaf nor a single-key element
// wrapper — e.g. a malformed multi-key `{ 'w:p': [], 'w:tbl': [] }`) is
// malformed capture data — it is never silently dropped or truncated to its
// first branch, only surfaced as a GeneratorError for buildObjectBlocks to
// wrap with its objectNodeId.
function buildImportedXmlComponent(node: ObjectBlobNode): ImportedXmlComponent {
  const tag = tagOf(node);
  if (!tag) {
    throw new GeneratorError(
      `blob node must have exactly one element tag: ${JSON.stringify(node)}`
    );
  }
  const attrs = node[':@'];
  const component = new ImportedXmlComponent(
    tag,
    attrs !== undefined ? toImportedAttributes(attrs) : undefined
  );
  for (const child of childrenOf(node)) {
    pushChild(component, child);
  }
  return component;
}

/**
 * Re-emits one captured body object's blob (#300/#517, ADR-072) as an
 * `ImportedObjectBlock` ready to sit in a `Document` section's `children`.
 * `blob` must carry exactly one root node — a captured object's blob is
 * always ONE `w:tbl` or ONE host `w:p` (`ObjectMetaSchema.blob` is
 * `minLength(1)`, but more than one root is equally never valid) — either
 * shape throws rather than silently picking a root or losing a sibling.
 */
export function buildObjectBlocks(
  objectNodeId: string,
  blob: readonly ObjectBlobNode[]
): ImportedObjectBlock {
  const root = blob.length === 1 ? blob[0] : undefined;
  if (root === undefined) {
    throw new GeneratorError(
      `body object ${objectNodeId} has ${blob.length} blob root(s), expected exactly 1`
    );
  }
  try {
    return new ImportedObjectBlock(buildImportedXmlComponent(root));
  } catch (err) {
    throw new GeneratorError(`failed to re-emit body object ${objectNodeId}`, { cause: err });
  }
}
