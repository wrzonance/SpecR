// Body-object blob text editor (#519, ADR-072 decision 3 follow-on): locates
// and rewrites the interior paragraph an `object`/`objectText` node's
// captured OOXML blob anchors via `object-anchor.ts`'s
// `wrapBlobParagraphWithAnchor` (`w:sdt > w:sdtPr > w:tag[w:val=...] +
// w:sdtContent > [w:p]`) — the SAME uuid `objectText.id` carries, and the
// SAME sole-locator convention `merge/extract.ts`'s `readUuidFromSdtPr`
// already established for ordinary body paragraphs.
//
// Both exports are pure and total over "not found" (returning `undefined`,
// never throwing): `merge`/`db` callers (WS3b) branch on that return, not on
// a catch. A MATCHED anchor whose own `w:sdtContent` is missing or does not
// carry exactly one interior node is a different failure mode — corrupted
// capture data, not a legitimate miss — and throws `ParserError` instead of
// silently returning `undefined`, so a caller can never mistake "this object
// has no such paragraph" for "this object's blob is broken".
//
// `replaceAnchoredParagraphText`'s internal rebuild walk applies a leaf
// guard BEFORE any recursive descent: a node whose own tag value is not
// itself a child array (e.g. `{ '#text': 'hello' }`) is returned by
// reference, untouched — never rebuilt from a `childrenOf()`-coerced empty
// array. Skipping this guard was a spike-discovered correctness bug: a
// naive "rebuild every node's children from its own children" recursion
// silently blanked every OTHER `#text` leaf in the blob it touched along the
// way to the match, corrupting sibling paragraphs nobody asked to edit. See
// this file's own "non-anchor siblings are untouched" test.

import { ParserError } from '../error.js';
import { UUID_TAG_PREFIX } from '../../ast/index.js';
import type { ObjectBlobNode } from '../../ast/index.js';

// ─── ObjectBlobNode navigation (preserveOrder-mode; mirrors the established
// per-module-helper pattern — see generator/object-block.ts and
// parser/docx/body-objects.ts's own private tagOf/childrenOf/isBlobNodeArray.
// Duplicated here rather than shared: module-boundary rules bar importing
// generator/ from parser/, and these modules' own copies are each already
// under their file's line budget without a shared extraction.) ─────────────

function tagOf(node: ObjectBlobNode): string | undefined {
  const tags = Object.keys(node).filter((key) => key !== ':@');
  return tags.length === 1 ? tags[0] : undefined;
}

// Hand-written type guard, not a bare `Array.isArray` check: TS narrows
// `Array.isArray` over a `readonly ObjectBlobNode[] | string` union to
// `any[]` (lib.es5.d.ts limitation), which would leak an unsafe `any[]`
// into every caller.
function isBlobNodeArray(value: unknown): value is readonly ObjectBlobNode[] {
  return Array.isArray(value);
}

function childrenOf(node: ObjectBlobNode): readonly ObjectBlobNode[] {
  const tag = tagOf(node);
  if (!tag) return [];
  const value = node[tag];
  return isBlobNodeArray(value) ? value : [];
}

function directChildByTag(node: ObjectBlobNode, tag: string): ObjectBlobNode | undefined {
  return childrenOf(node).find((child) => tagOf(child) === tag);
}

function attrStr(node: ObjectBlobNode, name: string): string | undefined {
  const attrs = node[':@'];
  if (attrs === undefined) return undefined;
  const value = attrs[name];
  return typeof value === 'string' ? value : undefined;
}

function withChildren(
  node: ObjectBlobNode,
  tag: string,
  children: readonly ObjectBlobNode[]
): ObjectBlobNode {
  // `as ObjectBlobNode` mirrors object-anchor.ts's own established
  // narrowing: the index signature plus the separately-intersected optional
  // `:@` key can't both be checked against one hand-assembled object
  // literal at once — a known TS limitation, not a sign this literal is the
  // wrong shape.
  const attrs = node[':@'];
  return (
    attrs !== undefined ? { [tag]: children, ':@': attrs } : { [tag]: children }
  ) as ObjectBlobNode;
}

/** specr uuid from a w:sdt node's w:sdtPr > w:tag w:val, if SpecR-tagged.
 * Mirrors merge/extract.ts's readSdtUuid/readUuidFromSdtPr exactly, adapted
 * to ObjectBlobNode's own node shape — that module cannot be imported here
 * (module-boundary rules bar parser/ from importing merge/). */
function readSdtUuid(sdtNode: ObjectBlobNode): string | undefined {
  const sdtPr = directChildByTag(sdtNode, 'w:sdtPr');
  if (!sdtPr) return undefined;
  const tagNode = directChildByTag(sdtPr, 'w:tag');
  if (!tagNode) return undefined;
  const value = attrStr(tagNode, '@_w:val');
  return value !== undefined && value.startsWith(UUID_TAG_PREFIX)
    ? value.slice(UUID_TAG_PREFIX.length)
    : undefined;
}

/** The single interior paragraph `wrapBlobParagraphWithAnchor` wraps
 * (`w:sdt > w:sdtContent > [paragraphNode]`). Throws `ParserError` if the
 * matched anchor's own `w:sdtContent` is missing or does not carry EXACTLY
 * one child — corrupted capture data, never a legitimate "not found" case
 * (that split happens one level up, before this is ever called). */
