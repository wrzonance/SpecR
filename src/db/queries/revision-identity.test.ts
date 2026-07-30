import { describe, it, expect } from 'vitest';
import { createRevisionIdentityDraft } from './revision-identity.js';
import type { RevisionNomenclatureProfile } from './revision-nomenclature.js';

// ADR-079 (#406): `mode`/`overrideReadinessGate` are transient inputs to the
// issuance-readiness gate only — no new DB table or column stores them
// (INV-11). This pins that guarantee at the one place in this task's scope
// that touches `CreatePackageRevisionInput`: `createRevisionIdentityDraft`
// must produce byte-identical output whether or not a caller supplies
// either field, since neither is read on the way to persisted revision
// identity.

const PROFILE: RevisionNomenclatureProfile = {
  id: '11111111-1111-4111-8111-111111111111',
  projectId: null,
  name: 'Test Nomenclature',
  types: [{ key: 'addendum', name: 'Addendum' }],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('createRevisionIdentityDraft — mode / overrideReadinessGate are transient (INV-11)', () => {
  it('produces an identical draft whether or not mode/overrideReadinessGate are supplied', () => {
    const withoutGateFields = createRevisionIdentityDraft(
      { type: 'addendum', date: '2026-01-15' },
      PROFILE
    );
    const withGateFields = createRevisionIdentityDraft(
      { type: 'addendum', date: '2026-01-15', mode: 'final', overrideReadinessGate: true },
      PROFILE
    );
    expect(withGateFields).toEqual(withoutGateFields);
  });

  it('never carries mode or overrideReadinessGate onto the resulting draft', () => {
    const draft = createRevisionIdentityDraft(
      { type: 'addendum', date: '2026-01-15', mode: 'final', overrideReadinessGate: true },
      PROFILE
    );
    expect(draft).not.toHaveProperty('mode');
    expect(draft).not.toHaveProperty('overrideReadinessGate');
  });
});
