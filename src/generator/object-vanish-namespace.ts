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
// same-named style being redefined out from under it.
//
// Applied on EVERY generation path, `generateDocx`'s single tree included
// (adversarial-review finding, #650). The sibling-tree collision above is not
// the only one: dolanmiu/docx emits its OWN built-in character styles
// (`Hyperlink`, `Strong`, `FootnoteReference`, …), so a source document whose
// vanish character style is named `Hyperlink` made the generator append a
// SECOND style carrying that same `w:styleId`. Word then repairs or
// ambiguously resolves the duplicate, and the minted `w:vanish` can attach to
// the document's hyperlinks — hiding VISIBLE text with nothing to do with the
// captured object. Every minted id carries NAMESPACE_SEPARATOR, which no
// built-in id does, so namespacing unconditionally closes that case too.
//
// Deliberately UNCONDITIONAL — every tree with any vanish ids gets
// namespaced, not only when an actual same-named collision would occur.
// Detecting a real collision would require classifying every OTHER tree's
// non-vanish references and tracking `docx`'s built-in list across library
// upgrades, a much larger and more brittle job than a cheap always-on rename.
// The cost is nil: `w:styleId` is the only correlation key SpecR's parser
// reads back, and `object-vanish-styles.ts` de-namespaces the style's `name`
// so a human opening the file in Word still sees the ORIGINAL style name.
//
// Minted ids are collision-CHECKED, not assumed unique: neither OOXML nor
// ObjectMetaSchema reserves NAMESPACE_SEPARATOR, so a source document could
// in principle already use `X#specr-vanish-t0` for visible text.
// `allocateNamespacedId` verifies each candidate against every id the source
// documents actually use before minting it.
import {
  type ObjectBlobNode,
  type ObjectMeta,
  type SpecNode,
  type SpecTree,
} from '../ast/index.js';
import {
  collectVanishCharacterStyleIds,
  NAMESPACE_SEPARATOR,
  stripVanishNamespace,
} from './object-vanish-styles.js';

// A distinctive, deterministic separator SpecR mints and a source .docx is
// overwhelmingly unlikely to contain. "Unlikely" is NOT "impossible" though,
// and neither OOXML nor ObjectMetaSchema reserves it (adversarial-review
// finding, #650), so `allocateNamespacedId` VERIFIES each minted id against
// every id the source documents actually use rather than assuming this
// suffix cannot occur.

// Mints a tree-scoped id for `id` that collides with nothing in `reserved`
// (every raw style id referenced by ANY tree, plus every id already minted
// in this pass), widening with a numeric disambiguator until free. Because
// every minted id contains NAMESPACE_SEPARATOR, it also can never equal one
// of dolanmiu/docx's own built-in character-style ids (`Hyperlink`,
// `Strong`, `FootnoteReference`, …) — which is what makes always-on
// namespacing the fix for the duplicate-`w:styleId` case below.
function allocateNamespacedId(id: string, treeIndex: number, reserved: Set<string>): string {
  // Strip first, so re-namespacing an ALREADY-namespaced id (which is what a
  // re-parse of a generated document hands back) reproduces the same id
  // instead of stacking a second suffix on every round-trip cycle.
  const base = `${stripVanishNamespace(id)}${NAMESPACE_SEPARATOR}${treeIndex}`;
  let candidate = base;
  let suffix = 0;
  while (reserved.has(candidate)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  reserved.add(candidate);
  return candidate;
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

function collectBlobRStyleIds(node: ObjectBlobNode, acc: Set<string>): void {
  const tag = tagOf(node);
  if (!tag) return;
  if (tag === 'w:rStyle') {
    const key = rStyleValKey(node[':@']?.['@_w:val']);
    if (key !== '') acc.add(key);
    return;
  }
  for (const child of childrenOf(node)) collectBlobRStyleIds(child, acc);
}

function collectNodeStyleIds(nodes: readonly SpecNode[], acc: Set<string>): void {
  for (const node of nodes) {
    const object = node.meta.object;
    if (object) {
      for (const id of object.vanishCharStyleIds ?? []) acc.add(id);
      for (const root of object.blob) collectBlobRStyleIds(root, acc);
    }
    collectNodeStyleIds(node.children, acc);
  }
}

/**
 * The character-style ids that will still be present in the OUTPUT after
 * renaming — every id any tree references (`vanishCharStyleIds` plus every
 * `w:rStyle` inside its blobs) MINUS the ids that tree is itself about to
 * rename away.
 *
 * A minted id must avoid these, and not merely the vanish ones: an id used
 * for VISIBLE formatting in another tree is exactly the id that must not
 * acquire a vanish stub. Subtracting each tree's own renamed-away ids is
 * what keeps allocation idempotent — on a re-parse of a generated document
 * the namespaced id IS that tree's raw id, and treating it as occupied
 * would push the allocator onto a `-1` suffix on every cycle.
 */
function collectRemainingStyleIds(trees: readonly SpecTree[]): Set<string> {
  const remaining = new Set<string>();
  for (const tree of trees) {
    const renamedAway = new Set(collectVanishCharacterStyleIds([tree]));
    const treeIds = new Set<string>();
    collectNodeStyleIds(tree.parts, treeIds);
    for (const id of treeIds) if (!renamedAway.has(id)) remaining.add(id);
  }
  return remaining;
}

/**
 * Gives every `SpecTree` in `trees` its own private, collision-checked
 * namespace for the vanish-character-style ids its OWN captured objects
 * reference (see this module's header). A no-op — every tree returned BY
 * REFERENCE, the whole array returned BY REFERENCE — when no tree carries
 * any vanish ids at all, keeping output byte-identical to before this fix in
 * the overwhelmingly common case.
 *
 * Applied on EVERY generation path including a single tree, not just
 * multi-tree `generateManual` (adversarial-review finding, #650). With raw
 * ids, a source document whose vanish character style happens to be named
 * after one dolanmiu/docx itself emits — `Hyperlink` is the realistic
 * example — made the generator append a SECOND character style carrying the
 * same `w:styleId`. Word then repairs or ambiguously resolves the duplicate,
 * and the minted `w:vanish` can attach to the document's hyperlinks, hiding
 * visible text that has nothing to do with the captured object. Namespacing
 * unconditionally means a minted id always carries NAMESPACE_SEPARATOR and
 * so can never equal a built-in id.
 */
export function namespaceVanishTrees(trees: readonly SpecTree[]): readonly SpecTree[] {
  const reserved = collectRemainingStyleIds(trees);
  let changed = false;
  const result = trees.map((tree, index) => {
    const ownIds = collectVanishCharacterStyleIds([tree]);
    if (ownIds.length === 0) return tree;
    const renames = new Map(
      ownIds.map((id) => [id, allocateNamespacedId(id, index, reserved)] as const)
    );
    const newParts = rewriteNodes(tree.parts, renames);
    if (newParts === tree.parts) return tree;
    changed = true;
    return { ...tree, parts: newParts };
  });
  return changed ? result : trees;
}
