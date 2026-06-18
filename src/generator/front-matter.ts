import { AlignmentType, PageBreak, Paragraph, TableOfContents, TextRun } from 'docx';
import type { FileChild } from 'docx';
import type { StyleRule } from '../ast/index.js';
import { buildRuleMap, runStyleOptions, type StyleRuleMap } from './styles.js';

/** Project identity rendered on the manual cover (ADR-017 D1). */
export interface ManualSectionListing {
  readonly section: string;
  readonly title: string;
}

export interface ManualRevisionMeta {
  readonly displayName: string;
  readonly date: string;
  readonly packageName: string;
}

export interface ManualAddendumMeta {
  readonly affectedSections: readonly ManualSectionListing[];
}

export interface ManualMeta {
  readonly name: string;
  readonly description: string | null;
  readonly revision?: ManualRevisionMeta;
  readonly addendum?: ManualAddendumMeta;
}

// '1-1' = build TOC entries from Heading1 only, so the field yields exactly one
// entry per section title. Word computes the entries + pagination on open; SpecR
// emits the field + the Heading1 section titles (structure), never page numbers.
const TOC_HEADING_RANGE = '1-1';
const TOC_TITLE = 'Table of Contents';

function coverTitle(name: string, rules?: StyleRuleMap): Paragraph {
  const partProps = rules?.get('part');
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: name, ...runStyleOptions(partProps?.rPr) })],
  });
}

function centeredText(text: string, bold = false): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text, bold })],
  });
}

function affectedSections(sections: readonly ManualSectionListing[]): Paragraph[] {
  if (sections.length === 0) return [];
  return [
    centeredText('Affected Sections', true),
    ...sections.map((section) => centeredText(`${section.section} - ${section.title}`)),
  ];
}

function coverParagraphs(meta: ManualMeta, rules?: StyleRuleMap): Paragraph[] {
  const cover: Paragraph[] = [coverTitle(meta.name, rules)];
  if (meta.description !== null && meta.description !== '') {
    cover.push(centeredText(meta.description));
  }
  if (meta.revision !== undefined) {
    cover.push(centeredText(meta.revision.packageName));
    cover.push(centeredText(meta.revision.displayName, true));
    cover.push(centeredText(meta.revision.date));
  }
  if (meta.addendum !== undefined) {
    cover.push(...affectedSections(meta.addendum.affectedSections));
  }
  cover.push(new Paragraph({ children: [new PageBreak()] }));
  return cover;
}

/**
 * Build the manual front matter: a centered cover (project name + optional
 * description, the name styled by the template's `part` rule so the cover
 * reflects the chosen template) followed by a Word TOC field. The TOC field
 * draws its entries from the Heading1 section titles; Word computes them and the
 * pagination on open — SpecR asserts the structure, not the page numbers.
 */
export function buildFrontMatter(meta: ManualMeta, styleRules?: readonly StyleRule[]): FileChild[] {
  const rules = styleRules !== undefined ? buildRuleMap(styleRules) : undefined;
  // The TOC title is deliberately NOT styled Heading1: the TOC field collects
  // Heading1 paragraphs (\o "1-1"), so a Heading1 title would list itself as an
  // entry, breaking the one-entry-per-section contract. Center + bold gives it
  // heading-like prominence without entering the document outline.
  const tocHeading = new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: TOC_TITLE, bold: true })],
  });
  const toc = new TableOfContents(TOC_TITLE, {
    hyperlink: true,
    headingStyleRange: TOC_HEADING_RANGE,
  });
  return [
    ...coverParagraphs(meta, rules),
    tocHeading,
    toc,
    new Paragraph({ children: [new PageBreak()] }),
  ];
}
