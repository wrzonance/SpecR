import { describe, expect, it } from 'vitest';
import type { SpecNode, SpecTree } from '../../ast/index.js';
import { DatabaseError } from '../errors.js';
import { assertReadyForFinal, ReadinessBlockedError } from './readiness-gate.js';

function node(overrides: Partial<SpecNode> & Pick<SpecNode, 'id' | 'type' | 'text'>): SpecNode {
  return { children: [], meta: {}, ...overrides };
}

function treeOf(parts: readonly SpecNode[]): SpecTree {
  return { id: 'spec', section: '09 91 26', title: 'Painting', parts };
}

const dirtyEntry = { tree: treeOf([node({ id: 'n1', type: 'note', text: 'Confirm finish.' })]) };
const cleanEntry = { tree: treeOf([node({ id: 'n1', type: 'pr1', text: 'Provide paint.' })]) };

describe('assertReadyForFinal', () => {
  it('no-ops when mode is undefined, even against outstanding findings (INV-1)', () => {
    expect(() => assertReadyForFinal([dirtyEntry], undefined, undefined)).not.toThrow();
  });

  it('no-ops when mode is draft, even against outstanding findings (INV-1)', () => {
    expect(() => assertReadyForFinal([dirtyEntry], 'draft', undefined)).not.toThrow();
  });

  it('no-ops on final mode when overrideReadinessGate is true, regardless of findings (INV-2)', () => {
    expect(() => assertReadyForFinal([dirtyEntry], 'final', true)).not.toThrow();
  });

  it('no-ops on final mode when every tree is clean (INV-3)', () => {
    expect(() => assertReadyForFinal([cleanEntry], 'final', undefined)).not.toThrow();
    expect(() => assertReadyForFinal([cleanEntry], 'final', false)).not.toThrow();
  });

  it('throws ReadinessBlockedError carrying every outstanding finding on final mode without override (INV-4)', () => {
    expect(() => assertReadyForFinal([dirtyEntry], 'final', undefined)).toThrow(
      ReadinessBlockedError
    );

    try {
      assertReadyForFinal([dirtyEntry], 'final', undefined);
      expect.unreachable('assertReadyForFinal should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReadinessBlockedError);
      const blocked = err as ReadinessBlockedError;
      expect(blocked.message).toBe('final issuance blocked: 1 readiness finding(s) outstanding');
      expect(blocked.findings).toEqual([
        { type: 'specifier_note_present', nodeId: 'n1', text: 'Confirm finish.' },
      ]);
    }
  });

  it('flattens findings across every entry before deciding to block (INV-4)', () => {
    try {
      assertReadyForFinal([dirtyEntry, dirtyEntry], 'final', undefined);
      expect.unreachable('assertReadyForFinal should have thrown');
    } catch (err) {
      const blocked = err as ReadinessBlockedError;
      expect(blocked.findings).toHaveLength(2);
    }
  });

  it('is a DatabaseError, so existing instanceof DatabaseError guards catch it unchanged (INV-13)', () => {
    try {
      assertReadyForFinal([dirtyEntry], 'final', undefined);
      expect.unreachable('assertReadyForFinal should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DatabaseError);
    }
  });
});
