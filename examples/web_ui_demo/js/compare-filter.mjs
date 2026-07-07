// Filter + collapse helpers for the Compare view modes (#395). Pure, no DOM.
// `resolveCounts` rolls the full matrix into chip counts (preferring the server
// summary); `buildSegments` turns the full row list into the render sequence for
// a filter, collapsing runs of identical rows into expandable gaps in "changes".

export const COMPARE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'changes', label: 'Changes only' },
  { id: 'only-a', label: 'Only in A' },
  { id: 'only-b', label: 'Only in B' },
];

const CHANGE_STATES = new Set(['differing', 'only-a', 'only-b']);

// Which row states a filter admits. 'changes' = anything not identical.
export function matchesFilter(state, filterId) {
  switch (filterId) {
    case 'changes':
      return CHANGE_STATES.has(state);
    case 'only-a':
      return state === 'only-a';
    case 'only-b':
      return state === 'only-b';
    case 'all':
    default:
      return true;
  }
}

// Full-matrix counts for the chip badges, computed from the rows we already hold.
export function filterCounts(rows) {
  const counts = { all: rows.length, changes: 0, 'only-a': 0, 'only-b': 0 };
  for (const row of rows) {
    if (CHANGE_STATES.has(row.state)) counts.changes += 1;
    if (row.state === 'only-a') counts['only-a'] += 1;
    if (row.state === 'only-b') counts['only-b'] += 1;
  }
  return counts;
}

// Prefer the server's full-matrix summary (ADR-053) when attached; fall back
// per-field to the locally computed counts. summary.differing already folds
// modified + one-sided rows, matching our 'changes' definition; per-column
// onlyIn gives the one-sided counts.
export function resolveCounts(rows, summary) {
  const computed = filterCounts(rows);
  if (!summary || typeof summary !== 'object') return computed;
  const columns = Array.isArray(summary.columns) ? summary.columns : [];
  const pick = (value, fallback) => (Number.isFinite(value) ? value : fallback);
  return {
    all: pick(summary.rows, computed.all),
    changes: pick(summary.differing, computed.changes),
    'only-a': pick(columns[0]?.onlyIn, computed['only-a']),
    'only-b': pick(columns[1]?.onlyIn, computed['only-b']),
  };
}

// Collapse maximal runs of identical rows into gap segments; every other row is
// its own row segment (GitHub context expander for 'changes').
function segmentChanges(rows) {
  const segments = [];
  let gap = null;
  rows.forEach((row, index) => {
    if (row.state === 'identical') {
      if (!gap) gap = { kind: 'gap', key: index, rows: [] };
      gap.rows.push(row);
      return;
    }
    if (gap) {
      segments.push(gap);
      gap = null;
    }
    segments.push({ kind: 'row', key: index, row });
  });
  if (gap) segments.push(gap);
  return segments;
}

// Render sequence for a filter. 'changes' collapses identical runs into
// expandable gaps; other filters return just their matching rows (no gaps).
// `key` is the row's index in the full matrix — stable for expansion tracking.
export function buildSegments(rows, filterId) {
  if (filterId === 'changes') return segmentChanges(rows);
  const segments = [];
  rows.forEach((row, index) => {
    if (matchesFilter(row.state, filterId)) segments.push({ kind: 'row', key: index, row });
  });
  return segments;
}
