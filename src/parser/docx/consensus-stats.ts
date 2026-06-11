// Consensus statistical helpers — vote counting + §5 winner-selection waterfall.
// Pure leaf module: no I/O, no DB, no XML, no internal imports.
// Extracted verbatim from derive-template.ts (#154).

// ─── Public shapes ────────────────────────────────────────────────────────────

// Sentinel for "this voter has no value at this path"
export const ABSENT = Symbol('absent');
export const ABSENT_KEY = '__absent__';

export interface VoteCounts {
  readonly counts: ReadonlyMap<string, { readonly value: unknown; readonly count: number }>;
  readonly order: readonly string[];
}

export type DecisionSource = 'consensus' | 'intent' | 'median' | 'single' | 'mode';

/** Map lookup that throws a contextful invariant error instead of returning undefined. */
export function mustGet<K, V>(map: ReadonlyMap<K, V>, key: K, ctx: string): V {
  const v = map.get(key);
  if (v === undefined) {
    throw new Error(`${ctx}: invariant violated — missing key ${String(key)}`);
  }
  return v;
}

// ─── Statistical helpers ──────────────────────────────────────────────────────

/** Mode of a value array by JSON.stringify, first-seen tie-break. Returns [value, count]. */
export function modeOf(values: readonly unknown[]): [unknown, number] {
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
export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor((sorted.length - 1) / 2);
  return sorted[mid] as number;
}

// ─── Vote counting ────────────────────────────────────────────────────────────

/** Build a count map over raw vote values (including ABSENT sentinel). */
export function countVotes(values: readonly unknown[]): VoteCounts {
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
export function absentWins(voteCounts: VoteCounts): boolean {
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

export interface WinnerInput {
  readonly definedValues: readonly unknown[];
  readonly styledCount: number;
  readonly intentValue: unknown;
}

/** Select the winning value and source per §5 decision order. */
export function selectWinner(input: WinnerInput): {
  chosenValue: unknown;
  source: DecisionSource;
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
