import type { SourceChoiceTokenFact } from '../../ast/types.js';

type ChoiceTokenKind = SourceChoiceTokenFact['kind'];

interface Delimiters {
  readonly kind: ChoiceTokenKind;
  readonly open: string;
  readonly close: string;
}

interface Segment {
  readonly kind: ChoiceTokenKind;
  readonly option: string;
  readonly start: number;
  readonly end: number;
}

interface SegmentResult {
  readonly segment?: Segment;
  readonly nextIndex: number;
}

const DELIMITERS: readonly Delimiters[] = [
  { kind: 'angle', open: '<', close: '>' },
  { kind: 'bracket', open: '[', close: ']' },
];

const SECTION_REF_PATTERN = /^Section\s+\d{2}\s+\d{2}\s+\d{2}(?:\.\d+)?$/i;

function delimitersAt(text: string, index: number): Delimiters | null {
  return DELIMITERS.find((d) => text[index] === d.open) ?? null;
}

function isAmbiguousBracketOption(option: string): boolean {
  return SECTION_REF_PATTERN.test(option.trim());
}

function hasNestedDelimiter(
  text: string,
  delimiters: Delimiters,
  start: number,
  end: number
): boolean {
  return text.slice(start + 1, end).includes(delimiters.open);
}

function parseSegmentAt(text: string, index: number): SegmentResult {
  const delimiters = delimitersAt(text, index);
  if (!delimiters) return { nextIndex: index + 1 };

  const closeIndex = text.indexOf(delimiters.close, index + 1);
  if (closeIndex === -1) return { nextIndex: index + 1 };
  if (hasNestedDelimiter(text, delimiters, index, closeIndex)) {
    return { nextIndex: closeIndex + 1 };
  }

  const option = text.slice(index + 1, closeIndex);
  if (option.length === 0) return { nextIndex: closeIndex + 1 };
  if (delimiters.kind === 'bracket' && isAmbiguousBracketOption(option)) {
    return { nextIndex: closeIndex + 1 };
  }

  return {
    segment: { kind: delimiters.kind, option, start: index, end: closeIndex + 1 },
    nextIndex: closeIndex + 1,
  };
}

function collectAdjacentSegments(text: string, first: Segment): readonly Segment[] {
  const group: Segment[] = [first];
  let cursor = first.end;

  while (cursor < text.length) {
    const parsed = parseSegmentAt(text, cursor);
    const next = parsed.segment;
    if (!next || next.kind !== first.kind || next.start !== cursor) break;
    group.push(next);
    cursor = next.end;
  }

  return group;
}

function groupToFact(group: readonly Segment[]): SourceChoiceTokenFact | null {
  const first = group[0];
  const last = group.at(-1);
  if (!first || !last) return null;
  return {
    kind: first.kind,
    options: group.map((segment) => segment.option),
    span: [first.start, last.end],
  };
}

export function scanChoiceTokens(text: string): readonly SourceChoiceTokenFact[] {
  const facts: SourceChoiceTokenFact[] = [];
  let index = 0;

  while (index < text.length) {
    const parsed = parseSegmentAt(text, index);
    if (!parsed.segment) {
      index = parsed.nextIndex;
      continue;
    }
    const group = collectAdjacentSegments(text, parsed.segment);
    const fact = groupToFact(group);
    if (fact) facts.push(fact);
    index = group[group.length - 1]?.end ?? parsed.nextIndex;
  }

  return facts;
}
