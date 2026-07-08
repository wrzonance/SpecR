// Filter + position helpers for the Scoring view (WS2, #424). Pure, no DOM —
// mirrors compare-filter.mjs's split between a pure report-model file and the
// DOM-touching view (scoring.js imports this; scoring.test.mjs exercises it
// directly). Operates on `HierarchyReport.paragraphs` (GET /specs/:id/hierarchy-report),
// which the server already returns worst-first (ascending confidence).

export const SCORING_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'below-50', label: '<50%' },
  { id: 'below-60', label: '<60%' },
  { id: 'document-order', label: 'Document order' },
];

// Confidence band for badge coloring. Thresholds match the below-50/below-60
// filters and HIERARCHY_REVIEW_THRESHOLD (src/lib/hierarchy-summary.ts) exactly
// — 'mid' is the "already below the review threshold, but not critically low"
// band between the two filter cutoffs.
export function confidenceBand(confidence) {
  if (confidence < 0.5) return 'low';
  if (confidence < 0.6) return 'mid';
  return 'high';
}

// Which paragraphs a filter admits by confidence band. 'all' and
// 'document-order' are unfiltered — 'document-order' only changes ORDER, not
// membership, so a spec with every paragraph confident still shows something.
function admitsBand(confidence, filterId) {
  if (filterId === 'below-50') return confidence < 0.5;
  if (filterId === 'below-60') return confidence < 0.6;
  return true;
}

// Pure report-model helper: given a HierarchyReport's `paragraphs` (already
// worst-first) and a filter id, return the rows to render.
//   - 'all'                    -> every paragraph, worst-first (server order)
//   - 'below-50' / 'below-60'  -> confidence-banded subset, worst-first
//   - 'document-order'         -> every paragraph, re-sorted by tree position
//     (positionOf: Map<nodeId, number>, from buildPositionMap). A paragraph
//     missing from positionOf sorts last; ties keep their worst-first order
//     (Array#sort is stable).
export function selectScoringRows(paragraphs, filterId, positionOf = new Map()) {
  const rows = paragraphs.filter((paragraph) => admitsBand(paragraph.confidence, filterId));
  if (filterId !== 'document-order') return rows;
  const positionOr = (nodeId) => (positionOf.has(nodeId) ? positionOf.get(nodeId) : Infinity);
  return [...rows].sort((a, b) => positionOr(a.nodeId) - positionOr(b.nodeId));
}

// Builds a nodeId -> document-position map from a fetched spec tree
// (getSpecTree's { tree: { parts: SpecNode[] } } shape), depth-first in array
// order — the same traversal order tree.js renders (part -> article -> pr
// children), so 'document-order' matches what the right pane shows top to bottom.
export function buildPositionMap(tree) {
  const positions = new Map();
  let counter = 0;
  function visit(nodes) {
    for (const node of nodes ?? []) {
      positions.set(node.id, counter);
      counter += 1;
      visit(node.children);
    }
  }
  visit(tree?.parts);
  return positions;
}
