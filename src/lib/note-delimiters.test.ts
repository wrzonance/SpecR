import { describe, it, expect } from 'vitest';
import { isRuleRow, classifyNoteRoles, type NoteScanItem } from './note-delimiters.js';

describe('isRuleRow', () => {
  it('rejects 4 asterisks — below the 5-asterisk threshold', () => {
    expect(isRuleRow('****')).toBe(false);
  });

  it('accepts 5 asterisks — at the threshold', () => {
    expect(isRuleRow('*****')).toBe(true);
  });

  it('accepts more than 5 asterisks', () => {
    expect(isRuleRow('**********')).toBe(true);
  });

  it('rejects spaced asterisks — not a contiguous asterisk-only row', () => {
    expect(isRuleRow('* * * * *')).toBe(false);
  });

  it('rejects non-asterisk decoration (dashes) — stays on isDecorationSeparator path', () => {
    expect(isRuleRow('-----')).toBe(false);
  });

  it('rejects a row mixing asterisks with other text', () => {
    expect(isRuleRow('***** [OR] *****')).toBe(false);
  });

  it('rejects empty text', () => {
    expect(isRuleRow('')).toBe(false);
  });

  it('trims surrounding whitespace before counting', () => {
    expect(isRuleRow('  *****  ')).toBe(true);
  });
});

describe('classifyNoteRoles', () => {
  function items(...pairs: Array<[string, boolean?]>): NoteScanItem[] {
    return pairs.map(([text, isHeading = false]) => ({ text, isHeading }));
  }

  it('is total — returns one role per input item, even for an empty stream', () => {
    expect(classifyNoteRoles([])).toEqual([]);
  });

  it('tags text outside any rule pair as none', () => {
    const result = classifyNoteRoles(items(['Ordinary paragraph text.']));
    expect(result).toEqual(['none']);
  });

  it('paired rule rows: opener and closer are rule, enclosed content is note', () => {
    const result = classifyNoteRoles(
      items(['*****'], ['Delete items below not applicable to this project.'], ['*****'])
    );
    expect(result).toEqual(['rule', 'note', 'rule']);
  });

  it('paired rule rows enclosing multiple note lines', () => {
    const result = classifyNoteRoles(
      items(['*****'], ['First note line.'], ['Second note line.'], ['*****'])
    );
    expect(result).toEqual(['rule', 'note', 'note', 'rule']);
  });

  // Two immediately-consecutive rule rows toggle open-then-closed with nothing 'note'
  // between them — documented behavior, not a bug: there is no content between the
  // two delimiters to classify, so the toggle is a same-step open+close.
  it('two consecutive rule rows toggle open-then-closed with nothing note between', () => {
    const result = classifyNoteRoles(items(['*****'], ['*****'], ['Ordinary text after.']));
    expect(result).toEqual(['rule', 'rule', 'none']);
  });

  // KNOWN AMBIGUITY: an unpaired opener followed by a heading has no way to tell
  // whether the closing rule row was accidentally deleted (in which case the heading
  // itself and everything after it should NOT be swallowed as note) or the note was
  // simply left open by the author. classifyNoteRoles resolves this by treating the
  // heading as a safety-break: it force-closes the open region and is itself tagged
  // 'none', so structural content after the heading is never misread as note. This is
  // a deliberate, documented choice — not a silently "fixed" edge case.
  it('KNOWN AMBIGUITY: unpaired opener force-closed by a heading paragraph', () => {
    const result = classifyNoteRoles(
      items(
        ['*****'],
        ['Coordinate with the owner before proceeding.'],
        ['1.2 REFERENCES', true],
        ['Normal body text after the heading.']
      )
    );
    expect(result).toEqual(['rule', 'note', 'none', 'none']);
  });

  // KNOWN AMBIGUITY: an unpaired opener with no closing rule row and no heading
  // before the stream ends has no signal to force a close on, so it swallows every
  // remaining item as 'note' through end-of-stream. This can over-suppress trailing
  // structural content if the author simply forgot the closing delimiter — there is
  // no way to distinguish that from an intentionally open-ended note from text alone.
  // Documented here rather than silently patched around.
  it('KNOWN AMBIGUITY: unpaired opener with no closing row swallows rest of stream as note', () => {
    const result = classifyNoteRoles(
      items(['*****'], ['First trailing line.'], ['Second trailing line.'])
    );
    expect(result).toEqual(['rule', 'note', 'note']);
  });

  it('a heading with no open region is tagged none, not note', () => {
    const result = classifyNoteRoles(items(['1.1 SUMMARY', true]));
    expect(result).toEqual(['none']);
  });

  it('index alignment holds for a mixed realistic stream', () => {
    const result = classifyNoteRoles(
      items(
        ['1.1 SUMMARY', true],
        ['Section includes provisions for widgets.'],
        ['*****'],
        ['Verify widget count with owner before bidding.'],
        ['*****'],
        ['1.2 REFERENCES', true]
      )
    );
    expect(result).toEqual(['none', 'none', 'rule', 'note', 'rule', 'none']);
    expect(result).toHaveLength(6);
  });

  // ─── Drift guard (#292) ───────────────────────────────────────────────────
  // Hand-authored docs merge a closing wall into note prose ("…Waste Management
  // *****") or drop one, so the open/close toggle drifts out of phase and a "region"
  // swallows real numbered structure. A structural item enclosed by an open region is
  // that proof; the classifier then disengages for the whole document (every role
  // 'none') so no PART/article/list item is ever misread as a note.
  const structural = (text: string): NoteScanItem => ({
    text,
    isHeading: false,
    isStructural: true,
  });

  it('drift guard: a structural item inside a paired region disengages the whole document', () => {
    const result = classifyNoteRoles([
      { text: '*****', isHeading: false },
      { text: 'Editorial note prose.', isHeading: false },
      structural('A. Numbered list item that drifted inside the region.'),
      { text: '*****', isHeading: false },
      { text: 'Body text after the region.', isHeading: false },
    ]);
    expect(result).toEqual(['none', 'none', 'none', 'none', 'none']);
  });

  it('drift guard: also fires for a structural item under an unpaired (never-closed) opener', () => {
    const result = classifyNoteRoles([
      { text: '*****', isHeading: false },
      { text: 'Editorial note prose.', isHeading: false },
      structural('PRODUCTS'),
    ]);
    expect(result).toEqual(['none', 'none', 'none']);
  });

  it('drift guard: dormant when every structural item sits OUTSIDE the rule pair', () => {
    const result = classifyNoteRoles([
      structural('PART 1 - GENERAL'),
      { text: '*****', isHeading: false },
      { text: 'Editorial note prose.', isHeading: false },
      { text: '*****', isHeading: false },
      structural('A. Section includes the requirements for widgets.'),
    ]);
    expect(result).toEqual(['none', 'rule', 'note', 'rule', 'none']);
  });

  it('drift guard: dormant when a structural item is not enclosed (region already closed)', () => {
    const result = classifyNoteRoles([
      { text: '*****', isHeading: false },
      { text: 'Editorial note prose.', isHeading: false },
      { text: '*****', isHeading: false },
      structural('A. First real list item.'),
      structural('B. Second real list item.'),
    ]);
    expect(result).toEqual(['rule', 'note', 'rule', 'none', 'none']);
  });
});
