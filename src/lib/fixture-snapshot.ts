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
