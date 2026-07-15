// Header/footer fixture scenario catalog for the visual round-trip
// verification harness's header/footer capstone (#305 task 4/7).
//
// Each scenario pairs a real CSI section/title identity with a
// HeaderFooterCompositionInput — the exact wire body putProjectHeaderFooter
// (api-client/project-client.ts, #305 task 2/7) sends to PUT
// /projects/{id}/header-footer. buildScenarioReferenceDocx renders the
// GROUND-TRUTH reference DOCX for that composition directly via the `docx`
// package, so the pixel-diff pipeline (task 6/7) has something to compare
// the SpecR API's own round-tripped output against.
//
// SPIKE FIX (finding 1): section/title identity is carried on the `docx`
// Document constructor's own core-properties options (`subject`/`title`),
// which land in docProps/core.xml — the exact part the real parser's
// parseCoreMetadata reads (src/parser/docx/core-metadata.ts: dc:subject via
// parseSectionNumberCandidate(subject, 'strong'), dc:title trimmed). An
// earlier draft of this design put the section/title in body text for the
// 5-signal engine's S4 pattern to pick up; the pre-implementation spike
// proved that path ambiguous (S4-only text sometimes resolved to 'unknown'
// depending on which signal won), against core.xml's clean, deterministic
// resolution. This file has zero import from repo-root src/
// (import-boundary.test.ts) — the parser behavior above is described from
// reading that file, not exercised by importing it.

import {
  AlignmentType,
  Document,
  Footer,
  Header,
  PageBreak,
  Packer,
  Paragraph,
  TextRun,
  type ISectionPropertiesOptions,
} from 'docx';
import { VerifyRenderError } from '../errors.js';
import type {
  HeaderFooterCellInput,
  HeaderFooterCompositionInput,
  HeaderFooterFieldInput,
  HeaderFooterVariantInput,
} from '../api-client/project-client.js';

export type HeaderFooterScenarioId = 'default' | 'first' | 'even' | 'fields' | 'restartPerSpec';

export interface HeaderFooterScenario {
  readonly id: HeaderFooterScenarioId;
  readonly description: string;
  readonly section: string;
  readonly title: string;
  readonly pageCount: 1 | 2;
  readonly composition: HeaderFooterCompositionInput;
}

function literalField(text: string): HeaderFooterFieldInput {
  return { kind: 'literal', text };
}

const SECTION_NUMBER_FIELD: HeaderFooterFieldInput = { kind: 'sectionNumber' };
const SECTION_TITLE_FIELD: HeaderFooterFieldInput = { kind: 'sectionTitle' };

// Wrap a single field as the one-item `content` array the real API's
// HeaderFooterCellSchema requires at a region position (`header.center` /
// `footer.center`) — see project-client.ts's HeaderFooterCellInput docstring
// for why a bare field object silently renders nothing.
function cell(field: HeaderFooterFieldInput): HeaderFooterCellInput {
  return { content: [field] };
}

export const HEADER_FOOTER_SCENARIOS: readonly HeaderFooterScenario[] = [
  {
    id: 'default',
    description: 'A single default header/footer variant applied uniformly to every page.',
    section: '07 92 00',
    title: 'Joint Sealants',
    pageCount: 1,
    composition: {
      variants: {
        default: {
          header: { center: cell(literalField('PROJECT MASTER')) },
          footer: { center: cell(SECTION_NUMBER_FIELD) },
        },
      },
    },
  },
  {
    id: 'first',
    description: 'A distinct first-page header, different from the default variant.',
    section: '09 91 23',
    title: 'Interior Painting',
    pageCount: 2,
    composition: {
      variants: {
        default: { header: { center: cell(literalField('CONTINUATION')) } },
        first: { header: { center: cell(literalField('COVER PAGE')) } },
      },
    },
  },
  {
    id: 'even',
    description: 'A distinct even-page header, different from the default (odd-page) variant.',
    section: '08 71 00',
    title: 'Door Hardware',
    pageCount: 2,
    composition: {
      variants: {
        default: { header: { center: cell(literalField('ODD PAGE')) } },
        even: { header: { center: cell(literalField('EVEN PAGE')) } },
      },
    },
  },
  {
    id: 'fields',
    description: 'Header/footer fields resolved from the section identity, not literal text.',
    section: '23 05 00',
    title: 'Common Work Results for HVAC',
    pageCount: 1,
    composition: {
      variants: {
        default: {
          header: { center: cell(SECTION_NUMBER_FIELD) },
          footer: { center: cell(SECTION_TITLE_FIELD) },
        },
      },
    },
  },
  {
    id: 'restartPerSpec',
    description:
      "Page numbering restarts at 1 for this spec instead of continuing the project's sequence.",
    section: '26 05 00',
    title: 'Common Work Results for Electrical',
    pageCount: 1,
    composition: {
      variants: {
        default: { header: { center: cell(literalField('RESTART DEMO')) } },
      },
      pageNumbering: { mode: 'restartPerSpec', startAt: 1 },
    },
  },
];

/** Total lookup over the closed HEADER_FOOTER_SCENARIOS catalog. */
export function findScenario(id: HeaderFooterScenarioId): HeaderFooterScenario {
  const scenario = HEADER_FOOTER_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new VerifyRenderError(`unknown header/footer fixture scenario '${id}'`, {
      stage: 'render',
    });
  }
  return scenario;
}

