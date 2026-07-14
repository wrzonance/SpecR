import { XMLParser } from 'fast-xml-parser';
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

// docProps/core.xml → section/title metadata. Moved verbatim out of index.ts
// (#306 line-budget prerequisite, one of two extractions carving out headroom
// for the header/footer capture feature) — zero behavior change.
export function parseCoreMetadata(xml: string): CoreMetadata {
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
    // Corrupt/unparseable core.xml previously degraded silently to 'unknown'.
    // Surface it as a tree warning so it flows to logs/API/MCP responses instead.
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
}
