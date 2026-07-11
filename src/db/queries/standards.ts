// Pure standards-rollup assembly (no DB, no env) — unit-testable in isolation.
// The DB read/upsert layer that feeds this lives in ./standards-read.ts. Mirrors
// the reference-graph pure/read split (ADR-063). See ADR-064 for the registry
// scope + verdict + citation-normalization decisions.

export const STANDARD_ANCHOR_CAP = 50;

export type StandardStatus = 'current' | 'superseded' | 'withdrawn' | 'unknown';

/** One paragraph-level citation of a standards-org reference (spec_references row). */
export interface StandardCitationRow {
  readonly standardCode: string; // raw cited string, e.g. "ASTM C150"
  readonly sourceSpecId: string;
  readonly sourceSpecSection: string;
  readonly sourceParagraphId: string;
}

/** A registry verdict row keyed on (orgCode, standardCode). */
export interface StandardRegistryRow {
  readonly orgCode: string;
  readonly standardCode: string;
  readonly title: string | null;
  readonly currentVersion: string | null;
  readonly sourceUrl: string | null;
  readonly status: StandardStatus;
  readonly lastVerifiedAt: string | null;
  readonly notes: string | null;
}

export interface StandardsScopeRef {
  readonly type: 'project' | 'library';
  readonly id: string;
}

export interface CitingSpec {
  readonly specId: string;
  readonly section: string;
}

export interface StandardRollupRow {
  readonly orgCode: string;
  readonly standardCode: string;
  readonly citationCount: number;
  readonly citingSpecs: readonly CitingSpec[];
  readonly anchors: readonly string[];
  readonly anchorsTruncated: boolean;
  readonly registered: boolean;
  readonly status: StandardStatus;
  readonly currentVersion: string | null;
  readonly sourceUrl: string | null;
  readonly title: string | null;
  readonly lastVerifiedAt: string | null;
  readonly notes: string | null;
}

export interface StandardFinding {
  readonly type: 'standard_superseded' | 'standard_withdrawn';
  readonly orgCode: string;
  readonly standardCode: string;
  readonly status: StandardStatus;
  readonly citingSpecs: readonly CitingSpec[];
  readonly anchors: readonly string[];
}

export interface StandardsSummary {
  readonly standards: number;
  readonly registered: number;
  readonly superseded: number;
  readonly withdrawn: number;
  readonly unverified: number;
  readonly findings: number;
}

export interface StandardsRollup {
  readonly scope: StandardsScopeRef;
  readonly standards: readonly StandardRollupRow[];
  readonly findings: readonly StandardFinding[];
  readonly summary: StandardsSummary;
  readonly anchorCap: number;
  readonly notes: readonly string[];
}

/**
 * Split a cited standard string into its registry key (ADR-064 §2). Splits on the
 * first run of whitespace: orgCode = leading token (UPPERCASED, trimmed),
 * standardCode = the remainder (trimmed, case preserved). A string with no
 * whitespace is treated as org-only with an empty standard code — a KNOWN
 * AMBIGUITY for .SEC RIDs like "ANSI/TIA-568.1" that carry no separator.
 */
export function parseStandardCitation(cited: string): {
  readonly orgCode: string;
  readonly standardCode: string;
} {
  const trimmed = cited.trim();
  const ws = /\s+/.exec(trimmed);
  if (ws === null) return { orgCode: trimmed.toUpperCase(), standardCode: '' };
  return {
    orgCode: trimmed.slice(0, ws.index).toUpperCase(),
    standardCode: trimmed.slice(ws.index + ws[0].length).trim(),
  };
}

// Registry lookup key — org uppercased (matches the write path), NUL-separated so
// "ASTM" + "C 150" cannot collide with "ASTM C" + "150".
const KEY_SEP = '\u0000';
function keyOf(orgCode: string, standardCode: string): string {
  return `${orgCode.toUpperCase()}${KEY_SEP}${standardCode}`;
}

interface CitationGroup {
  orgCode: string;
  standardCode: string;
  readonly specs: Map<string, string>; // specId -> section (first wins)
  readonly anchors: string[];
}

