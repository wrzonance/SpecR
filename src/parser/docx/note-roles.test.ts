import { describe, it, expect } from 'vitest';
import { computeNoteRoles } from './note-roles.js';
import type { DocxParagraph } from './types.js';

function para(text: string, overrides: Partial<DocxParagraph> = {}): DocxParagraph {
  return { text, isVanish: false, ...overrides };
}

// The Signal-1 structural predicate the DOCX driver injects for a numId-only stream.
// The full driver predicate (Signal 1 OR Signal 2 via trySignal2) is exercised with
// real style/numbering maps in inference-notes.test.ts.
const byNumId = (p: DocxParagraph): boolean => p.numId !== undefined && p.numId > 0;

describe('computeNoteRoles', () => {
  it('is total — returns one role per paragraph, even for an empty document', () => {
    expect(computeNoteRoles([], byNumId)).toEqual([]);
  });

  it('is pure — identical input produces identical output across repeated calls', () => {
    const paragraphs = [
      para('*****'),
      para('Coordinate with the owner before proceeding.'),
      para('*****'),
    ];
    const first = computeNoteRoles(paragraphs, byNumId);
    const second = computeNoteRoles(paragraphs, byNumId);
    expect(second).toEqual(first);
    expect(second).toEqual(['rule', 'note', 'rule']);
  });

  it('classifies paired rule rows enclosing ordinary content as note', () => {
    const paragraphs = [
      para('*****'),
      para('Delete items below not applicable to this project.'),
      para('*****'),
    ];
    expect(computeNoteRoles(paragraphs, byNumId)).toEqual(['rule', 'note', 'rule']);
  });

  it('treats a literal "PART n" heading as heading text — force-closes an open note region', () => {
    const paragraphs = [
      para('*****'),
      para('Coordinate with the owner before proceeding.'),
      para('PART 2 - PRODUCTS'),
      para('Normal body text after the heading.'),
    ];
    expect(computeNoteRoles(paragraphs, byNumId)).toEqual(['rule', 'note', 'none', 'none']);
  });

  it('treats an "N.N" article heading as heading text — force-closes an open note region', () => {
    const paragraphs = [
      para('*****'),
      para('Coordinate with the owner before proceeding.'),
      para('1.2 REFERENCES'),
      para('Normal body text after the heading.'),
    ];
    expect(computeNoteRoles(paragraphs, byNumId)).toEqual(['rule', 'note', 'none', 'none']);
  });

  it('a heading paragraph with no open region is tagged none, not note', () => {
    expect(computeNoteRoles([para('PART 1 - GENERAL')], byNumId)).toEqual(['none']);
  });

  it('a plain body paragraph outside any rule pair is tagged none', () => {
    expect(computeNoteRoles([para('Ordinary paragraph text.')], byNumId)).toEqual(['none']);
  });

  // note-region: numbering-only PART heading (bare "GENERAL" under a spec-shaped
  // numId) enclosed by an unpaired asterisk opener must NOT be swallowed.
  // isHeadingParagraph is text-pattern-only, so it does not force-close on the bare
  // word — but the injected structural predicate (byNumId here) marks the paragraph
  // structural, tripping the classifier's drift guard: the asterisk convention
  // disengages for the whole document (every role 'none') rather than swallow the
  // heading. This is the exact #292 regression (a numbering-only PART lost into a
  // note) resolved.
  it('note-region: a numbering-only PART heading inside an open region trips the drift guard, not swallowed', () => {
    const paragraphs = [
      para('*****'),
      para('Coordinate with the owner before proceeding.'),
      para('GENERAL', { numId: 9, ilvl: 0 }),
    ];
    expect(computeNoteRoles(paragraphs, byNumId)).toEqual(['none', 'none', 'none']);
  });

  // The drift guard keys on the numbering signal, not on the mere presence of a
  // rule row: a cleanly paired region enclosing ONLY un-numbered note prose stays a
  // real note region (walls suppressed, prose noted) even though the same document
  // has numbered structural content OUTSIDE the region.
  it('note-region: numbered content OUTSIDE a cleanly-paired region does not trip the drift guard', () => {
    const paragraphs = [
      para('PART 1 - GENERAL', { numId: 9, ilvl: 0 }),
      para('*****'),
      para('Delete items below not applicable to this project.'),
      para('*****'),
      para('Section includes the requirements for widgets.', { numId: 9, ilvl: 2 }),
    ];
    expect(computeNoteRoles(paragraphs, byNumId)).toEqual(['none', 'rule', 'note', 'rule', 'none']);
  });
});
