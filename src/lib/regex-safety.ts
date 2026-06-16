/**
 * Write-boundary safety bounds for user-supplied regex sources (ADR-022 D5).
 *
 * Convention `noteBanners` are executable patterns supplied by users — unlike
 * captured source facts, they are validated and bounded before storage. This
 * module is pure: it returns a verdict, never touches the DB, and the query
 * layer maps a failure to its typed error.
 *
 * The ReDoS guard rejects patterns whose star height > 1 — an unbounded
 * quantifier (`*`, `+`, `{n,}`) applied to a subexpression that itself contains
 * an unbounded quantifier (`(a+)+`, `(a*)*`, `((a*)?)*`). That nested-quantifier
 * shape is the catastrophic-backtracking signature. This is the same conservative
 * heuristic the `safe-regex` package uses; it deliberately does NOT claim to
 * catch every slow regex (e.g. ambiguous alternations like `(a|a)*` pass), only
 * the exponential nested-quantifier class.
 */

export const MAX_REGEX_PATTERN_LENGTH = 200;
export const MAX_REGEX_PATTERNS = 64;

export interface RegexSafetyResult {
  readonly safe: boolean;
  readonly reason?: string;
}

const SAFE: RegexSafetyResult = { safe: true };

interface Quantifier {
  readonly unbounded: boolean;
  readonly len: number;
}

interface StepResult {
  readonly next: number;
  readonly danger: boolean;
}

// Index just past a character class starting at `i` (pattern[i] === '['), where
// '*', '(', ')' are literals and a leading ']' is a literal member.
function skipCharClass(pattern: string, i: number): number {
  let j = i + 1;
  if (pattern[j] === '^') j += 1;
  if (pattern[j] === ']') j += 1;
  while (j < pattern.length && pattern[j] !== ']') {
    j += pattern[j] === '\\' ? 2 : 1;
  }
  return j + 1;
}

// Chars consumed by a group opener so `?:`, `?=`, `?<name>` are not mistaken
// for quantifiers. A frame is pushed by the caller regardless of group kind.
function groupOpenLen(pattern: string, i: number): number {
  if (pattern[i + 1] !== '?') return 1;
  if (pattern[i + 2] !== '<') return 3; // (?:  (?=  (?!
  if (pattern[i + 3] === '=' || pattern[i + 3] === '!') return 4; // lookbehind
  const close = pattern.indexOf('>', i); // (?<name>
  return close === -1 ? 2 : close - i + 1;
}

function readBraceQuantifier(pattern: string, i: number): Quantifier | null {
  const close = pattern.indexOf('}', i);
  if (close === -1) return null;
  const body = pattern.slice(i + 1, close);
  if (!/^\d+(?:,\d*)?$/.test(body)) return null;
  const unbounded = /^\d+,$/.test(body); // {n,}
  const base = close - i + 1;
  return { unbounded, len: pattern[close + 1] === '?' ? base + 1 : base };
}

// A quantifier at index `i`, or null. Trailing lazy '?' is folded into `len`.
function readQuantifier(pattern: string, i: number): Quantifier | null {
  const c = pattern[i];
  if (c === '*' || c === '+') return { unbounded: true, len: pattern[i + 1] === '?' ? 2 : 1 };
  if (c === '?') return { unbounded: false, len: 1 };
  if (c === '{') return readBraceQuantifier(pattern, i);
  return null;
}

// Mark the (new) top frame as containing unboundedness, if `value` is true.
function propagate(frames: boolean[], value: boolean): void {
  const top = frames.length - 1;
  if (top >= 0 && value) frames[top] = true;
}

// On group close: pop the frame, look at the quantifier applied to the group.
// `(…)+` where the group already held unboundedness is star height ≥ 2 → danger.
// Otherwise the group's (or its quantifier's) unboundedness propagates to parent.
function closeGroup(pattern: string, i: number, frames: boolean[]): StepResult {
  const inner = frames.pop() ?? false;
  const q = readQuantifier(pattern, i + 1);
  const unbounded = q?.unbounded ?? false;
  if (unbounded && inner) return { next: i + 1, danger: true };
  propagate(frames, inner || unbounded);
  return { next: q ? i + 1 + q.len : i + 1, danger: false };
}

// Apply any quantifier sitting at `afterAtom` (the index just past an atom —
// a literal, escape, char class, or group). An unbounded quantifier marks the
// current frame so an enclosing star sees the nested unboundedness.
function applyQuantifier(pattern: string, afterAtom: number, frames: boolean[]): StepResult {
  const q = readQuantifier(pattern, afterAtom);
  if (!q) return { next: afterAtom, danger: false };
  if (q.unbounded) frames[frames.length - 1] = true;
  return { next: afterAtom + q.len, danger: false };
}

function step(pattern: string, i: number, frames: boolean[]): StepResult {
  const c = pattern[i];
  if (c === '\\') return applyQuantifier(pattern, i + 2, frames); // escaped atom
  if (c === '[') return applyQuantifier(pattern, skipCharClass(pattern, i), frames);
  if (c === '(') {
    frames.push(false);
    return { next: i + groupOpenLen(pattern, i), danger: false };
  }
  if (c === ')') return closeGroup(pattern, i, frames);
  if (c === '|') return { next: i + 1, danger: false }; // alternation bar is not an atom
  return applyQuantifier(pattern, i + 1, frames); // literal / '.' / anchor atom
}

// True when the pattern contains nested unbounded quantifiers (star height > 1).
function hasNestedUnbounded(pattern: string): boolean {
  const frames: boolean[] = [false];
  let i = 0;
  while (i < pattern.length) {
    const result = step(pattern, i, frames);
    if (result.danger) return true;
    i = result.next;
  }
  return false;
}

/** Validate and bound a single user-supplied regex source. */
export function checkRegexPattern(pattern: string): RegexSafetyResult {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return { safe: false, reason: `pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters` };
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { safe: false, reason: `pattern failed to compile: ${detail}` };
  }
  if (hasNestedUnbounded(pattern)) {
    return { safe: false, reason: 'pattern has nested unbounded quantifiers (ReDoS risk)' };
  }
  return SAFE;
}

/** Validate a list of regex sources, bounding both count and each pattern. */
export function checkRegexPatterns(patterns: readonly string[]): RegexSafetyResult {
  if (patterns.length > MAX_REGEX_PATTERNS) {
    return { safe: false, reason: `too many patterns (max ${MAX_REGEX_PATTERNS})` };
  }
  for (const pattern of patterns) {
    const result = checkRegexPattern(pattern);
    if (!result.safe) return result;
  }
  return SAFE;
}
