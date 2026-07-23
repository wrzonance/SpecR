import JSZip from 'jszip';
import { ParserError } from '../error.js';
import { buildNumberingMap, emptyNumberingMap, withArticleIlvl } from './numbering.js';
import { buildStyleMap } from './styles.js';
import { parseDocument } from './document.js';
import { parseCommentsXml } from './comments.js';
import type { DocxComment } from './comments.js';
import { classifyParagraphs, buildTree, auditTreeStructure } from './inference.js';
import { nestLeadInSublists } from './lead-in-nesting.js';
import { extractTables } from './tables.js';
import { captureBodyObjectsForTree } from './body-object-attach.js';
import {
  applyNumberingProfile,
  mergeProfileConflicts,
  extractNumberingProfile,
} from './numbering-profile.js';
import type { ParseWarning, RetainedTable, SpecTree, StyleProperties } from '../../ast/types.js';
import type { NumberingProfile } from '../../ast/index.js';
import type { NumberingMap, StyleMap, ClassifiedParagraph, DocxParagraph } from './types.js';
import { resolveStyleCascade } from './resolver.js';
import { detectSource, detectArticleIlvl } from './source-detection.js';
import { parseCoreMetadata, UNKNOWN_SECTION_IDENTITY } from './core-metadata.js';
import type { CoreMetadata } from './core-metadata.js';
import { captureHeaderFooter } from './header-footer.js';
import type { HeaderFooterCaptureResult } from './header-footer.js';
import { readHeaderFooterParts } from './header-footer-parts.js';
import { readHeaderFooterMedia } from './header-footer-media-parts.js';
import type { HeaderFooterMediaByPart } from './header-footer-media-parts.js';

// SECURITY (issue #19): add uncompressed size check after JSZip.loadAsync —
// reject if total uncompressed bytes > 50MB to prevent ZIP bomb exhaustion.

interface ExtractedEntries {
  readonly numberingXml: string | null;
  readonly stylesXml: string | null;
  readonly documentXml: string | null;
  readonly commentsXml: string | null;
  readonly coreXml: string | null;
  readonly themeXml: string | null;
  readonly settingsXml: string | null;
  readonly documentRelsXml: string | null;
  readonly headerParts: ReadonlyMap<string, string>;
  readonly footerParts: ReadonlyMap<string, string>;
  readonly mediaByPart: HeaderFooterMediaByPart;
}

async function extractEntries(zip: JSZip): Promise<ExtractedEntries> {
  const read = async (name: string): Promise<string | null> => {
    const file = zip.file(name);
    return file ? file.async('string') : null;
  };
  // NOTE: Strict discovery of the theme part should follow the officeDocument→theme
  // relationship in word/_rels/document.xml.rels; reading theme1.xml by convention
  // is an adequate approximation for spec-import use-cases.
  const [textParts, headerFooterParts, mediaByPart] = await Promise.all([
    Promise.all([
      read('word/numbering.xml'),
      read('word/styles.xml'),
      read('word/document.xml'),
      read('word/comments.xml'),
      read('docProps/core.xml'),
      read('word/theme/theme1.xml'),
      read('word/settings.xml'),
      read('word/_rels/document.xml.rels'),
    ]),
    readHeaderFooterParts(zip), // #306: word/header*.xml, word/footer*.xml glob-read
    readHeaderFooterMedia(zip), // #487: eagerly-resolved header/footer image media bytes
  ]);
  const [
    numberingXml,
    stylesXml,
    documentXml,
    commentsXml,
    coreXml,
    themeXml,
    settingsXml,
    documentRelsXml,
  ] = textParts;
  return {
    numberingXml,
    stylesXml,
    documentXml,
    commentsXml,
    coreXml,
    themeXml,
    settingsXml,
    documentRelsXml,
    headerParts: headerFooterParts.headerParts,
    footerParts: headerFooterParts.footerParts,
    mediaByPart,
  };
}

interface ValidEntries {
  readonly numberingXml: string | null;
  readonly stylesXml: string;
  readonly documentXml: string;
  readonly commentsXml: string | null;
  readonly coreXml: string | null;
  readonly settingsXml: string | null;
  readonly documentRelsXml: string | null;
  readonly headerParts: ReadonlyMap<string, string>;
  readonly footerParts: ReadonlyMap<string, string>;
  readonly mediaByPart: HeaderFooterMediaByPart;
}

