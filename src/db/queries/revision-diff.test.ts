// src/db/queries/revision-diff.test.ts
//
// Pure unit tests for changedRevisionSpecs' derived-meta stripping — no DB
// (RevisionSpecEntry is a type-only import in revision-diff.ts, so this file
// never touches pg). Regression coverage for a #392/ADR-078 Codex finding:
// originParagraphId (embedded only at freeze time, revision-snapshot.ts) is
// captured provenance, not authored content, and must be stripped from the
// fingerprint exactly like articleRole already is — or a spec frozen before
// #392 shipped (never had the field) reads as "changed" against an otherwise
// byte-identical post-#392 refreeze, falsely padding the addendum.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { changedRevisionSpecs } from './revision-diff.js';
import type { RevisionSpecEntry } from './revision-snapshot.js';
import type { SpecNode, SpecTree } from '../../ast/index.js';

function node(over: Partial<SpecNode> & Pick<SpecNode, 'id' | 'type' | 'text'>): SpecNode {
  return { children: [], meta: {}, ...over };
}

function entry(specId: string, root: SpecNode): RevisionSpecEntry {
  const tree: SpecTree = { id: specId, section: '01 00 00', title: 'T', parts: [root] };
  return { specId, position: 0, tree };
}

describe('changedRevisionSpecs — derived-meta stripping (#392, ADR-078)', () => {
  it('originParagraphId alone does not mark an otherwise-identical spec as changed', () => {
    const specId = randomUUID();
    const paraId = randomUUID();
    const masterParaId = randomUUID();

    // base = frozen before #392 shipped: no originParagraphId anywhere.
    const base = [entry(specId, node({ id: paraId, type: 'part', text: 'GENERAL' }))];
    // target = an unedited refreeze after #392 shipped: same content, now
    // carrying the embedded lineage field (revision-snapshot.ts's embedOriginIds).
    const target = [
      entry(
        specId,
        node({
          id: paraId,
          type: 'part',
          text: 'GENERAL',
          meta: { originParagraphId: masterParaId },
        })
      ),
    ];

    expect(changedRevisionSpecs(target, base)).toEqual([]);
  });

  it('still detects a genuine text change alongside a new originParagraphId', () => {
    const specId = randomUUID();
    const paraId = randomUUID();
    const masterParaId = randomUUID();

    const base = [entry(specId, node({ id: paraId, type: 'part', text: 'GENERAL' }))];
    const target = [
      entry(
        specId,
        node({
          id: paraId,
          type: 'part',
          text: 'EDITED GENERAL',
          meta: { originParagraphId: masterParaId },
        })
      ),
    ];

    expect(changedRevisionSpecs(target, base)).toEqual(target);
  });

  it('articleRole alone still does not mark an otherwise-identical spec as changed (pre-existing guard)', () => {
    const specId = randomUUID();
    const paraId = randomUUID();

    const base = [entry(specId, node({ id: paraId, type: 'article', text: 'REFERENCES' }))];
    const target = [
      entry(
        specId,
        node({
          id: paraId,
          type: 'article',
          text: 'REFERENCES',
          meta: { articleRole: 'references' },
        })
      ),
    ];

    expect(changedRevisionSpecs(target, base)).toEqual([]);
  });
});
