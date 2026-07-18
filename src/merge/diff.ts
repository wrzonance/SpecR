import { randomUUID } from 'node:crypto';
import type { ParagraphSnapshot } from '../ast/types.js';
import type { ObjectStructuralSnapshot } from '../db/index.js';
import { fingerprintBlob, fingerprintsDiverge } from './object-fingerprint.js';
import type {
  ConflictDiff,
  DiffResult,
  ExtractedObjectBlock,
  ExtractResult,
  ModifiedDiff,
  ObjectConflictDiff,
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
// `excludedUuids` (#520) skips a base row entirely: a body-level object's own
// uuid (it carries no theirs anchor of its own, so it would otherwise read as
// an unconditional delete) and any child anchor already covered by a detected
// ObjectConflictDiff — see detectObjectConflicts/buildExcludedUuids below.
function classifyBase(
  base: readonly ParagraphSnapshot[],
  oursMap: ReadonlyMap<string, string>,
  theirsMap: ReadonlyMap<string, string>,
  excludedUuids: ReadonlySet<string>
): BaseClassification {
  const modified: ModifiedDiff[] = [];
  const deleted: string[] = [];
  const conflicts: ConflictDiff[] = [];

  for (const { uuid, text: baseText } of base) {
    if (excludedUuids.has(uuid)) continue;
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
 * The theirs object block sharing at least one interior anchor uuid with a
 * base-side snapshot's `childUuids` (#520) — objects have no uuid of their
 * own in the DOCX (only their interior paragraphs are `w:sdt`-anchored), so
 * pairing goes through the child-uuid sets rather than a shared id. A
 * childless snapshot, or one whose children are ALL absent from every theirs
 * block, has no match: its diff falls through to ordinary per-child
 * paragraph classification instead of a whole-object signal.
 */
function findMatchingBlock(
  childUuids: readonly string[],
  blocks: readonly ExtractedObjectBlock[]
): ExtractedObjectBlock | undefined {
  if (childUuids.length === 0) return undefined;
  const childUuidSet = new Set(childUuids);
  return blocks.find((block) => block.interiorUuids.some((uuid) => childUuidSet.has(uuid)));
}

/**
 * Structural-conflict detection for body-level objects (#520): pairs each
 * base-side snapshot to its matching theirs block (findMatchingBlock), then
 * compares text-blind fingerprints (object-fingerprint.ts). A structural
 * divergence is reported as ONE atomic conflict; classifyBase excludes its
 * `affectedUuids` from every other bucket so the same edit never also surfaces
 * as noisy per-child deletes/modifications.
 */
function detectObjectConflicts(
  snapshots: readonly ObjectStructuralSnapshot[],
  theirsBlocks: readonly ExtractedObjectBlock[]
): readonly ObjectConflictDiff[] {
  const conflicts: ObjectConflictDiff[] = [];
  for (const snapshot of snapshots) {
    const block = findMatchingBlock(snapshot.childUuids, theirsBlocks);
    if (block === undefined) continue;
    const base = fingerprintBlob(snapshot.meta.blob);
    if (!fingerprintsDiverge(base, block.fingerprint)) continue;
    conflicts.push({
      objectId: snapshot.objectId,
      affectedUuids: snapshot.childUuids,
      base,
      theirs: block.fingerprint,
    });
  }
  return conflicts;
}

/**
 * Every uuid classifyBase must skip outright (#520): each object row's own
 * uuid — unconditionally, since it carries no theirs anchor of its own and
 * would otherwise always read as deleted — plus the affected child uuids of
 * any detected structural conflict. A matched-but-non-diverging object's
 * children are deliberately NOT added here: their per-cell text edits still
 * flow through classifyBase normally.
 */
function buildExcludedUuids(
  snapshots: readonly ObjectStructuralSnapshot[],
  objectConflicts: readonly ObjectConflictDiff[]
): ReadonlySet<string> {
  const excluded = new Set<string>();
  for (const snapshot of snapshots) excluded.add(snapshot.objectId);
  for (const conflict of objectConflicts) {
    for (const uuid of conflict.affectedUuids) excluded.add(uuid);
  }
  return excluded;
}

/**
 * Pure git-style 3-way diff (ADR-005): base = snapshot at generation time,
 * ours = current DB state, theirs = returned DOCX (extracted). Deterministic
 * given inputs + injected uuidGen; no I/O.
 *
 * `objectSnapshots` (#520) is the base-side structural snapshot of every
 * body-level object (`src/db/queries/object-structure.ts`), paired against
 * `theirs.objectBlocks` to detect atomic structural conflicts and to exclude
 * an object's own uuid — and, when conflicting, its affected children — from
 * the ordinary per-paragraph buckets below.
 *
 * Output order: deleted/modified/conflicts follow `base` order; added follows
 * `theirs.orphans` order; objectConflicts follows `objectSnapshots` order;
 * warnings are deterministic (unknown-uuid first, then track-changes).
 */
export function computeDiff(
  base: readonly ParagraphSnapshot[],
  ours: readonly ParagraphSnapshot[],
  theirs: ExtractResult,
  objectSnapshots: readonly ObjectStructuralSnapshot[],
  opts: DiffOptions = {}
): DiffResult {
  const uuidGen = opts.uuidGen ?? randomUUID;
  const oursMap = new Map(ours.map((s) => [s.uuid, s.text]));
  const baseUuids = buildBaseUuids(base);

  const objectConflicts = detectObjectConflicts(objectSnapshots, theirs.objectBlocks);
  const excludedUuids = buildExcludedUuids(objectSnapshots, objectConflicts);
  const { modified, deleted, conflicts } = classifyBase(
    base,
    oursMap,
    theirs.controlled,
    excludedUuids
  );

  const added: readonly ParagraphDiff[] = theirs.orphans.map((o) => ({
    uuid: uuidGen(),
    text: o.text,
    index: o.index,
    afterUuid: o.afterUuid,
  }));

  const warnings: string[] = [];
  const unknownWarn = unknownUuidWarning(theirs.controlled, baseUuids);
  if (unknownWarn !== undefined) warnings.push(unknownWarn);
  if (theirs.trackChanges.present) {
    const count = theirs.trackChanges.records.length;
    const phrase = count === 1 ? 'record — diff treats it' : 'records — diff treats them';
    warnings.push(`document contained ${count} track-change ${phrase} as accepted`);
  }

  return { added, modified, deleted, conflicts, objectConflicts, warnings };
}