// Visible tables are counted only and surfaced as a warning (#293) — the tree-level
// `object` capture above models a table's CONTENT; this legacy scan only reports that
// one exists, so it stays a separate, un-deduped warning source (ADR-038 hidden/visible
// split untouched).
function visibleTableWarning(visibleCount: number): ParseWarning | undefined {
  return visibleCount > 0
    ? {
        type: 'table-content-skipped',
        suggestion: `${visibleCount} visible table(s) detected but not yet modeled into the spec tree`,
      }
    : undefined;
}

// Composes the optional tree fields that each fire independently of one
// another — a doc can carry w:pgSz with zero header/footer content, hidden
// tables with no warnings, etc. — so each is spread conditionally in turn
// rather than assuming any one implies another.
function assembleTree(
  tree: SpecTree,
  warnings: readonly ParseWarning[],
  hiddenTables: readonly RetainedTable[],
  hf: HeaderFooterCaptureResult
): SpecTree {
  const withWarnings = warnings.length > 0 ? { ...tree, warnings } : tree;
  const withHiddenTables =
    hiddenTables.length > 0 ? { ...withWarnings, hiddenTables } : withWarnings;
  const withHeaderFooter = hf.composition
    ? { ...withHiddenTables, headerFooter: hf.composition }
    : withHiddenTables;
  return hf.pageSize !== undefined
    ? { ...withHeaderFooter, pageSize: hf.pageSize }
    : withHeaderFooter;
}

function runPipeline(
  entries: ValidEntries,
  onProgress?: (stage: string, pct: number) => void,
  numberingProfile?: NumberingProfile
): SpecTree {
  // Recompute articleIlvl now that the StyleMap is available — numbering.xml alone
  // cannot tell an article declared at ilvl 1 from one declared deeper (low levels
  // reserved); the article style's own numPr disambiguates.
  const { classified, styleMap } = buildClassification(entries, onProgress, numberingProfile);

  const source = detectSource(styleMap);
  // Section/title from core.xml only; when absent, the parse() orchestrator's
  // inferSectionMeta (lib/infer-section.ts) recovers them from tree content
  // with method/confidence reporting — do not duplicate that here.
  const meta: CoreMetadata = entries.coreXml
    ? parseCoreMetadata(entries.coreXml)
    : { section: UNKNOWN_SECTION_IDENTITY, title: UNKNOWN_SECTION_IDENTITY };

  // Body object capture (#300, ADR-072): a separate preserveOrder pass over the same
  // document.xml, independent of the paragraph walk above — captures every body-level
  // table/text box as an `object` SpecNode (with `objectText` children) and supplies
  // buildTree's attachment points below, so tree assembly places each object exactly
  // where it sits in document order.
  const bodyObjects = captureBodyObjectsForTree(entries.documentXml, styleMap);

  onProgress?.('complete', 100);
  const tree = buildTree(
    classified,
    meta.section,
    meta.title,
    source,
    bodyObjects.objectsBeforeFirst,
    bodyObjects.objectsByPrecedingIndex
  );
  const structuralWarnings = auditTreeStructure(tree.parts);

  // Table scan (#293): a separate pass over the same document.xml — parseDocument
  // never walks table-nested paragraphs (body['w:p'] only), so this cannot double-
  // classify anything the paragraph walk already saw. Hidden tables are retained
  // out-of-band (ADR-038); visible tables are counted only and surfaced as a warning.
  const { hiddenTables, visibleCount } = extractTables(entries.documentXml, styleMap);
  const tableWarning = visibleTableWarning(visibleCount);

  // Header/footer capture (#306, ADR-068): `known` is meta.section/meta.title
  // from parseCoreMetadata ONLY — never the content-inference fallback the
  // parse() orchestrator applies later — so a field match is always a literal
  // identity match, never a guess.
  const hf = captureHeaderFooter(
    {
      documentXml: entries.documentXml,
      settingsXml: entries.settingsXml,
      documentRelsXml: entries.documentRelsXml,
      headerParts: entries.headerParts,
      footerParts: entries.footerParts,
      mediaByPart: entries.mediaByPart,
    },
    { section: meta.section, title: meta.title }
  );

  // Each source fires at most once per parse — appended, not deduped.
  const warnings = [
    ...structuralWarnings,
    ...(meta.warning ? [meta.warning] : []),
    ...(tableWarning ? [tableWarning] : []),
    ...(bodyObjects.warning ? [bodyObjects.warning] : []),
    ...hf.warnings,
  ];
  return assembleTree(tree, warnings, hiddenTables, hf);
}

