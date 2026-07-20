import type { SourceFacts, SourceHighlightFact } from './types.js';

const LEGACY_PREFIX = 'highlight:';

export interface ResolvedSourceHighlight {
  readonly fact: SourceHighlightFact;
  readonly factPath: string;
}

function directHighlights(facts: SourceFacts): readonly ResolvedSourceHighlight[] {
  return (facts.highlights ?? []).map((fact, index) => ({
    fact,
    factPath: `highlights[${index}]`,
  }));
}

function legacyHighlights(text: string, facts: SourceFacts): readonly ResolvedSourceHighlight[] {
  return (facts.colors ?? []).flatMap((color, colorIndex) => {
    if (!color.color.toLowerCase().startsWith(LEGACY_PREFIX)) return [];
    const highlightColor = color.color.slice(LEGACY_PREFIX.length);
    if (highlightColor.length === 0) return [];
    return color.spans.map((span) => ({
      fact: { color: highlightColor, text: text.slice(span[0], span[1]), span },
      factPath: `colors[${colorIndex}]`,
    }));
  });
}

/**
 * Resolve canonical highlight facts, adapting pre-#408 synthetic color facts
 * only when a paragraph has no first-class facts. This avoids duplicate clues
 * on new parses while keeping already-persisted masters reclassifiable.
 */
export function resolveSourceHighlights(
  text: string,
  facts: SourceFacts
): readonly ResolvedSourceHighlight[] {
  const direct = directHighlights(facts);
  return direct.length > 0 ? direct : legacyHighlights(text, facts);
}
