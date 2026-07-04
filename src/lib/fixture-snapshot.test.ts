// src/lib/fixture-snapshot.test.ts
import { describe, it, expect } from 'vitest';
import { fixtureRecord } from './fixture-snapshot.js';
import type { SpecTree, SecRef } from '../ast/types.js';

function leaf(type: string, text: string): Record<string, unknown> {
  return { id: type, type, text, children: [], meta: {} };
}

describe('fixtureRecord', () => {
  it('counts visible parts, note leaks, and sorts refs', () => {
    // A part whose body has a banner leaking as content (not a > **[NOTE]** line).
    const tree = {
      id: 't',
      section: '01 88 13',
      title: 'T',
      parts: [
        {
          ...leaf('part', 'GENERAL'),
          children: [leaf('continuation', 'Display hidden notes to specifier.')],
        },
        leaf('part', 'PRODUCTS'),
        leaf('part', 'EXECUTION'),
      ],
    } as unknown as SpecTree;
    const refs = [
      {
        sourceNodeId: 'a',
        targetType: 'section',
        targetSpecSection: '09 91 00',
        referenceText: 'x',
      },
      { sourceNodeId: 'b', targetType: 'standard', standardCode: 'ASTM A992', referenceText: 'y' },
    ] as unknown as SecRef[];

    const rec = fixtureRecord(tree, refs);
    expect(rec.parts).toBe(3);
    expect(rec.noteLeaks).toBe(1); // the leaked banner line
    expect(rec.refs).toEqual(['sec:09 91 00', 'std:ASTM A992']); // sorted, tagged
    expect(rec.render).toContain('Display hidden notes to specifier');
  });

  it('does NOT count a banner inside a proper [NOTE] line as a leak', () => {
    const tree = {
      id: 't',
      section: '01 00 00',
      title: 'T',
      parts: [
        {
          ...leaf('part', 'GENERAL'),
          children: [leaf('note', '** NOTE TO SPECIFIER ** delete if not required')],
        },
        leaf('part', 'PRODUCTS'),
        leaf('part', 'EXECUTION'),
      ],
    } as unknown as SpecTree;
    const rec = fixtureRecord(tree, []);
    expect(rec.noteLeaks).toBe(0); // renders as `> **[NOTE]** …`, excluded
  });
});

import { diffSnapshots } from './fixture-snapshot.js';
import type { Snapshot } from './fixture-snapshot.js';

describe('diffSnapshots', () => {
  const base: Snapshot = {
    'A.docx': {
      parts: 3,
      noteLeaks: 1,
      refs: ['sec:09 91 00'],
      render: 'x\nDisplay hidden notes to specifier.\ny',
    },
    'B.docx': { parts: 3, noteLeaks: 0, refs: [], render: 'same' },
  };

  it('reports only changed fixtures with parts/noteLeaks/refs/line deltas', () => {
    const after: Snapshot = {
      'A.docx': {
        parts: 3,
        noteLeaks: 0,
        refs: ['sec:09 91 00'],
        render: 'x\n> **[NOTE]** Display hidden notes to specifier.\ny',
      },
      'B.docx': base['B.docx']!, // unchanged
    };
    const d = diffSnapshots(base, after);
    expect(d.total).toBe(2);
    expect(d.changed).toHaveLength(1);
    const a = d.changed[0]!;
    expect(a.path).toBe('A.docx');
    expect(a.noteLeaks).toEqual([1, 0]);
    expect(a.parts).toBeUndefined(); // unchanged fields omitted
    expect(a.linesRemoved).toContain('Display hidden notes to specifier.');
    expect(a.linesAdded).toContain('> **[NOTE]** Display hidden notes to specifier.');
  });

  it('flags fixtures present on only one side', () => {
    const after: Snapshot = { 'A.docx': base['A.docx']! }; // B removed
    const d = diffSnapshots(base, after);
    expect(d.changed.find((c) => c.path === 'B.docx')?.presence).toBe('only-before');
  });
});
