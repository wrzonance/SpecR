import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { buildNumberingMap, emptyNumberingMap, withArticleIlvl } from './numbering.js';
import { buildStyleMap } from './styles.js';
import { parseDocument } from './document.js';
import { parseCommentsXml } from './comments.js';
import type { DocxComment } from './comments.js';
import { classifyParagraphs, buildTree, auditTreeStructure } from './inference.js';
import {
  applyNumberingProfile,
  mergeProfileConflicts,
  extractNumberingProfile,
} from './numbering-profile.js';
import type { ParseWarning, SpecTree, StyleProperties } from '../../ast/types.js';
import type { NumberingProfile } from '../../ast/index.js';
import type { NumberingMap, StyleMap, ClassifiedParagraph, DocxParagraph } from './types.js';
import { resolveStyleCascade } from './resolver.js';
import { parseSectionNumberCandidate } from '../../lib/section-number.js';

// SECURITY (issue #19): add uncompressed size check after JSZip.loadAsync —
// reject if total uncompressed bytes > 50MB to prevent ZIP bomb exhaustion.

type Source = 'arcat' | 'cpi' | 'unknown';

const coreParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

function parseCoreMetadata(xml: string): {
  section: string;
  title: string;
  warning?: ParseWarning;
} {
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
    const section = parsedSection?.ok === true ? parsedSection.canonical : 'unknown';
    return {
      section,
      title: typeof titleVal === 'string' && titleVal.trim() ? titleVal.trim() : 'unknown',
    };
  } catch {
    // Corrupt/unparseable core.xml previously degraded silently to 'unknown'.
    // Surface it as a tree warning so it flows to logs/API/MCP responses instead.
    return {
      section: 'unknown',
      title: 'unknown',
      warning: {
        type: 'core-metadata-unreadable',
        suggestion:
          'docProps/core.xml could not be parsed; section/title fell back to content inference.',
      },
    };
  }
}

// Detect spec source from style names.
// Coarse provenance tag inferred from a document's style-vocabulary fingerprint.
// ANNOTATION ONLY: surfaced as meta.source, computed after classification, and never
// read back as an inference input — structure is derived from signals, not this tag.
// The fingerprints below are two recurring authoring conventions seen in the corpus:
//   • styles sharing a common heading prefix (…Part, …Article, …)
//   • short-form PRT + ART styles carrying numPr in styles.xml (absent from the
//     generic Word templates a flat <ol> export produces)
function detectSource(styleMap: StyleMap): Source {
  if ([...styleMap.styles.keys()].some((id) => id.startsWith('ARCAT'))) return 'arcat';
  // short-form PRT + ART styles are not present in generic Word templates
  if (styleMap.styles.has('ART') && styleMap.styles.has('PRT')) return 'cpi';
  return 'unknown';
}

// The ilvl at which the article tier begins is not fixed — a document declares it
// through its own article style's numPr. Commonly ilvl 1; documents that reserve the
// low levels for a Schedule / Product-Data block start the article deeper (e.g. ilvl
// 3). Read it from the document's own article style; if no known article-style name
// is present, fall back to the numbering.xml scan.
function detectArticleIlvl(styleMap: StyleMap, numberingMap: NumberingMap): number {
  const artStyle = styleMap.resolvedNumPr.get('ART') ?? styleMap.resolvedNumPr.get('ARCATArticle');
  if (artStyle) return artStyle.ilvl;
  // Fall back to the numbering.xml scan (reserved-level lvlText heuristic).
  return numberingMap.articleIlvl;
}

async function extractEntries(zip: JSZip): Promise<{
  numberingXml: string | null;
  stylesXml: string | null;
  documentXml: string | null;
  commentsXml: string | null;
  coreXml: string | null;
  themeXml: string | null;
}> {
  const read = async (name: string): Promise<string | null> => {
    const file = zip.file(name);
    return file ? file.async('string') : null;
  };
  // NOTE: Strict discovery of the theme part should follow the officeDocument→theme
  // relationship in word/_rels/document.xml.rels; reading theme1.xml by convention
  // is an adequate approximation for spec-import use-cases.
  const [numberingXml, stylesXml, documentXml, commentsXml, coreXml, themeXml] = await Promise.all([
    read('word/numbering.xml'),
    read('word/styles.xml'),
    read('word/document.xml'),
    read('word/comments.xml'),
    read('docProps/core.xml'),
    read('word/theme/theme1.xml'),
  ]);
  return { numberingXml, stylesXml, documentXml, commentsXml, coreXml, themeXml };
}

interface ValidEntries {
  readonly numberingXml: string | null;
  readonly stylesXml: string;
  readonly documentXml: string;
  readonly commentsXml: string | null;
  readonly coreXml: string | null;
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
  const meta: { section: string; title: string; warning?: ParseWarning } = entries.coreXml
    ? parseCoreMetadata(entries.coreXml)
    : { section: 'unknown', title: 'unknown' };

  onProgress?.('complete', 100);
  const tree = buildTree(classified, meta.section, meta.title, source);
  const structuralWarnings = auditTreeStructure(tree.parts);
  // core-metadata-unreadable fires at most once per parse — appended, not deduped.
  const warnings = meta.warning ? [...structuralWarnings, meta.warning] : structuralWarnings;
  return warnings.length > 0 ? { ...tree, warnings } : tree;
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
  return {
    classified: classifyWithOptionalProfile(
      entries.documentXml,
      resolvedNumberingMap,
      styleMap,
      commentsById,
      numberingProfile
    ),
    styleMap,
  };
}

// ─── Public exports ───────────────────────────────────────────────────────────

export { assertDocxSafe } from './safety.js';
export { resolveStyleCascade } from './resolver.js';
export { scoreHierarchyConfidence } from './hierarchy-confidence.js';
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
  const { numberingXml, stylesXml, documentXml, commentsXml, coreXml } = await extractEntries(zip);

  if (!stylesXml) {
    throw new ParserError('DOCX missing word/styles.xml', { code: 'DOCX_MISSING_STYLES' });
  }
  if (!documentXml) {
    throw new ParserError('DOCX missing word/document.xml', { code: 'DOCX_MISSING_DOCUMENT' });
  }

  return runPipeline(
    { numberingXml, stylesXml, documentXml, commentsXml, coreXml },
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
