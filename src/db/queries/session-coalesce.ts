import type { ParagraphHistoryEntry } from './history.js';
import type { CheckpointBoundary } from './checkpoints.js';

// ADR-052 D3 (issue #380, task 4) — the tier-1 coalescer: folds tier-0
// paragraph_versions rows into read-time sessions, one per uninterrupted span
// of edits by a single actor. Pure, no DB import — a future read-path task
// supplies already-loaded entries and boundaries.
//
// D3 amendment (2026-07-27 design spike) pins two invariants a throwaway
// implementation got wrong on the first pass — both are load-bearing here,
// not prose to re-derive:
//   1. Sealing joins on ParagraphHistoryEntry.contentVersion, never the
//      paragraph-local `version` (display/ordering only).
//   2. The checkpoint-boundary sealing test is `prev <= N < next`: the edit
//      that reaches exactly a checkpoint's contentVersion N is sealed by it;
//      the next edit strictly past N opens a new pending session.
// See docs/adr/052-version-history-review-grain-identity.md.

/**
 * `ParagraphHistoryEntry` (history.ts) does not yet carry actor identity — a
 * sibling task in this issue extends it with `userId`/`actorLabel`. This
 * coalescer needs the actor per entry to partition sessions, so it depends on
 * that shape structurally rather than blocking on history.ts's extension
 * landing first: once `ParagraphHistoryEntry` itself carries
 * `userId: string | null`, every real entry already satisfies this type
 * unmodified, and callers can drop this alias in favor of the plain import.
 */
export type CoalescableHistoryEntry = ParagraphHistoryEntry & { readonly userId: string | null };

/** One read-time session: a coalesced, uninterrupted span of tier-0 edits by
 *  a single actor, with a net before/after diff (ADR-052 D3). */
export interface ParagraphHistorySession {
  readonly userId: string | null;
  /** Paragraph-local `ParagraphHistoryEntry.version` of the session's
   *  first/last entry — display/ordering only, NEVER the checkpoint join
   *  key (ADR-052 D3 amendment #1). */
  readonly firstVersion: number;
  readonly lastVersion: number;
  /** null iff the session's first entry has `op === 'insert'` (the
   *  paragraph's life opens here); otherwise the immediately preceding
   *  entry's text/nodeType in the full oldest-first entries array. */
  readonly beforeText: string | null;
  readonly beforeNodeType: string | null;
  readonly afterText: string;
  readonly afterNodeType: string;
  readonly startedAt: string;
  readonly endedAt: string;
  /** The session's LAST entry's `contentVersion` — the actual checkpoint
   *  join key. null when that entry predates migration 046 ("never sealed",
   *  amendment #2) — never guessed via `lastVersion`. */
  readonly sealedContentVersion: number | null;
  /** Derived FROM `sealedContentVersion`: the checkpoint with the smallest
   *  `contentVersion >= sealedContentVersion`, or null when no checkpoint
   *  has reached this session yet (still pending) or `sealedContentVersion`
   *  is null (never sealed). */
  readonly sealedByCheckpointId: string | null;
  /** The raw tier-0 span this session coalesces, oldest first — surfaced
   *  only on drill-down (`?raw=true`, ADR-052 D3). */
  readonly entries: readonly CoalescableHistoryEntry[];
}

function differentActor(prev: CoalescableHistoryEntry, next: CoalescableHistoryEntry): boolean {
  return prev.userId !== next.userId;
}

function exceedsSessionWindow(
  prev: CoalescableHistoryEntry,
  next: CoalescableHistoryEntry,
  sessionWindowMs: number
): boolean {
  return Date.parse(next.snapshotAt) - Date.parse(prev.snapshotAt) > sessionWindowMs;
}

/** ADR-052 D3 amendment #3: `prev <= N < next`, never `(prev, next]`. Skips
 *  the test entirely when either side's `contentVersion` is null (a legacy
 *  pre-046 row) — there is no recoverable axis to join a boundary against,
 *  so a null-`contentVersion` neighbor can never itself trigger a split. */
function crossesCheckpointBoundary(
  prev: CoalescableHistoryEntry,
  next: CoalescableHistoryEntry,
  checkpointBoundaries: readonly CheckpointBoundary[]
): boolean {
  const prevVersion = prev.contentVersion;
  const nextVersion = next.contentVersion;
  if (prevVersion === null || nextVersion === null) return false;
  return checkpointBoundaries.some(
    (boundary) => prevVersion <= boundary.contentVersion && boundary.contentVersion < nextVersion
  );
}

function shouldStartNewSession(
  prev: CoalescableHistoryEntry,
  next: CoalescableHistoryEntry,
  checkpointBoundaries: readonly CheckpointBoundary[],
  sessionWindowMs: number
): boolean {
  return (
    differentActor(prev, next) ||
    exceedsSessionWindow(prev, next, sessionWindowMs) ||
    crossesCheckpointBoundary(prev, next, checkpointBoundaries)
  );
}

interface SessionSpan {
  readonly entries: readonly CoalescableHistoryEntry[];
  /** The entry immediately before this span's first entry in the full
   *  oldest-first entries array — undefined when the span opens the array. */
  readonly precedingEntry: CoalescableHistoryEntry | undefined;
}

