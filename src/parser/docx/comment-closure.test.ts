import { describe, expect, it } from 'vitest';
import { isCommentClosed, textEndsWithClosed } from './comment-closure.js';

describe('textEndsWithClosed — "Closed" suffix heuristic (#262)', () => {
  it('matches a plain "Closed" suffix', () => {
    expect(textEndsWithClosed('Use approved product list. Closed')).toBe(true);
  });

  it('is case tolerant', () => {
    expect(textEndsWithClosed('done CLOSED')).toBe(true);
    expect(textEndsWithClosed('done closed')).toBe(true);
  });

  it('is trailing-whitespace tolerant', () => {
    expect(textEndsWithClosed('resolved  Closed   \n')).toBe(true);
  });

  it('tolerates a single trailing period after "Closed"', () => {
    expect(textEndsWithClosed('resolved Closed.')).toBe(true);
  });

  it('does not match when "Closed" is not the final word', () => {
    expect(textEndsWithClosed('Closed the loop, please verify')).toBe(false);
  });

  it('does not match a word merely containing "closed"', () => {
    expect(textEndsWithClosed('the valve is enclosed')).toBe(false);
  });

  it('does not match an open comment', () => {
    expect(textEndsWithClosed('Coordinate with owner.')).toBe(false);
  });

  it('does not match the empty string', () => {
    expect(textEndsWithClosed('')).toBe(false);
  });

  // KNOWN AMBIGUITY: "Closed" appearing mid-sentence (e.g. "Closed per RFI but
  // re-opened for the addendum") is NOT treated as a closure marker — only a
  // trailing "Closed" counts. A reviewer who writes "Closed" at the START of an
  // otherwise-open note is therefore reported as OPEN. We deliberately favour the
  // false-negative (surface it as open) over silently hiding an unresolved comment.
  it('KNOWN AMBIGUITY: "Closed" mid-sentence is treated as OPEN, not closed', () => {
    expect(textEndsWithClosed('Closed per RFI but re-open for addendum')).toBe(false);
  });
});

describe('isCommentClosed — either signal (#262)', () => {
  it('is closed when struck even if the text has no "Closed" suffix', () => {
    expect(isCommentClosed({ text: 'Coordinate with owner.', struck: true })).toBe(true);
  });

  it('is closed when the text ends with "Closed" even if not struck', () => {
    expect(isCommentClosed({ text: 'Resolved Closed', struck: false })).toBe(true);
  });

  it('is open when neither struck nor "Closed"-suffixed', () => {
    expect(isCommentClosed({ text: 'Coordinate with owner.', struck: false })).toBe(false);
  });
});
