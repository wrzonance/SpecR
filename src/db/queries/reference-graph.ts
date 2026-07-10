import { buildUmbrellaCalloutFindings } from './umbrella-callouts.js';

// Pure reference-graph assembly (no DB, no env) — unit-testable in isolation.
// The DB read layer that feeds this lives in ./reference-graph-read.ts.

export const ANCHOR_CAP = 50;

export interface GraphNodeInput {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
}
export interface GraphRefRowInput {
  readonly sourceSpecId: string;
  readonly targetSection: string;
  readonly sourceParagraphId: string;
}
export interface GraphScopeRef {
  readonly type: 'project' | 'library';
  readonly id: string;
}
export interface GraphNode {
  readonly specId: string;
  readonly section: string;
  readonly title: string;
  readonly division: string | null;
  readonly isUmbrella: boolean;
}
export interface GraphEdge {
  readonly sourceSpecId: string;
  readonly targetSection: string;
  readonly targetSpecId: string | null;
  readonly citationCount: number;
  readonly anchors?: readonly string[];
  readonly anchorsTruncated?: boolean;
}
export interface UmbrellaDivision {
  readonly division: string;
  readonly umbrellaSpecId: string | null;
  readonly umbrellaPresent: boolean;
  readonly notCalledOut: readonly { readonly specId: string; readonly section: string }[];
}
export interface ReferenceGraph {
  readonly scope: GraphScopeRef;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly umbrella: readonly UmbrellaDivision[];
  readonly anchorCap: number;
  readonly notes: readonly string[];
}

function divisionOf(section: string): string | null {
  return /^(\d{2}) /.exec(section)?.[1] ?? null;
}

function toNode(input: GraphNodeInput): GraphNode {
  const division = divisionOf(input.section);
  return {
    specId: input.specId,
    section: input.section,
    title: input.title,
    division,
    isUmbrella: division !== null && input.section === `${division} 00 00`,
  };
}

function bySectionThenId(a: GraphNode, b: GraphNode): number {
  return a.section.localeCompare(b.section) || a.specId.localeCompare(b.specId);
}

// section -> the in-scope spec id that owns it (first by section then specId).
function sectionIndex(sortedNodes: readonly GraphNode[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const n of sortedNodes) if (!index.has(n.section)) index.set(n.section, n.specId);
  return index;
}

interface EdgeGroup {
  readonly sourceSpecId: string;
  readonly targetSection: string;
  readonly anchors: string[];
}

function groupRefs(refRows: readonly GraphRefRowInput[]): EdgeGroup[] {
  const groups = new Map<string, EdgeGroup>();
  for (const r of refRows) {
    const key = `${r.sourceSpecId} ${r.targetSection}`;
    const existing = groups.get(key);
    if (existing) existing.anchors.push(r.sourceParagraphId);
    else
      groups.set(key, {
        sourceSpecId: r.sourceSpecId,
        targetSection: r.targetSection,
        anchors: [r.sourceParagraphId],
      });
  }
  return [...groups.values()];
}

function toEdge(
  group: EdgeGroup,
  index: ReadonlyMap<string, string>,
  includeAnchors: boolean
): GraphEdge {
  const base: GraphEdge = {
    sourceSpecId: group.sourceSpecId,
    targetSection: group.targetSection,
    targetSpecId: index.get(group.targetSection) ?? null,
    citationCount: group.anchors.length,
  };
  if (!includeAnchors) return base;
  return {
    ...base,
    anchors: group.anchors.slice(0, ANCHOR_CAP),
    anchorsTruncated: group.anchors.length > ANCHOR_CAP,
  };
}

function sortEdges(
  edges: readonly GraphEdge[],
  sectionBySpec: ReadonlyMap<string, string>
): GraphEdge[] {
  return [...edges].sort((a, b) => {
    const sa = sectionBySpec.get(a.sourceSpecId) ?? '';
    const sb = sectionBySpec.get(b.sourceSpecId) ?? '';
    return (
      sa.localeCompare(sb) ||
      a.sourceSpecId.localeCompare(b.sourceSpecId) ||
      a.targetSection.localeCompare(b.targetSection)
    );
  });
}

function notCalledOutByDivision(
  findings: ReturnType<typeof buildUmbrellaCalloutFindings>['findings']
): ReadonlyMap<string, { specId: string; section: string }[]> {
  const grouped = new Map<string, { specId: string; section: string }[]>();
  for (const f of findings) {
    const division = f.umbrellaSpecSection.slice(0, 2);
    const list = grouped.get(division) ?? [];
    list.push({ specId: f.sourceSpecId, section: f.sourceSpecSection });
    grouped.set(division, list);
  }
  return grouped;
}

function umbrellaAnnotations(
  nodes: readonly GraphNode[],
  refRows: readonly GraphRefRowInput[]
): UmbrellaDivision[] {
  const present = nodes.map((n) => ({ specId: n.specId, section: n.section }));
  const sectionRefs = refRows.map((r) => ({ sourceSpecId: r.sourceSpecId, value: r.targetSection }));
  const notCalledOut = notCalledOutByDivision(
    buildUmbrellaCalloutFindings(present, sectionRefs).findings
  );
  const divisions = [
    ...new Set(nodes.map((n) => n.division).filter((d): d is string => d !== null)),
  ].sort((a, b) => a.localeCompare(b));
  return divisions.map((division) => {
    const umbrella = nodes.find((n) => n.section === `${division} 00 00`);
    return {
      division,
      umbrellaSpecId: umbrella?.specId ?? null,
      umbrellaPresent: umbrella !== undefined,
      notCalledOut: (notCalledOut.get(division) ?? []).sort((a, b) =>
        a.section.localeCompare(b.section)
      ),
    };
  });
}

export function buildReferenceGraph(
  scope: GraphScopeRef,
  nodeInputs: readonly GraphNodeInput[],
  refRows: readonly GraphRefRowInput[],
  opts: { readonly includeAnchors: boolean }
): ReferenceGraph {
  const nodes = nodeInputs.map(toNode).sort(bySectionThenId);
  const index = sectionIndex(nodes);
  const sectionBySpec = new Map(nodes.map((n) => [n.specId, n.section]));
  const edges = sortEdges(
    groupRefs(refRows).map((g) => toEdge(g, index, opts.includeAnchors)),
    sectionBySpec
  );
  const notes = opts.includeAnchors
    ? [
        `paragraph anchors included per edge, capped at ${ANCHOR_CAP}; anchorsTruncated flags edges over the cap`,
      ]
    : [];
  return {
    scope,
    nodes,
    edges,
    umbrella: umbrellaAnnotations(nodes, refRows),
    anchorCap: ANCHOR_CAP,
    notes,
  };
}
