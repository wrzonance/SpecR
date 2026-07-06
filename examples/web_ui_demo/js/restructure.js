// Client-side paragraph restructure for the Editor's WYSIWYG Tab / Shift+Tab
// gesture: retype + reparent a node through the CSI tier ladder and let the
// render-derived labels renumber the sheet. The API has no persistence for
// this yet (#371), so the editor replays these ops over a CLONE of the server
// tree as an explicitly-labeled local preview — node ids stay stable, so text
// PATCHes and reloads compose with the overlay.
//
// Outline-editor semantics (matches Word and the reference design):
//   indent  — node becomes the last child of its previous structural sibling;
//             its subtree shifts one tier down (blocked past pr7).
//   outdent — node moves up beside its former parent; its former following
//             siblings become its trailing children; its subtree shifts one
//             tier up (pr1 crosses the heading boundary and becomes an article).

// Tier ladder. part(0) anchors the ladder but never restructures; notes and
// continuations have no tier and ride along inside whatever subtree moves.
const TIER_TYPES = ['part', 'article', 'pr1', 'pr2', 'pr3', 'pr4', 'pr5', 'pr6', 'pr7'];
const MAX_TIER = TIER_TYPES.length - 1;

function tierOf(type) {
  return TIER_TYPES.indexOf(type);
}

export function isRestructurable(node) {
  return tierOf(node.type) >= 1; // article..pr7
}

function deepClone(nodes) {
  return structuredClone(nodes);
}

// Locates nodeId in the forest. Returns { node, parent, siblings, index } —
// parent is null when the node sits in the root list.
function findPath(forest, nodeId, parent = null) {
  for (let index = 0; index < forest.length; index += 1) {
    const node = forest[index];
    if (node.id === nodeId) return { node, parent, siblings: forest, index };
    const hit = findPath(node.children, nodeId, node);
    if (hit) return hit;
  }
  return null;
}

function deepestTier(node) {
  let deepest = tierOf(node.type);
  for (const child of node.children) deepest = Math.max(deepest, deepestTier(child));
  return deepest;
}

// Retype the whole subtree by `delta` tiers; untiered nodes (notes,
// continuations) are left as-is. The pre-shift type is remembered as
// `baseType` (render-clone only, never sent to the API) so affordances gated
// on SERVER truth — e.g. the ⊘ removal PATCH, which 422s on real headings —
// keep honoring what the node actually is in the database.
function shiftTiers(node, delta) {
  const tier = tierOf(node.type);
  if (tier >= 1) {
    node.baseType = node.baseType ?? node.type;
    node.type = TIER_TYPES[tier + delta];
  }
  for (const child of node.children) shiftTiers(child, delta);
}

function indent(forest, nodeId) {
  const path = findPath(forest, nodeId);
  if (!path) return { ok: false, reason: 'paragraph no longer exists' };
  const { node, siblings, index } = path;
  if (!isRestructurable(node)) return { ok: false, reason: 'this row cannot be indented' };
  let targetIndex = -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (tierOf(siblings[i].type) >= 1) {
      targetIndex = i;
      break;
    }
  }
  if (targetIndex === -1) return { ok: false, reason: 'nothing above to indent under' };
  const target = siblings[targetIndex];
  const newTier = tierOf(target.type) + 1;
  if (newTier > MAX_TIER) return { ok: false, reason: 'already at the deepest tier' };
  const delta = newTier - tierOf(node.type);
  if (deepestTier(node) + delta > MAX_TIER) {
    return { ok: false, reason: 'a nested row would pass the deepest tier' };
  }
  // The node moves together with any untiered run (notes/continuations)
  // sitting between the target and itself — document order is preserved and
  // an indent followed by an outdent round-trips cleanly.
  const moved = siblings.splice(targetIndex + 1, index - targetIndex);
  shiftTiers(node, delta);
  target.children.push(...moved);
  return { ok: true };
}

function outdent(forest, nodeId) {
  const path = findPath(forest, nodeId);
  if (!path) return { ok: false, reason: 'paragraph no longer exists' };
  const { node, parent, siblings, index } = path;
  if (!isRestructurable(node)) return { ok: false, reason: 'this row cannot be outdented' };
  if (tierOf(node.type) === 1) return { ok: false, reason: 'an article cannot become a part' };
  if (!parent || tierOf(parent.type) < 1) {
    // Directly under a part (or a degraded root) — there is no tier above to
    // move beside without leaving the part.
    return { ok: false, reason: 'already at the top of this part' };
  }
  const parentPath = findPath(forest, parent.id);
  const followers = siblings.splice(index + 1);
  siblings.splice(index, 1);
  shiftTiers(node, -1);
  node.children.push(...followers);
  parentPath.siblings.splice(parentPath.index + 1, 0, node);
  return { ok: true };
}

// Enter inserts a new empty sibling draft of the same tier right after its
// anchor. Drafts exist only in the preview (no creation endpoint yet, #372) —
// meta.localDraft marks them so the renderer and the save pipeline treat them
// as client-only until the API can persist them.
function insertAfter(forest, op) {
  const path = findPath(forest, op.afterId);
  if (!path) return { ok: false, reason: 'anchor paragraph no longer exists' };
  path.siblings.splice(path.index + 1, 0, {
    id: op.nodeId,
    type: op.nodeType,
    text: op.text ?? '',
    children: [],
    meta: { localDraft: true },
  });
  return { ok: true };
}

// Replays ops over a clone of `parts`. Two shapes:
//   { op: 'move',   nodeId, dir }                       — Tab / Shift+Tab
//   { op: 'insert', afterId, nodeId, nodeType, text }   — Enter drafts
// Ops whose node has disappeared (or that no longer apply after a server
// reload) are dropped silently — the preview always reflects what still holds
// against current truth. Returns { parts, applied }.
export function applyRestructureOps(parts, ops) {
  const forest = deepClone(parts);
  const applied = [];
  for (const op of ops) {
    const result =
      op.op === 'insert'
        ? insertAfter(forest, op)
        : op.dir > 0
          ? indent(forest, op.nodeId)
          : outdent(forest, op.nodeId);
    if (result.ok) applied.push(op);
  }
  return { parts: forest, applied };
}

// Validates one new move against the current preview state without committing.
export function tryRestructure(parts, ops, nodeId, dir) {
  const { parts: forest } = applyRestructureOps(parts, ops);
  return dir > 0 ? indent(forest, nodeId) : outdent(forest, nodeId);
}
