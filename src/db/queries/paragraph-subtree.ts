import { parseSourceFacts, deriveArticleRole } from '../../ast/index.js';
import type { SignalConflict, SourceFacts, SpecNode } from '../../ast/index.js';
import { parseNodeType } from './node-type.js';
import { deriveInference } from './inference-meta.js';
import { parseObjectMeta } from './object-meta.js';

// Split out of paragraphs.ts (#545): with buildSubtree/buildSubtreeMeta/
// SubtreeRow inlined there, that file measured over the repo's enforced 400-
// line max-lines cap. paragraphs.ts already has several such companion
// files (object-text-edit.ts, object-meta.ts, node-type.ts, inference-
// meta.ts, associations.ts, paragraphs-batch.ts, source-facts-rederive.ts)
// — this follows the same convention.

export interface SubtreeRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly nodeType: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
  readonly conflicts: readonly SignalConflict[];
  readonly sourceFacts: SourceFacts;
  readonly signalProvenance: unknown;
  readonly objectData: unknown;
  readonly pageBreakBefore: boolean;
  readonly acknowledged: boolean;
}

function hasSourceFacts(sourceFacts: SourceFacts): boolean {
  return Object.keys(sourceFacts).length > 0;
}

/** Assemble one subtree row's `meta`, each field omitted when empty (mirrors
 *  specs.ts's buildNodeMeta) — split out of `buildSubtree`'s `build` closure
 *  purely to keep that closure under the repo's enforced complexity cap. */
function buildSubtreeMeta(
  row: SubtreeRow,
  derived: {
    readonly sourceFacts: SourceFacts;
    readonly articleRole: ReturnType<typeof deriveArticleRole>;
    readonly inference: ReturnType<typeof deriveInference>;
    readonly objectMeta: ReturnType<typeof parseObjectMeta>;
  }
): SpecNode['meta'] {
  const { sourceFacts, articleRole, inference, objectMeta } = derived;
  return {
    ...(row.vanish ? { vanish: true } : {}),
    ...(row.conflicts.length > 0 ? { conflicts: row.conflicts } : {}),
    ...(hasSourceFacts(sourceFacts) ? { sourceFacts } : {}),
    ...(articleRole !== undefined ? { articleRole } : {}),
    ...(inference ? { inference } : {}),
    ...(objectMeta ? { object: objectMeta } : {}),
    ...(row.pageBreakBefore ? { pageBreakBefore: true } : {}),
    ...(row.acknowledged ? { acknowledged: true } : {}),
  };
}

/** Assemble subtree rows (a node plus all its descendants) into one SpecNode
 *  rooted at `rootId`. Mirrors buildNodeTree's meta shaping (specs.ts) but roots
 *  at a non-null parent rather than the forest roots. Used by
 *  {@link import('./paragraphs.js').fetchSubtreeNode} — every paragraph write
 *  path's shared "reconstruct the written node" step. */
export function buildSubtree(rows: readonly SubtreeRow[], rootId: string): SpecNode | null {
  const childrenByParent = new Map<string | null, SubtreeRow[]>();
  for (const row of rows) {
    childrenByParent.set(row.parentId, [...(childrenByParent.get(row.parentId) ?? []), row]);
  }
  const root = rows.find((r) => r.id === rootId);
  if (!root) return null;

  const build = (row: SubtreeRow): SpecNode => {
    // Normalize through the schema so legacy comment facts gain the backfilled
    // `closed` flag before they reach the API response (#262).
    const sourceFacts = parseSourceFacts(row.sourceFacts);
    const articleRole = row.nodeType === 'article' ? deriveArticleRole(row.text) : undefined;
    const nodeType = parseNodeType(row.nodeType, 'buildSubtree');
    const inference = deriveInference(row.signalProvenance, row.conflicts, nodeType);
    const objectMeta = parseObjectMeta(nodeType, row.objectData, 'buildSubtree');
    return {
      id: row.id,
      type: nodeType,
      text: row.text,
      children: (childrenByParent.get(row.id) ?? [])
        .sort((a, b) => a.position - b.position)
        .map(build),
      meta: buildSubtreeMeta(row, { sourceFacts, articleRole, inference, objectMeta }),
    };
  };

  return build(root);
}