function groupCitations(rows: readonly StandardCitationRow[]): CitationGroup[] {
  const groups = new Map<string, CitationGroup>();
  for (const row of rows) {
    const { orgCode, standardCode } = parseStandardCitation(row.standardCode);
    const key = keyOf(orgCode, standardCode);
    let group = groups.get(key);
    if (group === undefined) {
      group = { orgCode, standardCode, specs: new Map(), anchors: [] };
      groups.set(key, group);
    }
    if (!group.specs.has(row.sourceSpecId))
      group.specs.set(row.sourceSpecId, row.sourceSpecSection);
    group.anchors.push(row.sourceParagraphId);
  }
  return [...groups.values()];
}

function citingSpecsOf(group: CitationGroup): CitingSpec[] {
  return [...group.specs.entries()]
    .map(([specId, section]) => ({ specId, section }))
    .sort((a, b) => a.section.localeCompare(b.section) || a.specId.localeCompare(b.specId));
}

function sortedAnchors(anchors: readonly string[]): string[] {
  return [...anchors].sort((a, b) => a.localeCompare(b));
}

// The joined registry fields defaulted for a cited-but-unregistered standard.
const UNREGISTERED_VIEW = {
  status: 'unknown' as StandardStatus,
  currentVersion: null,
  sourceUrl: null,
  title: null,
  lastVerifiedAt: null,
  notes: null,
} as const;

function toRollupRow(
  group: CitationGroup,
  registry: StandardRegistryRow | undefined
): StandardRollupRow {
  const anchors = sortedAnchors(group.anchors);
  const view = registry ?? UNREGISTERED_VIEW;
  return {
    orgCode: group.orgCode,
    standardCode: group.standardCode,
    citationCount: group.anchors.length,
    citingSpecs: citingSpecsOf(group),
    anchors: anchors.slice(0, STANDARD_ANCHOR_CAP),
    anchorsTruncated: anchors.length > STANDARD_ANCHOR_CAP,
    registered: registry !== undefined,
    status: view.status,
    currentVersion: view.currentVersion,
    sourceUrl: view.sourceUrl,
    title: view.title,
    lastVerifiedAt: view.lastVerifiedAt,
    notes: view.notes,
  };
}

function findingOf(row: StandardRollupRow): StandardFinding | null {
  if (row.status !== 'superseded' && row.status !== 'withdrawn') return null;
  return {
    type: row.status === 'superseded' ? 'standard_superseded' : 'standard_withdrawn',
    orgCode: row.orgCode,
    standardCode: row.standardCode,
    status: row.status,
    citingSpecs: row.citingSpecs,
    anchors: row.anchors,
  };
}

function summarize(
  rows: readonly StandardRollupRow[],
  findings: readonly StandardFinding[]
): StandardsSummary {
  return {
    standards: rows.length,
    registered: rows.filter((r) => r.registered).length,
    superseded: findings.filter((f) => f.type === 'standard_superseded').length,
    withdrawn: findings.filter((f) => f.type === 'standard_withdrawn').length,
    unverified: rows.filter((r) => r.lastVerifiedAt === null).length,
    findings: findings.length,
  };
}

export function buildStandardsRollup(
  scope: StandardsScopeRef,
  citations: readonly StandardCitationRow[],
  registryRows: readonly StandardRegistryRow[]
): StandardsRollup {
  const registry = new Map(registryRows.map((r) => [keyOf(r.orgCode, r.standardCode), r]));
  const standards = groupCitations(citations)
    .map((g) => toRollupRow(g, registry.get(keyOf(g.orgCode, g.standardCode))))
    .sort(
      (a, b) => a.orgCode.localeCompare(b.orgCode) || a.standardCode.localeCompare(b.standardCode)
    );
  const findings = standards.flatMap((r) => {
    const f = findingOf(r);
    return f ? [f] : [];
  });
  return {
    scope,
    standards,
    findings,
    summary: summarize(standards, findings),
    anchorCap: STANDARD_ANCHOR_CAP,
    notes: [
      `paragraph anchors per standard are capped at ${STANDARD_ANCHOR_CAP}; anchorsTruncated flags standards over the cap`,
    ],
  };
}
