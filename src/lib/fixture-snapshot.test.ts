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
