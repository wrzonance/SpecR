// src/lib/fixture-snapshot.ts (partial — record builder)
import * as z from 'zod';
import { renderMarkdown } from '../generator/markdown.js';
import { containsSpecifierNoteBanner } from './specifier-note-banner.js';
import { SpecrError } from './errors.js';
import type { SpecTree, SecRef, SpecNode } from '../ast/types.js';

export interface FixtureRecord {
  readonly parts: number;
  readonly noteLeaks: number;
  readonly refs: readonly string[];
  readonly render: string;
  // string | undefined (not just optional): a snapshot read back from disk is
  // Zod-validated, and z.string().optional() admits an explicit undefined.
  readonly error?: string | undefined;
}

export type Snapshot = Record<string, FixtureRecord>;

const NOTE_LINE_PREFIX = '> **[NOTE]**';

function countNoteLeaks(render: string): number {
  return render
    .split('\n')
    .filter(
      (line) => containsSpecifierNoteBanner(line) && !line.trimStart().startsWith(NOTE_LINE_PREFIX)
    ).length;
}

function refKey(ref: SecRef): string {
  return ref.targetType === 'section' ? `sec:${ref.targetSpecSection}` : `std:${ref.standardCode}`;
}

// Visible (non-vanish) part-type roots — the single source of truth for "how many
// parts". gold-fingerprint's partShape reuses this so its `parts` and `partShape.length`
// can never disagree with `fixtureRecord`'s count.
export function visibleParts(tree: SpecTree): SpecNode[] {
  return tree.parts.filter((n: SpecNode) => n.type === 'part' && n.meta.vanish !== true);
}

export function fixtureRecord(tree: SpecTree, refs: readonly SecRef[]): FixtureRecord {
  const render = renderMarkdown(tree);
  const parts = visibleParts(tree).length;
  return {
    parts,
    noteLeaks: countNoteLeaks(render),
    refs: refs.map(refKey).sort((a, b) => a.localeCompare(b)),
    render,
  };
}

export interface FixtureDelta {
  readonly path: string;
  readonly presence?: 'only-before' | 'only-after';
  readonly parts?: readonly [number, number];
  readonly noteLeaks?: readonly [number, number];
  readonly error?: readonly [string | undefined, string | undefined];
  readonly refsAdded: readonly string[];
  readonly refsRemoved: readonly string[];
  readonly linesAdded: readonly string[];
  readonly linesRemoved: readonly string[];
}

export interface DiffResult {
  readonly changed: readonly FixtureDelta[];
  readonly total: number;
}

function countBy(items: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const x of items) counts.set(x, (counts.get(x) ?? 0) + 1);
  return counts;
}

// Multiset difference: a line added/removed N times surfaces N times, even when
// it still appears elsewhere. A plain Set diff misses duplicate-occurrence changes
// (and pure reorders — those are caught by the direct render compare in delta()).
function diffLists(
  before: readonly string[],
  after: readonly string[]
): {
  added: string[];
  removed: string[];
} {
  const b = countBy(before);
  const a = countBy(after);
  const surplus = (from: Map<string, number>, other: Map<string, number>): string[] => {
    const out: string[] = [];
    for (const [x, n] of from) for (let i = 0; i < n - (other.get(x) ?? 0); i++) out.push(x);
    return out;
  };
  return { added: surplus(a, b), removed: surplus(b, a) };
}

function delta(path: string, before: FixtureRecord, after: FixtureRecord): FixtureDelta | null {
  const refs = diffLists(before.refs, after.refs);
  const lines = diffLists(before.render.split('\n'), after.render.split('\n'));
  const changed =
    before.parts !== after.parts ||
    before.noteLeaks !== after.noteLeaks ||
    before.render !== after.render || // direct compare catches reorders a line diff can't
    refs.added.length + refs.removed.length > 0 ||
    before.error !== after.error;
  if (!changed) return null;
  return {
    path,
    ...(before.parts !== after.parts ? { parts: [before.parts, after.parts] as const } : {}),
    ...(before.noteLeaks !== after.noteLeaks
      ? { noteLeaks: [before.noteLeaks, after.noteLeaks] as const }
      : {}),
    ...(before.error !== after.error ? { error: [before.error, after.error] as const } : {}),
    refsAdded: refs.added,
    refsRemoved: refs.removed,
    linesAdded: lines.added,
    linesRemoved: lines.removed,
  };
}

function presenceDelta(path: string, presence: 'only-before' | 'only-after'): FixtureDelta {
  return { path, presence, refsAdded: [], refsRemoved: [], linesAdded: [], linesRemoved: [] };
}

function pathDelta(
  path: string,
  before: FixtureRecord | undefined,
  after: FixtureRecord | undefined
): FixtureDelta | null {
  if (before && !after) return presenceDelta(path, 'only-before');
  if (!before && after) return presenceDelta(path, 'only-after');
  if (before && after) return delta(path, before, after);
  return null;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): DiffResult {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort((a, b) =>
    a.localeCompare(b)
  );
  const changed: FixtureDelta[] = [];
  for (const path of paths) {
    const d = pathDelta(path, before[path], after[path]);
    if (d) changed.push(d);
  }
  return { changed, total: paths.length };
}

import { readFile, writeFile, mkdir, glob } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '../parser/index.js';

const PROJECT_ROOT = process.cwd();

export async function snapshotCorpus(refDir = 'docs/references'): Promise<Snapshot> {
  const snapshot: Snapshot = {};
  for await (const rel of glob(`${refDir}/**/*.{docx,sec,SEC}`, { cwd: PROJECT_ROOT })) {
    const abs = join(PROJECT_ROOT, rel);
    try {
      const { tree, refs } = await parse(await readFile(abs), abs);
      snapshot[rel] = fixtureRecord(tree, refs);
    } catch (err) {
      snapshot[rel] = {
        parts: -1,
        noteLeaks: -1,
        refs: [],
        render: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return snapshot;
}

export async function writeSnapshot(
  snapshot: Snapshot,
  outDir: string,
  label: string
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, `${label}.json`);
  await writeFile(path, JSON.stringify(snapshot));
  return path;
}

// A snapshot is read back from disk (external, possibly stale/hand-edited) before
// diffing, so validate its shape at the boundary rather than trusting a bare
// `as Snapshot` assertion — a corrupt render/parts field must fail loud here, not
// silently corrupt diffSnapshots downstream.
const FixtureRecordSchema = z.object({
  parts: z.number(),
  noteLeaks: z.number(),
  refs: z.array(z.string()),
  render: z.string(),
  error: z.string().optional(),
});
const SnapshotSchema: z.ZodType<Snapshot> = z.record(z.string(), FixtureRecordSchema);

export async function readSnapshot(path: string): Promise<Snapshot> {
  const parsed = SnapshotSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
  if (!parsed.success) {
    throw new SpecrError(`invalid snapshot file: ${path}`, { cause: parsed.error });
  }
  return parsed.data;
}
