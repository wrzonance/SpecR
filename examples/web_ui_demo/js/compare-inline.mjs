// Merged-redline token builder for the Compare view's Inline review mode (#395).
// Pure, no DOM. Reuses the word-diff LCS (js/word-diff.mjs) to fold a differing
// A/B pair into ONE token stream: shared words once, A-only words as deletions,
// B-only words as insertions. Words are joined by shared single-space separators,
// so no del/ins token is ever whitespace — a screen reader reads a clean sentence.

import { diffWords } from './word-diff.mjs';

const isWhitespace = (text) => /^\s+$/.test(text);
const wordsOf = (marks) => marks.filter((token) => !isWhitespace(token.text));

// Join word tokens with shared single-space separators.
function spaced(tokens) {
  const out = [];
  tokens.forEach((token, index) => {
    if (index > 0) out.push({ text: ' ', kind: 'shared' });
    out.push(token);
  });
  return out;
}

// Merge a differing pair. Unchanged words are the LCS (identical order on both
// sides), so when both walkers reach an unchanged word it is the same word —
// emitted once as shared. Everything else is a one-sided del (A) or ins (B).
export function mergeTokens(textA, textB) {
  const { a, b } = diffWords(textA ?? '', textB ?? '');
  const wordsA = wordsOf(a);
  const wordsB = wordsOf(b);
  const merged = [];
  let i = 0;
  let j = 0;
  while (i < wordsA.length || j < wordsB.length) {
    while (i < wordsA.length && wordsA[i].changed) {
      merged.push({ text: wordsA[i].text, kind: 'del' });
      i += 1;
    }
    while (j < wordsB.length && wordsB[j].changed) {
      merged.push({ text: wordsB[j].text, kind: 'ins' });
      j += 1;
    }
    if (i < wordsA.length && j < wordsB.length) {
      merged.push({ text: wordsA[i].text, kind: 'shared' });
      i += 1;
      j += 1;
    }
  }
  return spaced(merged);
}

// Fold one aligned row into its inline token stream by state.
export function buildInlineTokens(row) {
  const textA = row?.cells?.[0]?.present ? row.cells[0].text : '';
  const textB = row?.cells?.[1]?.present ? row.cells[1].text : '';
  switch (row?.state) {
    case 'differing':
      return mergeTokens(textA, textB);
    case 'only-a':
      return textA ? [{ text: textA, kind: 'del' }] : [];
    case 'only-b':
      return textB ? [{ text: textB, kind: 'ins' }] : [];
    case 'identical':
    default: {
      const text = textA || textB;
      return text ? [{ text, kind: 'shared' }] : [];
    }
  }
}
