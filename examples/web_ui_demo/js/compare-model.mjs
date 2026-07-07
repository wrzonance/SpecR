// Compare view-model + feature detection for the Compare view (#385). Pure,
// no dependencies. Maps the grounded ComparisonReport (ADR-047) into a
// render-ready shape, classifies each aligned row's cell pair, and
// presence-detects the additive #384 response fields (summary, alignedBy).

// Collapse runs of whitespace so "x  y" and "x y" compare equal — the matrix
// aligns verbatim text, but a whitespace-only delta is not a real difference.
function normalize(text) {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function cellState(cellA, cellB) {
  const a = cellA?.present === true;
  const b = cellB?.present === true;
  if (!a && !b) return 'absent';
  if (a && !b) return 'only-a';
  if (!a && b) return 'only-b';
  return normalize(cellA.text) === normalize(cellB.text) ? 'identical' : 'differing';
}

export function baselineStatesFor(report, originId) {
  const lensRows = report?.baseline?.rows;
  if (!Array.isArray(lensRows)) return null;
  const match = lensRows.find((row) => row.originId === originId);
  return Array.isArray(match?.states) ? match.states : null;
}

export function detectCompareFeatures(report) {
  return {
    summary: report?.summary != null,
    alignedBy: typeof report?.alignedBy === 'string' && report.alignedBy !== '',
  };
}

export function buildCompareView(report) {
  const columns = Array.isArray(report?.columns) ? report.columns : [];
  const rawRows = Array.isArray(report?.rows) ? report.rows : [];
  const hasBaseline = Array.isArray(report?.baseline?.rows);
  const rows = rawRows.map((row) => ({
    originId: row.originId,
    cells: row.cells ?? [],
    state: cellState(row.cells?.[0], row.cells?.[1]),
    baselineStates: baselineStatesFor(report, row.originId),
  }));
  return { columns, rows, hasBaseline, drift: report?.drift ?? [] };
}
