// src/lib/fixture-snapshot.ts (partial — record builder)
import { renderMarkdown } from '../generator/markdown.js';
import { containsSpecifierNoteBanner } from './specifier-note-banner.js';
import type { SpecTree, SecRef, SpecNode } from '../ast/types.js';

export interface FixtureRecord {
  readonly parts: number;
  readonly noteLeaks: number;
  readonly refs: readonly string[];
  readonly render: string;
  readonly error?: string;
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

export function fixtureRecord(tree: SpecTree, refs: readonly SecRef[]): FixtureRecord {
  const render = renderMarkdown(tree);
  const parts = tree.parts.filter(
    (n: SpecNode) => n.type === 'part' && n.meta.vanish !== true
  ).length;
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
  readonly refsAdded: readonly string[];
  readonly refsRemoved: readonly string[];
  readonly linesAdded: readonly string[];
  readonly linesRemoved: readonly string[];
}

export interface DiffResult {
  readonly changed: readonly FixtureDelta[];
  readonly total: number;
}

function diffLists(
  before: readonly string[],
  after: readonly string[]
): {
  added: string[];
  removed: string[];
} {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x)),
  };
}

function delta(path: string, before: FixtureRecord, after: FixtureRecord): FixtureDelta | null {
  const refs = diffLists(before.refs, after.refs);
  const lines = diffLists(before.render.split('\n'), after.render.split('\n'));
  const changed =
    before.parts !== after.parts ||
    before.noteLeaks !== after.noteLeaks ||
    refs.added.length + refs.removed.length + lines.added.length + lines.removed.length > 0 ||
    before.error !== after.error;
  if (!changed) return null;
  return {
    path,
    ...(before.parts !== after.parts ? { parts: [before.parts, after.parts] as const } : {}),
    ...(before.noteLeaks !== after.noteLeaks
      ? { noteLeaks: [before.noteLeaks, after.noteLeaks] as const }
      : {}),
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

export async function readSnapshot(path: string): Promise<Snapshot> {
  return JSON.parse(await readFile(path, 'utf8')) as Snapshot;
}
