import { randomUUID } from 'node:crypto';
import type { ParagraphSnapshot } from '../ast/types.js';
import type {
  ConflictDiff,
  DiffResult,
  ExtractResult,
  ModifiedDiff,
  ParagraphDiff,
  UuidGen,
} from './types.js';

export interface DiffOptions {
  readonly uuidGen?: UuidGen | undefined;
}

interface BaseClassification {
  readonly modified: readonly ModifiedDiff[];
  readonly deleted: readonly string[];
  readonly conflicts: readonly ConflictDiff[];
}

// Per-base-paragraph rules (ADR-005):
//   missing from theirs            → deleted
//   theirs changed, ours unchanged → modified (auto-applicable)
//   theirs unchanged               → no entry (incl. ours-only: change already in DB)
//   both changed                   → conflict
function classifyBase(
  base: readonly ParagraphSnapshot[],
  oursMap: ReadonlyMap<string, string>,
  theirsMap: ReadonlyMap<string, string>
): BaseClassification {
  const modified: ModifiedDiff[] = [];
  const deleted: string[] = [];
  const conflicts: ConflictDiff[] = [];

  for (const { uuid, text: baseText } of base) {
    const theirsText = theirsMap.get(uuid);
    if (theirsText === undefined) {
      deleted.push(uuid);
      continue;
    }
    if (theirsText === baseText) continue;
    const oursText = oursMap.get(uuid) ?? baseText;
    const entry: ModifiedDiff = { uuid, base: baseText, theirs: theirsText, ours: oursText };
    if (oursText !== baseText) conflicts.push(entry);
    else modified.push(entry);
  }

  return { modified, deleted, conflicts };
}

function buildBaseUuids(base: readonly ParagraphSnapshot[]): ReadonlySet<string> {
  return new Set(base.map((s) => s.uuid));
}

function unknownUuidWarning(
  theirsControlled: ReadonlyMap<string, string>,
  baseUuids: ReadonlySet<string>
): string | undefined {
  const count = [...theirsControlled.keys()].filter((uuid) => !baseUuids.has(uuid)).length;
  return count > 0
    ? `${count} controlled paragraph(s) in the returned DOCX carry unknown UUIDs and were ignored`
    : undefined;
}

/**
 * Pure git-style 3-way diff (ADR-005): base = snapshot at generation time,
 * ours = current DB state, theirs = returned DOCX (extracted). Deterministic
 * given inputs + injected uuidGen; no I/O.
 *
 * Output order: deleted/modified/conflicts follow `base` order; added follows
 * `theirs.orphans` order; warnings are deterministic (unknown-uuid first, then
 * track-changes).
 */
export function computeDiff(
  base: readonly ParagraphSnapshot[],
  ours: readonly ParagraphSnapshot[],
  theirs: ExtractResult,
  opts: DiffOptions = {}
): DiffResult {
  const uuidGen = opts.uuidGen ?? randomUUID;
  const oursMap = new Map(ours.map((s) => [s.uuid, s.text]));
  const baseUuids = buildBaseUuids(base);

  const { modified, deleted, conflicts } = classifyBase(base, oursMap, theirs.controlled);

  const added: readonly ParagraphDiff[] = theirs.orphans.map((o) => ({
    uuid: uuidGen(),
    text: o.text,
    index: o.index,
  }));

  const warnings: string[] = [];
  const unknownWarn = unknownUuidWarning(theirs.controlled, baseUuids);
  if (unknownWarn !== undefined) warnings.push(unknownWarn);
  if (theirs.trackChanges.present) {
    warnings.push(
      `document contained ${theirs.trackChanges.records.length} track-change records — diff treats them as accepted`
    );
  }

  return { added, modified, deleted, conflicts, warnings };
}