function interiorParagraphOf(sdtNode: ObjectBlobNode, uuid: string): ObjectBlobNode {
  const content = directChildByTag(sdtNode, 'w:sdtContent');
  const children = content ? childrenOf(content) : [];
  const paragraph = children.length === 1 ? children[0] : undefined;
  if (!paragraph) {
    throw new ParserError(
      `anchored object blob paragraph ${uuid} has a malformed w:sdtContent ` +
        `(expected exactly 1 interior node, found ${children.length})`,
      { code: 'DOCX_OBJECT_BLOB_ANCHOR_MALFORMED' }
    );
  }
  return paragraph;
}

/**
 * Locates the interior `w:p` paragraph anchored by `uuid` inside `blob` —
 * the same uuid `object-anchor.ts`'s `wrapBlobParagraphWithAnchor` bakes
 * into the `w:sdt > w:sdtPr > w:tag` merge anchor (ADR-072 decision 3).
 * Returns the interior `w:p` node itself, never the `w:sdt` shell. A
 * genuinely absent uuid returns `undefined` (total, never throws); a
 * matching anchor whose own `w:sdtContent` is corrupted throws
 * `ParserError` instead (see `interiorParagraphOf`) — the two are never
 * conflated.
 */
export function findAnchoredParagraph(
  blob: readonly ObjectBlobNode[],
  uuid: string
): ObjectBlobNode | undefined {
  for (const node of blob) {
    const tag = tagOf(node);
    if (!tag) continue;
    const value = node[tag];
    if (!isBlobNodeArray(value)) continue;
    if (tag === 'w:sdt' && readSdtUuid(node) === uuid) {
      return interiorParagraphOf(node, uuid);
    }
    const found = findAnchoredParagraph(value, uuid);
    if (found) return found;
  }
  return undefined;
}

/**
 * Rebuilds one paragraph node's content: a leading `w:pPr` (paragraph-mark
 * properties — alignment, spacing, …) is kept untouched if present, and
 * every other child — one or more `w:r` runs, hyperlinks, ins/del, … — is
 * collapsed into ONE new `w:r > w:t` run carrying `newText` ("multi-run
 * rewrite"). This mirrors the rest of SpecR's paragraph model: no node
 * anywhere carries per-run rich formatting (`generator/index.ts`'s
 * `plainParagraph` emits a single `TextRun` the same way), so collapsing to
 * one run here is consistent with the model, not an object-specific loss.
 */
function replaceParagraphContent(paragraph: ObjectBlobNode, newText: string): ObjectBlobNode {
  const tag = tagOf(paragraph);
  // Malformed defensive no-op — mirrors body-objects.ts's own
  // transformInteriorParagraphs guard; a paragraph the parser itself wrapped
  // always has exactly one tag.
  if (!tag) return paragraph;
  const pPr = directChildByTag(paragraph, 'w:pPr');
  const newRun: ObjectBlobNode = { 'w:r': [{ 'w:t': [{ '#text': newText }] }] };
  return withChildren(paragraph, tag, pPr !== undefined ? [pPr, newRun] : [newRun]);
}

function rebuildMatchedSdt(sdtNode: ObjectBlobNode, uuid: string, newText: string): ObjectBlobNode {
  const paragraph = interiorParagraphOf(sdtNode, uuid); // throws on malformed
  const newParagraph = replaceParagraphContent(paragraph, newText);
  const newSdtChildren = childrenOf(sdtNode).map((child) =>
    tagOf(child) === 'w:sdtContent' ? withChildren(child, 'w:sdtContent', [newParagraph]) : child
  );
  return withChildren(sdtNode, 'w:sdt', newSdtChildren);
}

interface RebuildResult {
  readonly node: ObjectBlobNode;
  readonly placed: boolean;
}

function rebuildNode(
  node: ObjectBlobNode,
  uuid: string,
  newText: string,
  placed: boolean
): RebuildResult {
  const tag = tagOf(node);
  if (!tag) return { node, placed };
  const value = node[tag];
  // Leaf guard (mandatory fix, see module comment): a node whose tag value
  // is not itself a child array is returned BY REFERENCE, never rebuilt
  // from a coerced-empty children list.
  if (!isBlobNodeArray(value)) return { node, placed };

  if (!placed && tag === 'w:sdt' && readSdtUuid(node) === uuid) {
    return { node: rebuildMatchedSdt(node, uuid, newText), placed: true };
  }

  let changed = false;
  let nowPlaced = placed;
  const newChildren: ObjectBlobNode[] = [];
  for (const child of value) {
    const result = rebuildNode(child, uuid, newText, nowPlaced);
    if (result.node !== child) changed = true;
    if (result.placed) nowPlaced = true;
    newChildren.push(result.node);
  }
  if (!changed) return { node, placed: nowPlaced };
  return { node: withChildren(node, tag, newChildren), placed: nowPlaced };
}

/**
 * Immutably replaces the text of the interior paragraph anchored by `uuid`
 * inside `blob`, returning a brand-new top-level array. `blob` and every
 * node NOT on the path to the match are returned untouched, by reference —
 * never mutated, never rebuilt from a coerced-empty child list (see
 * `rebuildNode`'s leaf guard and this file's "non-anchor siblings are
 * untouched" test). Returns `undefined`, performing no partial rewrite, when
 * `uuid` is not anchored anywhere in `blob` (total). Throws `ParserError` if
 * the matched anchor's own `w:sdtContent` is corrupted (see
 * `interiorParagraphOf`).
 */
export function replaceAnchoredParagraphText(
  blob: readonly ObjectBlobNode[],
  uuid: string,
  newText: string
): readonly ObjectBlobNode[] | undefined {
  let placed = false;
  const newBlob: ObjectBlobNode[] = [];
  for (const node of blob) {
    const result = rebuildNode(node, uuid, newText, placed);
    if (result.placed) placed = true;
    newBlob.push(result.node);
  }
  return placed ? newBlob : undefined;
}
