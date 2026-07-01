// src/mcp/anchors.ts
// Navigation hints attached to MCP tool results so a UI client (the web_ui_demo
// chat sidebar) can highlight the section(s) an answer is about. Carried in the
// result's `_meta` under a SpecR-namespaced key — MCP's sanctioned channel for
// implementation metadata — so existing text-only consumers are unaffected.
// Pure: derives anchors from data the handlers already hold; no I/O.
import type {
  ParagraphSearchResult,
  InboundReference,
  OutboundReference,
  Finding,
} from '../db/index.js';

export const ANCHORS_META_KEY = 'specr/anchors';

export interface McpAnchor {
  readonly section: string;
  readonly specId?: string;
  readonly paragraphId?: string;
}

// Omit id fields that are absent — exactOptionalPropertyTypes forbids
// `{ specId: undefined }`. `null` (nullable columns) is treated as absent.
function anchor(section: string, specId?: string | null, paragraphId?: string | null): McpAnchor {
  return {
    section,
    ...(specId ? { specId } : {}),
    ...(paragraphId ? { paragraphId } : {}),
  };
}

export function anchorsFromSearch(results: readonly ParagraphSearchResult[]): McpAnchor[] {
  return results
    .filter((r) => r.specSection !== '')
    .map((r) => anchor(r.specSection, r.specId, r.paragraphId));
}

export function anchorsFromSpecTree(tree: {
  readonly id: string;
  readonly section: string;
}): McpAnchor[] {
  return tree.section ? [anchor(tree.section, tree.id)] : [];
}

export function anchorsFromReferences(a: {
  readonly section: string;
  readonly outbound: readonly OutboundReference[];
  readonly inbound: readonly InboundReference[];
}): McpAnchor[] {
  const out: McpAnchor[] = [anchor(a.section)];
  for (const o of a.outbound) {
    if (o.targetSection) out.push(anchor(o.targetSection, o.targetSpecId));
  }
  for (const i of a.inbound) {
    out.push(anchor(i.sourceSection, i.sourceSpecId, i.sourceParagraphId));
  }
  return out;
}

// A finding's anchor is where it should be *located* in the UI. `dangling_ref`
// carries an exact source paragraph (from BrokenRef) and points there. The other
// reference-consistency findings (related_listed_not_cited, related_cited_not_listed,
// standard_cited_not_listed) are built from ClassifiedRef, which has no per-paragraph
// locator — they anchor at the source spec's section instead. Submittal / implied /
// umbrella findings carry no single section locator in v1 → no anchor.
function findingAnchor(f: Finding): McpAnchor | null {
  switch (f.type) {
    case 'dangling_ref':
      return anchor(f.sourceSpecSection, f.sourceSpecId, f.sourceParagraphId);
    case 'related_listed_not_cited':
    case 'related_cited_not_listed':
    case 'standard_cited_not_listed':
      return anchor(f.sourceSpecSection, f.sourceSpecId);
    case 'present_not_required':
      return anchor(f.section, f.specId);
    case 'required_not_present':
      return anchor(f.section);
    default:
      return null;
  }
}

export function anchorsFromReport(findings: readonly Finding[]): McpAnchor[] {
  const out: McpAnchor[] = [];
  for (const f of findings) {
    const a = findingAnchor(f);
    if (a) out.push(a);
  }
  return out;
}

export function anchorsMeta(anchors: readonly McpAnchor[]): Record<string, unknown> | undefined {
  return anchors.length > 0 ? { [ANCHORS_META_KEY]: anchors } : undefined;
}
