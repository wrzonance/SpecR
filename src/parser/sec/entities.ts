// Bounded XML entity decoding for SpecsIntact .SEC content.
//
// The structured parse runs with processEntities: false (so DTD/custom-entity
// expansion is impossible), and stopNodes hand back raw XML for mixed-content
// elements either way — entity decoding therefore happens here, deliberately:
// the five XML named entities plus numeric character references, nothing else.
//
// Single-pass replace: produced text is never re-scanned, so a double-escaped
// &amp;amp; correctly decodes once to the literal "&amp;".

const ENTITY_PATTERN = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g;

const NAMED = new Map<string, string>([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

function decodeCodePoint(match: string, code: number): string {
  if (code > 0x10ffff) return match; // out of Unicode range — leave untouched
  return String.fromCodePoint(code);
}

export function decodeXmlEntities(text: string): string {
  return text.replace(
    ENTITY_PATTERN,
    (match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (named !== undefined) return NAMED.get(named) ?? match;
      if (hex !== undefined) return decodeCodePoint(match, parseInt(hex, 16));
      if (dec !== undefined) return decodeCodePoint(match, parseInt(dec, 10));
      return match;
    }
  );
}