// ─── Internal classification helper ──────────────────────────────────────────

interface Classification {
  readonly classified: readonly ClassifiedParagraph[];
  // styleMap is consumed by runPipeline (detectSource); analyzeDocxStyles
  // ignores it — effective styles come from resolveStyleCascade instead.
  readonly styleMap: StyleMap;
}

function parseParagraphsOrThrow(
  documentXml: string,
  numberingMap: NumberingMap,
  styleMap: StyleMap,
  commentsById: ReadonlyMap<string, DocxComment>
): readonly DocxParagraph[] {
  const paragraphs = parseDocument(documentXml, numberingMap, styleMap, commentsById);
  if (paragraphs.length === 0) {
    throw new ParserError('document contains no paragraphs', { code: 'DOCX_NO_PARAGRAPHS' });
  }
  return paragraphs;
}

// Classify paragraphs, optionally applying a numbering profile as a deterministic
// override. Without a profile the path is byte-for-byte today's behavior. With one,
// paragraphs are parsed/classified against the overridden map (authoritative), the
// un-profiled base map classifies the same paragraphs, and per-paragraph
// disagreements are recorded as conflicts (losing signal persisted, never dropped).
export function classifyWithOptionalProfile(
  documentXml: string,
  resolvedNumberingMap: NumberingMap,
  styleMap: StyleMap,
  commentsById: ReadonlyMap<string, DocxComment>,
  numberingProfile?: NumberingProfile
): readonly ClassifiedParagraph[] {
  if (numberingProfile === undefined) {
    const paragraphs = parseParagraphsOrThrow(
      documentXml,
      resolvedNumberingMap,
      styleMap,
      commentsById
    );
    return classifyParagraphs(paragraphs, resolvedNumberingMap, styleMap);
  }
  const overridden = applyNumberingProfile(resolvedNumberingMap, numberingProfile);
  const profiledParas = parseParagraphsOrThrow(documentXml, overridden, styleMap, commentsById);
  const withProfile = classifyParagraphs(profiledParas, overridden, styleMap);
  // Parse a SECOND time against the base map before the un-profiled comparison.
  // parseParagraph resolves style-inherited numId/ilvl FROM THE MAP at parse time
  // (document.ts resolveNumPr), so a paragraph parsed under `overridden` already
  // carries the profiled numbering. Reusing those paragraphs for the base path
  // would let the "un-profiled" classification see the overridden style mapping and
  // silently agree with the profile — dropping the losing base inference from
  // meta.conflicts. A fresh parse restores the true base numbering. (#317)
  const baseParas = parseParagraphsOrThrow(
    documentXml,
    resolvedNumberingMap,
    styleMap,
    commentsById
  );
  const baseClassified = classifyParagraphs(baseParas, resolvedNumberingMap, styleMap);
  return mergeProfileConflicts(withProfile, baseClassified);
}

function buildClassification(
  entries: {
    readonly numberingXml: string | null;
    readonly stylesXml: string;
    readonly documentXml: string;
    readonly commentsXml?: string | null;
  },
  onProgress?: (stage: string, pct: number) => void,
  numberingProfile?: NumberingProfile
): Classification {
  onProgress?.('numbering', 25);
  const numberingMap = entries.numberingXml
    ? buildNumberingMap(entries.numberingXml)
    : emptyNumberingMap();

  onProgress?.('styles', 40);
  const styleMap = buildStyleMap(entries.stylesXml);

  const articleIlvl = detectArticleIlvl(styleMap, numberingMap);
  const resolvedNumberingMap = withArticleIlvl(numberingMap, articleIlvl);

  onProgress?.('document', 55);
  const commentsById = entries.commentsXml
    ? parseCommentsXml(entries.commentsXml)
    : new Map<string, DocxComment>();

  onProgress?.('classifying', 75);
  // Post-classification pass (ADR-059): promote a no-typed-label lead-in that
  // collides at its tier with a following Signal-4 restart sub-list (and any
  // stranded same-tier peer lead-in), so the sub-list nests as children and its
  // typed labels strip clean in buildTree. Applied HERE, at the shared
  // classification seam, so the parse AST and analyzeDocxStyles/deriveTemplate see
  // the SAME promoted tiers — deriving a template off unpromoted classifications
  // would emit pr2 rules for lead-ins the parser AST places at pr1 (#431 P2).
  const classified = nestLeadInSublists(
    classifyWithOptionalProfile(
      entries.documentXml,
      resolvedNumberingMap,
      styleMap,
      commentsById,
      numberingProfile
    )
  );
  return { classified, styleMap };
}

