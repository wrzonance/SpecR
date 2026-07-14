import { XMLParser } from 'fast-xml-parser';
// XMLValidator is flagged deprecated (relocated to the separate
// `fast-xml-validator` package in fast-xml-parser 5.x) but still ships and works
// in the pinned version. We keep using it rather than take on a whole new
// dependency — added attack surface — for a single core.xml validity check.
// Revisit if it is removed upstream.
// eslint-disable-next-line sonarjs/deprecation -- intentional: see note above
import { XMLValidator } from 'fast-xml-parser';
import type { ParseWarning } from '../../ast/types.js';
import { parseSectionNumberCandidate } from '../../lib/section-number.js';

const coreParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

export interface CoreMetadata {
  readonly section: string;
  readonly title: string;
  readonly warning?: ParseWarning;
}

// Fallback value for `section`/`title` whenever docProps/core.xml is absent,
// unreadable, or lacks a conforming dc:subject/dc:title — never a real
// section number or title. Exported so a caller holding a CoreMetadata-derived
// identity (header-footer-field-recognition.ts's matchKnownSectionField, #306
// ADR-068) can positively exclude this sentinel instead of risking a
// coincidental literal-text match against it.
export const UNKNOWN_SECTION_IDENTITY = 'unknown';

// Shared fallback for docProps/core.xml that cannot be trusted — whether it
// fails XML validation (malformed markup that fast-xml-parser's lenient parse
// would accept without throwing) or throws outright. Surfaced as a tree warning
// so the degrade to content inference is visible in logs/API/MCP responses
// instead of silently emitting an 'unknown' (or worse, a value scraped from a
// corrupt file).
function unreadableCoreMetadata(): CoreMetadata {
  return {
    section: UNKNOWN_SECTION_IDENTITY,
    title: UNKNOWN_SECTION_IDENTITY,
    warning: {
      type: 'core-metadata-unreadable',
      suggestion:
        'docProps/core.xml could not be parsed; section/title fell back to content inference.',
    },
  };
}

// docProps/core.xml → section/title metadata. Moved verbatim out of index.ts
// (#306 line-budget prerequisite, one of two extractions carving out headroom
// for the header/footer capture feature) — zero behavior change.
export function parseCoreMetadata(xml: string): CoreMetadata {
  // fast-xml-parser decouples validation from parsing for performance, so
  // parse() accepts malformed markup (unclosed/mismatched tags) without
  // throwing and could scrape a value from a corrupt file. Validate first and
  // route invalid XML through the same unreadable path as an outright throw.
  // eslint-disable-next-line sonarjs/deprecation -- see XMLValidator import note
  if (XMLValidator.validate(xml) !== true) {
    return unreadableCoreMetadata();
  }
  try {
    const parsed = coreParser.parse(xml) as Record<string, unknown>;
    const props = parsed['cp:coreProperties'] as Record<string, unknown> | undefined;
    const subject = props?.['dc:subject'];
    const titleVal = props?.['dc:title'];
    // dc:subject is free-text in Word — normalize so non-conforming values degrade
    // to 'unknown' and the orchestrator's content inference takes over (instead of
    // leaking prose downstream where the worker section-gate would kill the job).
    const parsedSection =
      typeof subject === 'string' ? parseSectionNumberCandidate(subject, 'strong') : null;
    const section = parsedSection?.ok === true ? parsedSection.canonical : UNKNOWN_SECTION_IDENTITY;
    return {
      section,
      title:
        typeof titleVal === 'string' && titleVal.trim()
          ? titleVal.trim()
          : UNKNOWN_SECTION_IDENTITY,
    };
  } catch {
    return unreadableCoreMetadata();
  }
}
