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

// A finding's anchor is where it should be *located* in the UI. Almost every
// Finding variant carries a source spec section (`sourceSpecSection`) plus a spec
// id under one of two keys — `sourceSpecId`, or `specId` on submittal findings —
// and many carry an exact `sourceParagraphId`. present_not_required /
// required_not_present instead carry their own `section` (+ optional specId).
// A structural projection (not a per-type switch) covers every locatable finding
// — reference, submittal, implied, umbrella — and stays robust to new Finding
// variants. Reference-consistency findings on origin/main lack sourceParagraphId
// (built from ClassifiedRef) and gracefully fall back to a section-level anchor.
function findingSpecId(f: Finding): string | undefined {
  if ('sourceSpecId' in f) return f.sourceSpecId;
  if ('specId' in f) return f.specId;
  return undefined;
}

function findingAnchor(f: Finding): McpAnchor | null {
  if ('sourceSpecSection' in f) {
    const paragraphId = 'sourceParagraphId' in f ? f.sourceParagraphId : undefined;
    return anchor(f.sourceSpecSection, findingSpecId(f), paragraphId);
  }
  if ('section' in f) return anchor(f.section, findingSpecId(f));
  return null;
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
