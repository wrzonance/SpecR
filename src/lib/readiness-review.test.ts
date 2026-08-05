import { describe, expect, it } from 'vitest';
import { SpecTreeSchema, type SpecNode, type SpecTree } from '../ast/index.js';
import {
  evaluateSpecReadiness,
  summarizeReadinessFindings,
  type ReadinessFinding,
} from './readiness-review.js';

function node(overrides: Partial<SpecNode> & Pick<SpecNode, 'id' | 'type' | 'text'>): SpecNode {
  return { children: [], meta: {}, ...overrides };
}

function treeOf(parts: readonly SpecNode[]): SpecTree {
  return { id: 'spec', section: '09 91 26', title: 'Painting', parts };
}

describe('evaluateSpecReadiness', () => {
  it('flags a note node regardless of meta.vanish (INV-5/6: note-always-flags)', () => {
    const vanished = node({
      id: 'n1',
      type: 'note',
      text: 'Coordinate with owner.',
      meta: { vanish: true },
    });
    const visible = node({ id: 'n2', type: 'note', text: 'Confirm finish.', meta: {} });

    const result = evaluateSpecReadiness(treeOf([vanished, visible]));

    expect(result.findings).toEqual([
      { type: 'specifier_note_present', nodeId: 'n1', text: 'Coordinate with owner.' },
      { type: 'specifier_note_present', nodeId: 'n2', text: 'Confirm finish.' },
    ]);
  });

  it('suppresses choice-token, comment, and body-object findings on a vanished ordinary node (INV-6)', () => {
    const vanished = node({
      id: 'p1',
      type: 'pr1',
      text: 'Provide <manufacturer>.',
      meta: {
        vanish: true,
        sourceFacts: {
          choiceTokens: [{ kind: 'angle', options: ['A', 'B'], span: [8, 22] }],
          comments: [{ author: 'Jane', text: 'pick one', anchor: [0, 5], closed: false }],
        },
      },
    });
    const vanishedObject = node({
      id: 'o1',
      type: 'object',
      text: '',
      meta: {
        vanish: true,
        object: { kind: 'textBox', floating: false, generation: 'drawingml', blob: [{}] },
      },
    });

    const result = evaluateSpecReadiness(treeOf([vanished, vanishedObject]));

    expect(result.findings).toEqual([]);
  });

  it('blocks on a text-box body object but never on a table (INV-7)', () => {
    const textBox = node({
      id: 'o1',
      type: 'object',
      text: '',
      meta: { object: { kind: 'textBox', floating: false, generation: 'drawingml', blob: [{}] } },
    });
    const table = node({
      id: 'o2',
      type: 'object',
      text: '',
      meta: { object: { kind: 'table', floating: false, generation: 'drawingml', blob: [{}] } },
    });

    const result = evaluateSpecReadiness(treeOf([textBox, table]));

    expect(result.findings).toEqual([
      { type: 'body_object_present', nodeId: 'o1', text: '', objectKind: 'textBox' },
    ]);
  });

  it('flags only open comments, never closed ones', () => {
    const withComments = node({
      id: 'p1',
      type: 'pr1',
      text: 'Verify substrate.',
      meta: {
        sourceFacts: {
          comments: [
            { author: 'Jane', text: 'still open', anchor: [0, 5], closed: false },
            { author: 'Sam', text: 'resolved', anchor: [6, 10], closed: true },
          ],
        },
      },
    });

    const result = evaluateSpecReadiness(treeOf([withComments]));

    expect(result.findings).toEqual([
      { type: 'open_comment', nodeId: 'p1', text: 'Verify substrate.', author: 'Jane' },
    ]);
  });

  it('never consults the highlight advisory when computing findings (INV-8)', () => {
    const highlighted = node({
      id: 'p1',
      type: 'pr1',
      text: 'Select finish.',
      meta: { sourceFacts: { highlights: [{ color: 'yellow', text: 'finish', span: [7, 13] }] } },
    });

    const result = evaluateSpecReadiness(treeOf([highlighted]));

    expect(result.findings).toEqual([]);
    expect(result.highlightAdvisory.total).toBe(1);
  });

  it("suppresses findings for an entire vanished subtree, including a nested note (regression: walkReadiness recursed into a vanished node's children)", () => {
    const nestedNote = node({ id: 'c1', type: 'note', text: 'Nested under hidden parent.' });
    const nestedChoice = node({
      id: 'c2',
      type: 'pr1',
      text: 'Provide <manufacturer>.',
      meta: {
        sourceFacts: {
          choiceTokens: [{ kind: 'angle', options: ['A', 'B'], span: [8, 22] }],
        },
      },
    });
    const vanishedParent = node({
      id: 'p1',
      type: 'article',
      text: 'HIDDEN ARTICLE',
      meta: { vanish: true },
      children: [nestedNote, nestedChoice],
    });

    const result = evaluateSpecReadiness(treeOf([vanishedParent]));

    // No renderer (DOCX/Markdown/.SEC) emits a single byte of a vanished
    // node's subtree, so nothing beneath it — not even a note — can block
    // an issuance the reader will never see (ADR-079 decision 5).
    expect(result.findings).toEqual([]);
  });

  it('walks nested children', () => {
    const child = node({ id: 'c1', type: 'note', text: 'Nested note.' });
    const parent = node({ id: 'p1', type: 'article', text: 'REFERENCES', children: [child] });

    const result = evaluateSpecReadiness(treeOf([parent]));

    expect(result.findings).toEqual([
      { type: 'specifier_note_present', nodeId: 'c1', text: 'Nested note.' },
    ]);
  });

  it('returns zero findings for an empty tree', () => {
    const result = evaluateSpecReadiness(treeOf([]));

    expect(result.findings).toEqual([]);
    expect(result.highlightAdvisory.total).toBe(0);
  });

  it('acknowledged note produces no specifier_note_present finding (#545)', () => {
    const acknowledged = node({
      id: 'n1',
      type: 'note',
      text: 'Coordinate with owner.',
      meta: { acknowledged: true },
    });

    const result = evaluateSpecReadiness(treeOf([acknowledged]));

    expect(result.findings).toEqual([]);
  });

  // Regression (#545, adversarial review): acknowledgement was lost at the
  // SpecTree validation boundary. `validateTree` (revision-snapshot.ts)
  // parses through SpecTreeSchema on the package-issuance and
  // revision-freeze paths, and SpecNodeMetaSchema had no `acknowledged`
  // key — so z.object stripped it and every cleared finding came back.
  // Asserts the CLEARED state survives the round-trip, not just the key.
  it('readiness: acknowledgement survives a SpecTreeSchema round-trip (#545)', () => {
    const tree = treeOf([
      node({ id: 'n1', type: 'note', text: 'Coordinate.', meta: { acknowledged: true } }),
      node({
        id: 'o1',
        type: 'object',
        text: 'Callout',
        meta: {
          acknowledged: true,
          object: {
            kind: 'textBox',
            floating: false,
            generation: 'drawingml',
            blob: [{ 'w:p': [{ 'w:r': [] }] }],
          },
        },
      }),
    ]);

    expect(evaluateSpecReadiness(tree).findings).toEqual([]);

    const roundTripped = SpecTreeSchema.parse({
      ...tree,
      id: '11111111-1111-4111-8111-111111111111',
      parts: tree.parts.map((p, i) => ({
        ...p,
        id: `2222222${i}-2222-4222-8222-222222222222`,
      })),
    });

    expect(roundTripped.parts[0]?.meta.acknowledged).toBe(true);
    expect(evaluateSpecReadiness(roundTripped).findings).toEqual([]);
  });

  // Regression (#545, adversarial review): acknowledging a note used to
  // return a bare `[]`, so an open comment or unresolved choice token
  // carried ON the note became invisible to the gate. Pre-#545 the note
  // itself always blocked, so those facts never needed their own guard —
  // acknowledgement introduced the bypass. Acknowledgement clears ONLY
  // specifier_note_present; every other finding kind keeps its own
  // supported clearing path (comment closure / text edit).
  it('readiness: acknowledged note still reports its OWN open_comment — ack is not a blanket bypass (#545)', () => {
    const acknowledgedWithComment = node({
      id: 'n1',
      type: 'note',
      text: 'Coordinate with owner.',
      meta: {
        acknowledged: true,
        sourceFacts: {
          comments: [{ author: 'Jane', text: 'which primer?', anchor: [0, 5], closed: false }],
        },
      },
    });

    const result = evaluateSpecReadiness(treeOf([acknowledgedWithComment]));

    expect(result.findings).toEqual([
      { type: 'open_comment', nodeId: 'n1', text: 'Coordinate with owner.', author: 'Jane' },
    ]);
  });

  it('readiness: acknowledged note still reports its OWN unresolved_choice_token (#545)', () => {
    const acknowledgedWithToken = node({
      id: 'n1',
      type: 'note',
      text: 'Use [insert product] here.',
      meta: {
        acknowledged: true,
        sourceFacts: {
          choiceTokens: [{ kind: 'bracket', options: ['insert product'], span: [4, 20] }],
        },
      },
    });

    const result = evaluateSpecReadiness(treeOf([acknowledgedWithToken]));

    expect(result.findings).toEqual([
      {
        type: 'unresolved_choice_token',
        nodeId: 'n1',
        text: 'Use [insert product] here.',
        kind: 'bracket',
        options: ['insert product'],
      },
    ]);
  });

  it('unacknowledged note still blocks — acknowledgement gate is not vacuous (#545)', () => {
    const unacknowledged = node({
      id: 'n1',
      type: 'note',
      text: 'Coordinate with owner.',
      meta: {},
    });

    const result = evaluateSpecReadiness(treeOf([unacknowledged]));

    expect(result.findings).toEqual([
      { type: 'specifier_note_present', nodeId: 'n1', text: 'Coordinate with owner.' },
    ]);
  });

  it('acknowledged textBox object produces no body_object_present finding (#545)', () => {
    const acknowledged = node({
      id: 'o1',
      type: 'object',
      text: '',
      meta: {
        acknowledged: true,
        object: { kind: 'textBox', floating: false, generation: 'drawingml', blob: [{}] },
      },
    });

    const result = evaluateSpecReadiness(treeOf([acknowledged]));

    expect(result.findings).toEqual([]);
  });

  it('unacknowledged textBox object still blocks — acknowledgement gate is not vacuous (#545)', () => {
    const unacknowledged = node({
      id: 'o1',
      type: 'object',
      text: '',
      meta: {
        object: { kind: 'textBox', floating: false, generation: 'drawingml', blob: [{}] },
      },
    });

    const result = evaluateSpecReadiness(treeOf([unacknowledged]));

    expect(result.findings).toEqual([
      { type: 'body_object_present', nodeId: 'o1', text: '', objectKind: 'textBox' },
    ]);
  });

  it('meta.acknowledged on a non-note/object node is simply irrelevant, never a magic bypass', () => {
    const acknowledgedButOrdinary = node({
      id: 'p1',
      type: 'pr1',
      text: 'Provide <manufacturer>.',
      meta: {
        acknowledged: true,
        sourceFacts: { choiceTokens: [{ kind: 'angle', options: ['A', 'B'], span: [8, 22] }] },
      },
    });

    const result = evaluateSpecReadiness(treeOf([acknowledgedButOrdinary]));

    expect(result.findings).toEqual([
      {
        type: 'unresolved_choice_token',
        nodeId: 'p1',
        text: 'Provide <manufacturer>.',
        kind: 'angle',
        options: ['A', 'B'],
      },
    ]);
  });
});

describe('summarizeReadinessFindings', () => {
  it('counts each finding kind and excludes the highlight advisory from total (INV-9)', () => {
    const findings: readonly ReadinessFinding[] = [
      { type: 'unresolved_choice_token', nodeId: 'a', text: 't', kind: 'bracket', options: ['x'] },
      { type: 'specifier_note_present', nodeId: 'b', text: 't' },
      { type: 'specifier_note_present', nodeId: 'c', text: 't' },
      { type: 'open_comment', nodeId: 'd', text: 't', author: 'Jane' },
      { type: 'body_object_present', nodeId: 'e', text: 't', objectKind: 'textBox' },
    ];

    expect(summarizeReadinessFindings(findings)).toEqual({
      unresolvedChoiceToken: 1,
      specifierNotePresent: 2,
      openComment: 1,
      bodyObjectPresent: 1,
      total: 5,
    });
  });

  it('total always equals findings.length, including zero', () => {
    expect(summarizeReadinessFindings([]).total).toBe(0);
  });
});
