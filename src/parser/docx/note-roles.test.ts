import { describe, it, expect } from 'vitest';
import { computeNoteRoles } from './note-roles.js';
import type { DocxParagraph } from './types.js';

function para(text: string, overrides: Partial<DocxParagraph> = {}): DocxParagraph {
  return { text, isVanish: false, ...overrides };
}

describe('computeNoteRoles', () => {
  it('is total — returns one role per paragraph, even for an empty document', () => {
    expect(computeNoteRoles([])).toEqual([]);
  });

  it('is pure — identical input produces identical output across repeated calls', () => {
    const paragraphs = [
      para('*****'),
      para('Coordinate with the owner before proceeding.'),
      para('*****'),
    ];
    const first = computeNoteRoles(paragraphs);
    const second = computeNoteRoles(paragraphs);
    expect(second).toEqual(first);
    expect(second).toEqual(['rule', 'note', 'rule']);
  });

  it('classifies paired rule rows enclosing ordinary content as note', () => {
    const paragraphs = [
      para('*****'),
      para('Delete items below not applicable to this project.'),
      para('*****'),
    ];
    expect(computeNoteRoles(paragraphs)).toEqual(['rule', 'note', 'rule']);
  });

  it('treats a literal "PART n" heading as heading text — force-closes an open note region', () => {
    const paragraphs = [
      para('*****'),
      para('Coordinate with the owner before proceeding.'),
      para('PART 2 - PRODUCTS'),
      para('Normal body text after the heading.'),
    ];
    expect(computeNoteRoles(paragraphs)).toEqual(['rule', 'note', 'none', 'none']);
  });

  it('treats an "N.N" article heading as heading text — force-closes an open note region', () => {
    const paragraphs = [
      para('*****'),
      para('Coordinate with the owner before proceeding.'),
      para('1.2 REFERENCES'),
      para('Normal body text after the heading.'),
    ];
    expect(computeNoteRoles(paragraphs)).toEqual(['rule', 'note', 'none', 'none']);
  });

  it('a heading paragraph with no open region is tagged none, not note', () => {
    expect(computeNoteRoles([para('PART 1 - GENERAL')])).toEqual(['none']);
  });

  it('a plain body paragraph outside any rule pair is tagged none', () => {
    expect(computeNoteRoles([para('Ordinary paragraph text.')])).toEqual(['none']);
  });

  // KNOWN AMBIGUITY: isHeadingParagraph is text-pattern-only (Signal 4 shape), so a
  // heading whose PART/article status is carried entirely by numbering.xml or a
  // style (Signal 1/2) — with no literal "PART n" / "N.N" text, e.g. a bare
  // "GENERAL" title under a spec-shaped numId — is invisible to it. An unpaired
  // opener is NOT force-closed by such a paragraph and continues to swallow it,
  // and everything after it through end-of-stream, as 'note'. This is a deliberate
  // boundary, not an oversight: note-role classification runs on raw paragraph
  // text ahead of the 5-signal engine, so numbering/style facts are not yet
  // available to it.
  it('KNOWN AMBIGUITY: a numbering-only heading with no literal PART/article text is not recognized as a heading', () => {
    const paragraphs = [
      para('*****'),
      para('Coordinate with the owner before proceeding.'),
      para('GENERAL', { numId: 9, ilvl: 0 }),
    ];
    expect(computeNoteRoles(paragraphs)).toEqual(['rule', 'note', 'note']);
  });
});
