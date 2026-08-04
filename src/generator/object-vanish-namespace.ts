// Cross-document vanish-character-style collision guard for `generateManual`
// (#650 review finding, HIGH severity): `object-vanish-styles.ts`'s
// `collectVanishCharacterStyleIds` unions every captured object's
// `vanishCharStyleIds` across ALL `SpecTree`s passed to `generateManual`, and
// `vanishStylesOptions` writes ONE shared `w:styles` character-style block
// for the whole merged manual. Two DIFFERENT source documents combined into
// one manual can each define their OWN character style under the SAME id —
// one genuinely vanish (an internal note style), the other used only for
// bold/underline formatting on visible text. Sharing one `styles.xml`
// namespace lets one tree's vanish stub silently overwrite another tree's
// unrelated definition of that id, hiding text the other tree's own capture
// correctly resolved as visible.
//
// The fix: give every SOURCE TREE its own private namespace for the
// character-style ids its OWN captured objects resolved vanish.
// `ObjectMeta.vanishCharStyleIds` is already the FULL resolved set from THAT
// tree's OWN `styles.xml` (`body-object-attach.ts`'s `toObjectMeta`), so
// within one tree every reference to a given id is unambiguous — renaming
// it, and every `w:rStyle` in that tree's own object blobs that names it, to
// a tree-scoped id removes any possibility of a DIFFERENT tree's unrelated
// same-named style being redefined out from under it. `generateDocx` (always
// exactly one tree) is unaffected: there is only ever one namespace there, so
// no rename is needed.
//
// Deliberately UNCONDITIONAL — every tree with any vanish ids gets
// namespaced, not only when an actual same-named collision with a sibling
// tree would occur. Detecting a real collision would require also scanning
// every OTHER tree's blobs for a non-vanish reference to the same id, a much
// larger walk for a case a cheap unconditional rename makes moot anyway: the
// renamed id is never read back by SpecR (`object-vanish-styles.ts`'s own
// module comment — `name` is shown to a human, never a correlation key), so
// there is no cost to always giving each tree its own namespace.
import {
  type ObjectBlobNode,
  type ObjectMeta,
  type SpecNode,
  type SpecTree,
} from '../ast/index.js';
import { collectVanishCharacterStyleIds } from './object-vanish-styles.js';

// A distinctive, deterministic separator no real captured Word style id
// could plausibly already contain — SpecR mints this, a source .docx never
// does — so a namespaced id can never accidentally collide with either an
// original id or another tree's namespaced id.
const NAMESPACE_SEPARATOR = '#specr-vanish-t';

function namespacedId(id: string, treeIndex: number): string {
  return `${id}${NAMESPACE_SEPARATOR}${treeIndex}`;
}

// ─── ObjectBlobNode navigation (preserveOrder-mode; self-contained per the
// established per-module-helper pattern — see object-block.ts and
// parser/docx/object-blob-edit.ts's own tagOf/childrenOf/withChildren.
// Duplicated here rather than shared: module-boundary rules bar importing
// parser/ from generator/, and this module's own copy stays well under its
// file's line budget without a shared extraction.) ─────────────────────────

function tagOf(node: ObjectBlobNode): string | undefined {
  const tags = Object.keys(node).filter((key) => key !== ':@');
  return tags.length === 1 ? tags[0] : undefined;
}

function isBlobNodeArray(value: unknown): value is readonly ObjectBlobNode[] {
  return Array.isArray(value);
}

function childrenOf(node: ObjectBlobNode): readonly ObjectBlobNode[] {
  const tag = tagOf(node);
  if (!tag) return [];
  const value = node[tag];
  return isBlobNodeArray(value) ? value : [];
}

function withChildren(
  node: ObjectBlobNode,
  tag: string,
  children: readonly ObjectBlobNode[]
): ObjectBlobNode {
  return withAttrs(tag, children, node[':@']);
}

// Builds a `{ [tag]: children, ':@': attrs }` node — the shared literal
// shape `withChildren` and `renamedRStyleAttrs`'s caller both need, taking
// `attrs` explicitly rather than always reading it off an existing node
// (renaming needs to substitute a DIFFERENT attrs object than the source
// node's own). `as ObjectBlobNode` mirrors object-blob-edit.ts's own
// established narrowing: the index signature plus the separately-
// intersected optional `:@` key can't both be checked against one hand-
// assembled literal at once — using a COMPUTED `[tag]` key (never a literal
// property name) is what keeps this assertion valid; see this module's own
// test-fixture builders for the same requirement.
function withAttrs(
  tag: string,
  children: readonly ObjectBlobNode[],
  attrs: ObjectBlobNode[':@']
): ObjectBlobNode {
  return (
    attrs !== undefined ? { [tag]: children, ':@': attrs } : { [tag]: children }
  ) as ObjectBlobNode;
}

// fast-xml-parser's attribute-value parsing may coerce a numeric-looking
// `w:val` to a JS number (mirrors object-block.ts's own toImportedAttributes
// coercion note) — OOXML style ids are always textual, so this normalizes
// either shape to the string `renames` is keyed by. Empty string (never a
// real captured style id) signals "nothing to look up".
function rStyleValKey(value: string | number | undefined): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

