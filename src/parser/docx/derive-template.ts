// Consensus template derivation — §5 algorithm.
// Pure module: no I/O, no DB, no XML. Deterministic output (paths sorted).

import { STYLE_NODE_TYPES, StylePropertiesSchema } from '../../ast/index.js';
import type { NodeType, StyleNodeType, StyleProperties } from '../../ast/types.js';
import {
  ABSENT,
  ABSENT_KEY,
  absentWins,
  countVotes,
  mustGet,
  selectWinner,
} from './consensus-stats.js';
import type { DecisionSource, VoteCounts } from './consensus-stats.js';
import type { ClassifiedParagraph } from './types.js';

// ─── Public shapes ────────────────────────────────────────────────────────────

export interface DerivedRule {
  readonly nodeType: StyleNodeType;
  readonly properties: StyleProperties;
}

export interface PropertyDecision {
  readonly path: string;
  readonly value: unknown;
  readonly source: DecisionSource;
  readonly confidence: number;
  readonly disagreesWithIntent: boolean;
  readonly rejected: readonly { readonly value: unknown; readonly count: number }[];
}

export interface NodeTypeReport {
  readonly nodeType: StyleNodeType;
  readonly paragraphCount: number;
  readonly styledCount: number;
  readonly modalStyleId: string | null;
  readonly decisions: readonly PropertyDecision[];
}

export interface DerivationReport {
  readonly nodeTypes: readonly NodeTypeReport[];
  readonly skippedNodeTypes: readonly StyleNodeType[];
  readonly vanishSkipped: number;
}

export interface DerivedTemplate {
  readonly rules: readonly DerivedRule[];
  readonly report: DerivationReport;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface Voter {
  readonly styleId: string;
  readonly leaves: ReadonlyMap<string, unknown>;
}

// ─── Leaf flattening ──────────────────────────────────────────────────────────

/** Flatten a nested object into dotted leaf paths. Arrays and primitives are leaves. */
function flattenLeaves(obj: Record<string, unknown>, prefix = ''): ReadonlyMap<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      for (const [subPath, subVal] of flattenLeaves(val as Record<string, unknown>, path)) {
        result.set(subPath, subVal);
      }
    } else {
      result.set(path, val);
    }
  }
  return result;
}

/** Reconstruct a nested object from dotted leaf paths. */
function unflattenLeaves(leaves: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  for (const [path, value] of leaves) {
    const parts = path.split('.');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] as string;
      if (!(part in node) || typeof node[part] !== 'object' || node[part] === null) {
        node[part] = {};
      }
      node = node[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1] as string;
    node[leaf] = value;
  }
  return root;
}

// ─── Per-path decision helpers ────────────────────────────────────────────────

/** Extract the expanded list of defined (non-absent) values in insertion order. */
function collectDefinedValues(voteCounts: VoteCounts): unknown[] {
  const result: unknown[] = [];
  for (const key of voteCounts.order) {
    if (key === ABSENT_KEY) continue;
    const entry = mustGet(voteCounts.counts, key, 'collectDefinedValues');
    for (let i = 0; i < entry.count; i++) {
      result.push(entry.value);
    }
  }
  return result;
}

/** Build the rejected-values list: defined values that are not the chosen winner. */
function buildRejected(
  voteCounts: VoteCounts,
  chosenKey: string
): { value: unknown; count: number }[] {
  const result: { value: unknown; count: number }[] = [];
  for (const key of voteCounts.order) {
    if (key === ABSENT_KEY || key === chosenKey) continue;
    const entry = mustGet(voteCounts.counts, key, 'buildRejected');
    result.push({ value: entry.value, count: entry.count });
  }
  return result;
}

// ─── Per-path decision ────────────────────────────────────────────────────────

interface PathVotes {
  readonly path: string;
  readonly values: readonly unknown[];
  readonly styledCount: number;
  readonly modalStyleValue: unknown;
}

function decidePath(votes: PathVotes): PropertyDecision | null {
  const { path, values, styledCount, modalStyleValue } = votes;
  const voteCounts = countVotes(values);
  if (absentWins(voteCounts)) return null;

  const definedValues = collectDefinedValues(voteCounts);
  if (definedValues.length === 0) return null;

  const intentValue = modalStyleValue !== ABSENT ? modalStyleValue : undefined;
  const { chosenValue, source } = selectWinner({ definedValues, styledCount, intentValue });

  const chosenKey = JSON.stringify(chosenValue);
  const chosenCount = voteCounts.counts.get(chosenKey)?.count ?? 0;
  const confidence = styledCount > 0 ? chosenCount / styledCount : 1;
  const rejected = buildRejected(voteCounts, chosenKey);
  const disagreesWithIntent =
    intentValue !== undefined && JSON.stringify(intentValue) !== JSON.stringify(chosenValue);

  return { path, value: chosenValue, source, confidence, disagreesWithIntent, rejected };
}

// ─── Voter construction helpers ───────────────────────────────────────────────

function buildVoters(
  paragraphs: readonly ClassifiedParagraph[],
  effectiveStyles: ReadonlyMap<string, StyleProperties>
): Voter[] {
  const voters: Voter[] = [];
  for (const cp of paragraphs) {
    const sid = cp.paragraph.styleId;
    if (!sid) continue;
    const style = effectiveStyles.get(sid);
    if (!style) continue;
    voters.push({ styleId: sid, leaves: flattenLeaves(style) });
  }
  return voters;
}