function resolveFieldText(field: HeaderFooterFieldInput, scenario: HeaderFooterScenario): string {
  switch (field.kind) {
    case 'literal':
      return field.text;
    case 'sectionNumber':
      return scenario.section;
    case 'sectionTitle':
      return scenario.title;
  }
}

// Every fixture scenario's cell carries exactly one content field — this
// harness never exercises the real API's multi-field-per-cell case, so the
// first entry is the whole story here.
function resolveCellText(
  cell: HeaderFooterCellInput | undefined,
  scenario: HeaderFooterScenario
): string {
  const field = cell?.content[0];
  return field === undefined ? '' : resolveFieldText(field, scenario);
}

function centeredParagraph(text: string): Paragraph {
  return new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun(text)] });
}

function buildHeader(
  variant: HeaderFooterVariantInput | undefined,
  scenario: HeaderFooterScenario
): Header | undefined {
  if (variant?.header?.center === undefined) return undefined;
  return new Header({
    children: [centeredParagraph(resolveCellText(variant.header.center, scenario))],
  });
}

function buildFooter(
  variant: HeaderFooterVariantInput | undefined,
  scenario: HeaderFooterScenario
): Footer | undefined {
  if (variant?.footer?.center === undefined) return undefined;
  return new Footer({
    children: [centeredParagraph(resolveCellText(variant.footer.center, scenario))],
  });
}

interface HeaderMap {
  readonly default?: Header;
  readonly first?: Header;
  readonly even?: Header;
}

interface FooterMap {
  readonly default?: Footer;
  readonly first?: Footer;
  readonly even?: Footer;
}

function buildHeaders(scenario: HeaderFooterScenario): HeaderMap {
  const variants = scenario.composition.variants;
  const defaultHeader = buildHeader(variants?.default, scenario);
  const firstHeader = buildHeader(variants?.first, scenario);
  const evenHeader = buildHeader(variants?.even, scenario);
  return {
    ...(defaultHeader !== undefined ? { default: defaultHeader } : {}),
    ...(firstHeader !== undefined ? { first: firstHeader } : {}),
    ...(evenHeader !== undefined ? { even: evenHeader } : {}),
  };
}

function buildFooters(scenario: HeaderFooterScenario): FooterMap {
  const variants = scenario.composition.variants;
  const defaultFooter = buildFooter(variants?.default, scenario);
  const firstFooter = buildFooter(variants?.first, scenario);
  const evenFooter = buildFooter(variants?.even, scenario);
  return {
    ...(defaultFooter !== undefined ? { default: defaultFooter } : {}),
    ...(firstFooter !== undefined ? { first: firstFooter } : {}),
    ...(evenFooter !== undefined ? { even: evenFooter } : {}),
  };
}

function buildSectionProperties(scenario: HeaderFooterScenario): ISectionPropertiesOptions {
  const { variants, pageNumbering } = scenario.composition;
  return {
    ...(variants?.first !== undefined ? { titlePage: true } : {}),
    ...(pageNumbering?.startAt !== undefined
      ? { page: { pageNumbers: { start: pageNumbering.startAt } } }
      : {}),
  };
}

// A run-level PageBreak (`<w:br w:type="page"/>`), not the pPr-level
// `pageBreakBefore: true` paragraph property: docx-preview 0.4.0's own
// pagination (`splitBySection`, vendored under node_modules) only detects
// `pageBreakBefore` when it comes from a NAMED STYLE's paragraphProps
// (`findStyle(elem.styleName)?.paragraphProps?.pageBreakBefore`), never a
// paragraph's own direct pPr override — the shape `docx`'s
// `pageBreakBefore: true` constructor option actually emits. Confirmed live
// during task 7/7's Playwright smoke test: with the pPr-level property, the
// reference pane rendered as a single page despite the paragraph carrying a
// valid `w:pageBreakBefore`. A run-level break is the one page-break
// mechanism `isPageBreakElement` DOES honor regardless of style.
function buildBodyChildren(pageCount: 1 | 2): readonly Paragraph[] {
  if (pageCount === 1) {
    return [new Paragraph({ children: [new TextRun('Reference fixture body text, page 1.')] })];
  }
  const firstPage = new Paragraph({
    children: [new TextRun('Reference fixture body text, page 1.'), new PageBreak()],
  });
  const secondPage = new Paragraph({
    children: [new TextRun('Reference fixture body text, page 2.')],
  });
  return [firstPage, secondPage];
}

/**
 * Render the ground-truth reference DOCX for a header/footer scenario.
 * Throws VerifyRenderError (stage 'render'), chaining the `docx` package's
 * own thrown cause, on any build failure.
 */
export async function buildScenarioReferenceDocx(scenario: HeaderFooterScenario): Promise<Buffer> {
  try {
    const doc = new Document({
      subject: scenario.section,
      title: scenario.title,
      evenAndOddHeaderAndFooters: scenario.composition.variants?.even !== undefined,
      sections: [
        {
          properties: buildSectionProperties(scenario),
          headers: buildHeaders(scenario),
          footers: buildFooters(scenario),
          children: buildBodyChildren(scenario.pageCount),
        },
      ],
    });
    return await Packer.toBuffer(doc);
  } catch (err) {
    throw new VerifyRenderError(
      `failed to build reference DOCX for header/footer scenario '${scenario.id}'`,
      { stage: 'render', cause: err }
    );
  }
}