// Renames a `w:rStyle` node's own `@_w:val` attribute when it names an id in
// `renames`, leaving every other attribute and every other node untouched —
// by reference, so a blob with nothing to rename comes back byte-identical.
function renamedRStyleAttrs(
  node: ObjectBlobNode,
  renames: ReadonlyMap<string, string>
): ObjectBlobNode[':@'] | undefined {
  const attrs = node[':@'];
  const key = rStyleValKey(attrs?.['@_w:val']);
  const renamed = key !== '' ? renames.get(key) : undefined;
  return attrs !== undefined && renamed !== undefined
    ? { ...attrs, '@_w:val': renamed }
    : undefined;
}

/**
 * Immutably rewrites every `w:rStyle` reference in `node` naming an id in
 * `renames` to that id's namespaced replacement. Every other node — no
 * matching `w:rStyle` anywhere in its subtree — is returned BY REFERENCE,
 * unchanged, so a tree with nothing to rename produces byte-identical output.
 */
function rewriteRStyleIds(
  node: ObjectBlobNode,
  renames: ReadonlyMap<string, string>
): ObjectBlobNode {
  const tag = tagOf(node);
  if (!tag) return node;
  if (tag === 'w:rStyle') {
    const renamedAttrs = renamedRStyleAttrs(node, renames);
    return renamedAttrs === undefined ? node : withAttrs(tag, [], renamedAttrs);
  }
  const children = childrenOf(node);
  if (children.length === 0) return node;
  let changed = false;
  const newChildren = children.map((child) => {
    const rewritten = rewriteRStyleIds(child, renames);
    if (rewritten !== child) changed = true;
    return rewritten;
  });
  return changed ? withChildren(node, tag, newChildren) : node;
}

function rewriteBlobRoots(
  blob: readonly ObjectBlobNode[],
  renames: ReadonlyMap<string, string>
): readonly ObjectBlobNode[] {
  let changed = false;
  const result = blob.map((root) => {
    const rewritten = rewriteRStyleIds(root, renames);
    if (rewritten !== root) changed = true;
    return rewritten;
  });
  return changed ? result : blob;
}

// Renames every id present in `ids` that also appears in `renames`, keeping
// every other id verbatim; returns `ids` unchanged (by reference) when
// nothing in it needed renaming, including when `ids` itself is undefined.
function renamedIds(
  ids: readonly string[] | undefined,
  renames: ReadonlyMap<string, string>
): readonly string[] | undefined {
  if (ids === undefined) return undefined;
  let changed = false;
  const result = ids.map((id) => {
    const renamed = renames.get(id);
    if (renamed !== undefined) changed = true;
    return renamed ?? id;
  });
  return changed ? result : ids;
}

function rewriteObjectMeta(object: ObjectMeta, renames: ReadonlyMap<string, string>): ObjectMeta {
  const newBlob = rewriteBlobRoots(object.blob, renames);
  const newIds = renamedIds(object.vanishCharStyleIds, renames);
  if (newBlob === object.blob && newIds === object.vanishCharStyleIds) return object;
  return {
    ...object,
    blob: newBlob as ObjectMeta['blob'],
    ...(newIds !== undefined ? { vanishCharStyleIds: [...newIds] } : {}),
  };
}

function rewriteNode(node: SpecNode, renames: ReadonlyMap<string, string>): SpecNode {
  const newChildren = rewriteNodes(node.children, renames);
  const currentObject = node.meta.object;
  const newObject =
    currentObject !== undefined ? rewriteObjectMeta(currentObject, renames) : undefined;
  const objectChanged = newObject !== undefined && newObject !== currentObject;
  if (newChildren === node.children && !objectChanged) return node;
  return {
    ...node,
    children: newChildren,
    meta: objectChanged ? { ...node.meta, object: newObject } : node.meta,
  };
}

function rewriteNodes(
  nodes: readonly SpecNode[],
  renames: ReadonlyMap<string, string>
): readonly SpecNode[] {
  let changed = false;
  const result = nodes.map((node) => {
    const rewritten = rewriteNode(node, renames);
    if (rewritten !== node) changed = true;
    return rewritten;
  });
  return changed ? result : nodes;
}

/**
 * Gives every `SpecTree` in `trees` its own private namespace for the
 * vanish-character-style ids its OWN captured objects reference, so
 * `generateManual` combining multiple source documents can never let one
 * tree's vanish stub overwrite another tree's unrelated same-named style
 * (see this module's header). A no-op — every tree returned BY REFERENCE,
 * the whole array returned BY REFERENCE — when `trees.length <= 1` (no
 * cross-tree collision is possible with a single source document) or when no
 * tree carries any vanish ids at all, keeping `generateManual`'s output
 * byte-identical to before this fix in the overwhelmingly common case.
 */
export function namespaceVanishTrees(trees: readonly SpecTree[]): readonly SpecTree[] {
  if (trees.length <= 1) return trees;
  let changed = false;
  const result = trees.map((tree, index) => {
    const ownIds = collectVanishCharacterStyleIds([tree]);
    if (ownIds.length === 0) return tree;
    const renames = new Map(ownIds.map((id) => [id, namespacedId(id, index)] as const));
    const newParts = rewriteNodes(tree.parts, renames);
    if (newParts === tree.parts) return tree;
    changed = true;
    return { ...tree, parts: newParts };
  });
  return changed ? result : trees;
}
