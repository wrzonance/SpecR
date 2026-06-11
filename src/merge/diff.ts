import { randomUUID } from 'node:crypto';
import type { ParagraphSnapshot } from '../ast/types.js';
import type { DiffResult, ExtractResult, ModifiedDiff, ParagraphDiff, UuidGen } from './types.js';

export interface DiffOptions {
  readonly uuidGen?: UuidGen | undefined;
}

interface BaseClassification {
  readonly modified: readonly ModifiedDiff[];
  readonly deleted: readonly string[];
  readonly conflicts: readonly ModifiedDiff[];
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
  const conflicts: ModifiedDiff[] = [];

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

/**
 * Pure git-style 3-way diff (ADR-005): base = snapshot at generation time,
 * ours = current DB state, theirs = returned DOCX (extracted). Deterministic
 * given inputs + injected uuidGen; no I/O.
 */
export function computeDiff(
  base: readonly ParagraphSnapshot[],
  ours: readonly ParagraphSnapshot[],
  theirs: ExtractResult,
  opts: DiffOptions = {}
): DiffResult {
  const uuidGen = opts.uuidGen ?? randomUUID;
  const oursMap = new Map(ours.map((s) => [s.uuid, s.text]));

  const { modified, deleted, conflicts } = classifyBase(base, oursMap, theirs.controlled);

  const added: readonly ParagraphDiff[] = theirs.orphans.map((o) => ({
    uuid: uuidGen(),
    text: o.text,
    index: o.index,
  }));

  const warnings = theirs.trackChanges.present
    ? [
        `document contained ${theirs.trackChanges.records.length} track-change records — diff treats them as accepted`,
      ]
    : [];

  return { added, modified, deleted, conflicts, warnings };
}
