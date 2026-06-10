// Consensus template derivation — §5 algorithm.
// Pure module: no I/O, no DB, no XML. Deterministic output (paths sorted).

import { STYLE_NODE_TYPES, StylePropertiesSchema } from '../../ast/index.js';
import type { StyleNodeType, StyleProperties } from '../../ast/types.js';
import type { ClassifiedParagraph } from './types.js';

// ─── Public shapes ────────────────────────────────────────────────────────────

export interface DerivedRule {
  readonly nodeType: StyleNodeType;
  readonly properties: StyleProperties;
}

export interface PropertyDecision {
  readonly path: string;
  readonly value: unknown;
  readonly source: 'consensus' | 'intent' | 'median' | 'single' | 'mode';
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

interface VoteCounts {
  readonly counts: ReadonlyMap<string, { readonly value: unknown; readonly count: number }>;
  readonly order: readonly string[];
}

// Sentinel for "this voter has no value at this path"
const ABSENT = Symbol('absent');
const ABSENT_KEY = '__absent__';

/** Map lookup that throws a contextful invariant error instead of returning undefined. */
function mustGet<K, V>(map: ReadonlyMap<K, V>, key: K, ctx: string): V {
  const v = map.get(key);
  if (v === undefined) {
    throw new Error(`${ctx}: invariant violated — missing key ${String(key)}`);
  }
  return v;
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

// ─── Statistical helpers ──────────────────────────────────────────────────────

/** Mode of a value array by JSON.stringify, first-seen tie-break. Returns [value, count]. */
function modeOf(values: readonly unknown[]): [unknown, number] {
  const counts = new Map<string, { readonly value: unknown; readonly count: number }>();
  const order: string[] = [];
  for (const v of values) {
    const key = JSON.stringify(v);
    const entry = counts.get(key);
    if (entry) {
      counts.set(key, { ...entry, count: entry.count + 1 });
    } else {
      counts.set(key, { value: v, count: 1 });
      order.push(key);
    }
  }
  // Strict > and insertion-order iteration give the first-seen tie-break.
  let bestValue: unknown;
  let bestCount = 0;
  for (const key of order) {
    const entry = mustGet(counts, key, 'modeOf');
    if (entry.count > bestCount) {
      bestValue = entry.value;
      bestCount = entry.count;
    }
  }
  return [bestValue, bestCount];
}

/** Median of a numeric array. Lower-middle on even counts. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted[mid] as number;
}

// ─── Vote counting ────────────────────────────────────────────────────────────

/** Build a count map over raw vote values (including ABSENT sentinel). */
function countVotes(values: readonly unknown[]): VoteCounts {
  const counts = new Map<string, { readonly value: unknown; readonly count: number }>();
  const order: string[] = [];
  for (const v of values) {
    const key = v === ABSENT ? ABSENT_KEY : JSON.stringify(v);
    const entry = counts.get(key);
    if (entry) {
      counts.set(key, { ...entry, count: entry.count + 1 });
    } else {
      counts.set(key, { value: v, count: 1 });
      order.push(key);
    }
  }
  return { counts, order };
}

/**
 * Returns true only when absent STRICTLY beats every defined value's count.
 * On a tie, absent does NOT win — the path falls through to the §5 decision
 * waterfall (dominant → intent → median → fallback mode), so the modal
 * style's intent can keep a property that half the voters carry.
 */
function absentWins(voteCounts: VoteCounts): boolean {
  const absentCount = voteCounts.counts.get(ABSENT_KEY)?.count ?? 0;
  let maxDefinedCount = 0;
  for (const [key, entry] of voteCounts.counts) {
    if (key !== ABSENT_KEY && entry.count > maxDefinedCount) {
      maxDefinedCount = entry.count;
    }
  }
  return absentCount > maxDefinedCount;
}

// ─── Winner selection ─────────────────────────────────────────────────────────

interface WinnerInput {
  readonly definedValues: readonly unknown[];
  readonly styledCount: number;
  readonly intentValue: unknown;
}

/** Select the winning value and source per §5 decision order. */
function selectWinner(input: WinnerInput): {
  chosenValue: unknown;
  source: PropertyDecision['source'];
} {
  const { definedValues, styledCount, intentValue } = input;
  if (styledCount === 1) {
    return { chosenValue: definedValues[0], source: 'single' };
  }
  const [modeVal, modeCount] = modeOf(definedValues);
  if (modeCount / styledCount > 0.5) {
    return { chosenValue: modeVal, source: 'consensus' };
  }
  if (intentValue !== undefined) {
    return { chosenValue: intentValue, source: 'intent' };
  }
  if (definedValues.every((v) => typeof v === 'number')) {
    const numericValues = definedValues as number[];
    return { chosenValue: medianOf(numericValues), source: 'median' };
  }
  // Low-plurality fallback: no dominant value, no intent, non-numeric votes.
  // 'mode' (not 'consensus') — consensus means >0.5, which already failed here.
  const [fallback] = modeOf(definedValues);
  return { chosenValue: fallback, source: 'mode' };
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

function groupByNodeType(
  active: readonly ClassifiedParagraph[]
): ReadonlyMap<StyleNodeType, ClassifiedParagraph[]> {
  const groups = new Map<StyleNodeType, ClassifiedParagraph[]>();
  for (const nt of STYLE_NODE_TYPES) {
    groups.set(nt, []);
  }
  for (const cp of active) {
    const nt = cp.nodeType as StyleNodeType;
    const group = groups.get(nt);
    if (group) group.push(cp);
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