// ─── Public exports ───────────────────────────────────────────────────────────

export { assertDocxSafe } from './safety.js';
export { stripLeadingTitleBlockRoots } from './heuristics.js';
export { resolveStyleCascade } from './resolver.js';
export { scoreHierarchyConfidence } from './hierarchy-confidence.js';
export { findAnchoredParagraph, replaceAnchoredParagraphText } from './object-blob-edit.js';
export type { ClassifiedParagraph } from './types.js';
export { deriveTemplate } from './derive-template.js';
export { extractNumberingProfile };
export type {
  DerivedTemplate,
  DerivedRule,
  DerivationReport,
  NodeTypeReport,
  PropertyDecision,
} from './derive-template.js';

// ─── Style-analysis seam (WT-3 template import) ───────────────────────────────

export interface DocxStyleAnalysis {
  readonly classified: readonly ClassifiedParagraph[];
  readonly effectiveStyles: ReadonlyMap<string, StyleProperties>;
}

/**
 * Style-analysis seam for template import (WT-3): classify the document's
 * paragraphs AND resolve every paragraph style's effective StyleProperties.
 * The buffer is read once and discarded — nothing raw is persisted (ADR-021).
 */
export async function analyzeDocxStyles(buffer: Buffer): Promise<DocxStyleAnalysis> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new ParserError('failed to read DOCX archive', {
      code: 'DOCX_ARCHIVE_UNREADABLE',
      cause: err,
    });
  }
  const { numberingXml, stylesXml, documentXml, themeXml } = await extractEntries(zip);
  if (!stylesXml) {
    throw new ParserError('DOCX missing word/styles.xml', { code: 'DOCX_MISSING_STYLES' });
  }
  if (!documentXml) {
    throw new ParserError('DOCX missing word/document.xml', { code: 'DOCX_MISSING_DOCUMENT' });
  }
  const { classified } = buildClassification({ numberingXml, stylesXml, documentXml });
  return {
    classified,
    effectiveStyles: resolveStyleCascade(stylesXml, numberingXml, themeXml),
  };
}

export async function parseDocx(
  buffer: Buffer,
  onProgress?: (stage: string, pct: number) => void,
  numberingProfile?: NumberingProfile
): Promise<SpecTree> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new ParserError('failed to read DOCX archive', {
      code: 'DOCX_ARCHIVE_UNREADABLE',
      cause: err,
    });
  }

  onProgress?.('extracting', 10);
  const {
    numberingXml,
    stylesXml,
    documentXml,
    commentsXml,
    coreXml,
    settingsXml,
    documentRelsXml,
    headerParts,
    footerParts,
    mediaByPart,
  } = await extractEntries(zip);

  if (!stylesXml) {
    throw new ParserError('DOCX missing word/styles.xml', { code: 'DOCX_MISSING_STYLES' });
  }
  if (!documentXml) {
    throw new ParserError('DOCX missing word/document.xml', { code: 'DOCX_MISSING_DOCUMENT' });
  }

  return runPipeline(
    {
      numberingXml,
      stylesXml,
      documentXml,
      commentsXml,
      coreXml,
      settingsXml,
      documentRelsXml,
      headerParts,
      footerParts,
      mediaByPart,
    },
    onProgress,
    numberingProfile
  );
}

/**
 * Extract a NumberingProfile from a raw DOCX buffer without parsing the
 * full spec tree. Used by the snapshot REST endpoint (#299) and any caller
 * that only needs numbering metadata, not paragraphs.
 */
export async function extractNumberingProfileFromDocx(buffer: Buffer): Promise<NumberingProfile> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new ParserError('failed to read DOCX archive', {
      code: 'DOCX_ARCHIVE_UNREADABLE',
      cause: err,
    });
  }
  const { numberingXml, stylesXml } = await extractEntries(zip);
  if (!stylesXml) {
    throw new ParserError('DOCX missing word/styles.xml', { code: 'DOCX_MISSING_STYLES' });
  }
  const numberingMap = numberingXml ? buildNumberingMap(numberingXml) : emptyNumberingMap();
  const styleMap = buildStyleMap(stylesXml);
  const articleIlvl = detectArticleIlvl(styleMap, numberingMap);
  const resolvedMap = withArticleIlvl(numberingMap, articleIlvl);
  return extractNumberingProfile(resolvedMap, styleMap);
}