/** Accumulator threaded through partitionIntoSpans — never mutated in place,
 *  every transition returns a fresh state built via spread. */
interface PartitionState {
  readonly spans: readonly SessionSpan[];
  readonly current: readonly CoalescableHistoryEntry[];
  readonly currentPreceding: CoalescableHistoryEntry | undefined;
}

const EMPTY_PARTITION_STATE: PartitionState = {
  spans: [],
  current: [],
  currentPreceding: undefined,
};

/** Appends the in-progress span to `spans` (a no-op when it's empty) and
 *  resets the accumulator, ready to start the next span. */
function closeSpan(state: PartitionState): PartitionState {
  if (state.current.length === 0) return state;
  return {
    spans: [...state.spans, { entries: state.current, precedingEntry: state.currentPreceding }],
    current: [],
    currentPreceding: undefined,
  };
}

/** One partitioning step: a null-`userId` entry always closes the
 *  in-progress span and becomes its own singleton (checked first, before the
 *  actor/gap/boundary rules); otherwise the entry either extends the
 *  in-progress span or closes it and opens a new one. */
function advancePartition(
  state: PartitionState,
  entry: CoalescableHistoryEntry,
  priorEntry: CoalescableHistoryEntry | undefined,
  checkpointBoundaries: readonly CheckpointBoundary[],
  sessionWindowMs: number
): PartitionState {
  if (entry.userId === null) {
    const closed = closeSpan(state);
    return {
      spans: [...closed.spans, { entries: [entry], precedingEntry: priorEntry }],
      current: [],
      currentPreceding: undefined,
    };
  }
  const last = state.current.at(-1);
  if (!last || shouldStartNewSession(last, entry, checkpointBoundaries, sessionWindowMs)) {
    return { ...closeSpan(state), current: [entry], currentPreceding: priorEntry };
  }
  return { ...state, current: [...state.current, entry] };
}

/** Partitions oldest-first entries into session spans by threading
 *  {@link advancePartition} across the array, then closing whatever span is
 *  still open at the end. */
function partitionIntoSpans(
  entries: readonly CoalescableHistoryEntry[],
  checkpointBoundaries: readonly CheckpointBoundary[],
  sessionWindowMs: number
): readonly SessionSpan[] {
  let state = EMPTY_PARTITION_STATE;
  let previousEntry: CoalescableHistoryEntry | undefined;
  for (const entry of entries) {
    state = advancePartition(state, entry, previousEntry, checkpointBoundaries, sessionWindowMs);
    previousEntry = entry;
  }
  return closeSpan(state).spans;
}

/** The checkpoint with the smallest `contentVersion >= sealedContentVersion`
 *  — ascending `checkpointBoundaries` makes this the first match found,
 *  independent of whether it was also the boundary that split this span from
 *  the next one. */
function findSealingCheckpointId(
  sealedContentVersion: number | null,
  checkpointBoundaries: readonly CheckpointBoundary[]
): string | null {
  if (sealedContentVersion === null) return null;
  const sealing = checkpointBoundaries.find(
    (boundary) => boundary.contentVersion >= sealedContentVersion
  );
  return sealing?.checkpointId ?? null;
}

function toSession(
  span: SessionSpan,
  checkpointBoundaries: readonly CheckpointBoundary[]
): ParagraphHistorySession {
  const first = span.entries[0];
  const last = span.entries.at(-1);
  // partitionIntoSpans never produces an empty span; a typed throw beats a
  // silent non-null assertion if that invariant is ever violated (mirrors
  // checkpoints.ts's scope-XOR safety net).
  if (!first || !last) {
    throw new Error('coalesceParagraphSessions: internal error — empty session span');
  }
  const sealedContentVersion = last.contentVersion;
  const isOpeningInsert = first.op === 'insert';
  return {
    userId: first.userId,
    firstVersion: first.version,
    lastVersion: last.version,
    beforeText: isOpeningInsert ? null : (span.precedingEntry?.text ?? null),
    beforeNodeType: isOpeningInsert ? null : (span.precedingEntry?.nodeType ?? null),
    afterText: last.text,
    afterNodeType: last.nodeType,
    startedAt: first.snapshotAt,
    endedAt: last.snapshotAt,
    sealedContentVersion,
    sealedByCheckpointId: findSealingCheckpointId(sealedContentVersion, checkpointBoundaries),
    entries: span.entries,
  };
}

/**
 * Folds oldest-first tier-0 paragraph history entries into tier-1 sessions
 * (ADR-052 D3): consecutive entries by one actor, with no intervening
 * foreign-actor entry, no gap exceeding `sessionWindowMs`, and no crossed
 * checkpoint boundary, read as one session with a net before/after diff. A
 * null-`userId` entry is always its own singleton, checked before any other
 * rule. Pure and total — never throws, never performs I/O; `[]` in, `[]` out.
 */
export function coalesceParagraphSessions(
  entries: readonly CoalescableHistoryEntry[],
  checkpointBoundaries: readonly CheckpointBoundary[],
  sessionWindowMs: number
): readonly ParagraphHistorySession[] {
  const spans = partitionIntoSpans(entries, checkpointBoundaries, sessionWindowMs);
  return spans.map((span) => toSession(span, checkpointBoundaries));
}