function findModalStyleId(voters: readonly Voter[]): string | null {
  if (voters.length === 0) return null;
  const sidCounts = new Map<string, number>();
  const sidOrder: string[] = [];
  for (const v of voters) {
    const existing = sidCounts.get(v.styleId);
    if (existing !== undefined) {
      sidCounts.set(v.styleId, existing + 1);
    } else {
      sidCounts.set(v.styleId, 1);
      sidOrder.push(v.styleId);
    }
  }
  let best = sidOrder[0] as string;
  for (const sid of sidOrder) {
    if ((sidCounts.get(sid) ?? 0) > (sidCounts.get(best) ?? 0)) {
      best = sid;
    }
  }
  return best;
}

function collectPathUniverse(voters: readonly Voter[]): readonly string[] {
  const pathSet = new Set<string>();
  for (const v of voters) {
    for (const p of v.leaves.keys()) {
      pathSet.add(p);
    }
  }
  return [...pathSet].sort((a, b) => a.localeCompare(b));
}

// ─── Path decisions for a group ──────────────────────────────────────────────

interface PathDecisionResult {
  readonly decidedLeaves: ReadonlyMap<string, unknown>;
  readonly decisions: readonly PropertyDecision[];
}

function decideAllPaths(
  paths: readonly string[],
  voters: readonly Voter[],
  modalLeaves: ReadonlyMap<string, unknown>,
  styledCount: number
): PathDecisionResult {
  const decidedLeaves = new Map<string, unknown>();
  const decisions: PropertyDecision[] = [];
  for (const path of paths) {
    const voteValues: unknown[] = voters.map((v) =>
      v.leaves.has(path) ? v.leaves.get(path) : ABSENT
    );
    const modalStyleValue = modalLeaves.has(path) ? modalLeaves.get(path) : ABSENT;
    const decision = decidePath({ path, values: voteValues, styledCount, modalStyleValue });
    if (decision !== null) {
      decidedLeaves.set(path, decision.value);
      decisions.push(decision);
    }
  }
  return { decidedLeaves, decisions };
}

// ─── Per NodeType derivation ──────────────────────────────────────────────────

function deriveForNodeType(
  nodeType: StyleNodeType,
  paragraphs: readonly ClassifiedParagraph[],
  effectiveStyles: ReadonlyMap<string, StyleProperties>
): { report: NodeTypeReport; rule: DerivedRule | null } {
  const paragraphCount = paragraphs.length;
  const voters = buildVoters(paragraphs, effectiveStyles);
  const styledCount = voters.length;
  const modalStyleId = findModalStyleId(voters);

  if (styledCount === 0) {
    return {
      report: { nodeType, paragraphCount, styledCount, modalStyleId, decisions: [] },
      rule: null,
    };
  }

  const modalStyle = modalStyleId ? effectiveStyles.get(modalStyleId) : undefined;
  const modalLeaves: ReadonlyMap<string, unknown> = modalStyle
    ? flattenLeaves(modalStyle)
    : new Map();

  const paths = collectPathUniverse(voters);
  const { decidedLeaves, decisions } = decideAllPaths(paths, voters, modalLeaves, styledCount);
  const properties = StylePropertiesSchema.parse(unflattenLeaves(decidedLeaves));

  return {
    report: { nodeType, paragraphCount, styledCount, modalStyleId, decisions },
    rule: { nodeType, properties },
  };
}

// ─── Population helpers ───────────────────────────────────────────────────────

interface Partition {
  readonly active: readonly ClassifiedParagraph[];
  readonly vanishSkipped: number;
}

function partitionVanish(classified: readonly ClassifiedParagraph[]): Partition {
  let vanishSkipped = 0;
  const active: ClassifiedParagraph[] = [];
  for (const cp of classified) {
    if (cp.isVanish) {
      vanishSkipped++;
    } else {
      active.push(cp);
    }
  }
  return { active, vanishSkipped };
}

function isStyleNodeType(nt: NodeType): nt is StyleNodeType {
  return STYLE_NODE_TYPES.some((styleable) => styleable === nt);
}

function groupByNodeType(
  active: readonly ClassifiedParagraph[]
): ReadonlyMap<StyleNodeType, ClassifiedParagraph[]> {
  const groups = new Map<StyleNodeType, ClassifiedParagraph[]>();
  for (const nt of STYLE_NODE_TYPES) {
    groups.set(nt, []);
  }
  for (const cp of active) {
    if (!isStyleNodeType(cp.nodeType)) continue; // continuation/note/spec never vote
    mustGet(groups, cp.nodeType, 'groupByNodeType').push(cp);
  }
  return groups;
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function deriveTemplate(
  classified: readonly ClassifiedParagraph[],
  effectiveStyles: ReadonlyMap<string, StyleProperties>
): DerivedTemplate {
  const { active, vanishSkipped } = partitionVanish(classified);
  const groups = groupByNodeType(active);

  const rules: DerivedRule[] = [];
  const nodeTypeReports: NodeTypeReport[] = [];
  const skippedNodeTypes: StyleNodeType[] = [];

  for (const nt of STYLE_NODE_TYPES) {
    const group = groups.get(nt) ?? [];
    if (group.length === 0) {
      skippedNodeTypes.push(nt);
      continue;
    }
    const { report, rule } = deriveForNodeType(nt, group, effectiveStyles);
    nodeTypeReports.push(report);
    if (rule !== null) rules.push(rule);
  }

  return {
    rules,
    report: { nodeTypes: nodeTypeReports, skippedNodeTypes, vanishSkipped },
  };
}
