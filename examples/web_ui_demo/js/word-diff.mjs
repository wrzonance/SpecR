// Word-level diff for the Compare view (#385). Pure, no dependencies.
// Splits each string into word + whitespace tokens, computes the longest
// common subsequence over the WORDS, and marks any word not on the LCS path
// as `changed`. Whitespace tokens are never flagged, so joining a side's
// token .text round-trips its original input exactly.

function tokenize(text) {
  // Keep the separators: whitespace runs stay as their own tokens.
  return text.split(/(\s+)/).filter((piece) => piece.length > 0);
}

function isWord(token) {
  return !/^\s+$/.test(token);
}

// LCS length table over two word arrays, filled from the tail so a forward
// walk can pick the longest common subsequence.
function lcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

// Walk the table to the set of matched word indices on each side.
function matchedIndices(a, b) {
  const table = lcsTable(a, b);
  const inA = new Set();
  const inB = new Set();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inA.add(i);
      inB.add(j);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return { inA, inB };
}

// Map raw token strings to {text, changed}, flagging word tokens whose position
// is not in the matched set.
function mark(tokens, matched) {
  let wordIndex = -1;
  return tokens.map((text) => {
    if (!isWord(text)) return { text, changed: false };
    wordIndex += 1;
    return { text, changed: !matched.has(wordIndex) };
  });
}

export function diffWords(a, b) {
  const tokensA = tokenize(a ?? '');
  const tokensB = tokenize(b ?? '');
  const wordsA = tokensA.filter(isWord);
  const wordsB = tokensB.filter(isWord);
  const { inA, inB } = matchedIndices(wordsA, wordsB);
  return { a: mark(tokensA, inA), b: mark(tokensB, inB) };
}
