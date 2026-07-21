import type { SourceColorFact } from '../../ast/types.js';

export interface ColorSpan {
  readonly color: string;
  readonly start: number;
  readonly end: number;
}

function mergeSpans(spans: readonly ColorSpan[]): readonly (readonly [number, number])[] {
  const merged: [number, number][] = [];
  spans.forEach((span) => {
    const last = merged.at(-1);
    if (last && last[1] === span.start) {
      merged[merged.length - 1] = [last[0], span.end];
      return;
    }
    merged.push([span.start, span.end]);
  });
  return merged;
}

function coveredLength(spans: readonly (readonly [number, number])[]): number {
  return spans.reduce((sum, span) => sum + span[1] - span[0], 0);
}

/** Aggregate run colors by token while retaining exact paragraph-relative spans. */
export function colorFactsForParagraph(
  text: string,
  colorSpans: readonly ColorSpan[]
): readonly SourceColorFact[] {
  if (text.length === 0) return [];
  const byColor = new Map<string, ColorSpan[]>();
  colorSpans.forEach((span) => {
    byColor.set(span.color, [...(byColor.get(span.color) ?? []), span]);
  });
  return [...byColor.entries()].map(([color, spans]) => {
    const merged = mergeSpans(spans);
    return { color, coverage: coveredLength(merged) / text.length, spans: merged };
  });
}
