import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { buildNumberingMap, emptyNumberingMap, withArticleIlvl } from './numbering.js';
import { buildStyleMap } from './styles.js';
import { parseDocument } from './document.js';
import { classifyParagraphs, buildTree, auditTreeStructure } from './inference.js';
import type { SpecTree, StyleProperties } from '../../ast/types.js';
import type { NumberingMap, StyleMap, ClassifiedParagraph } from './types.js';
import { resolveStyleCascade } from './resolver.js';
import { normalizeSectionNumber } from '../../lib/section-number.js';

// SECURITY (issue #19): add uncompressed size check after JSZip.loadAsync —
// reject if total uncompressed bytes > 50MB to prevent ZIP bomb exhaustion.

type Source = 'arcat' | 'cpi' | 'unknown';

const coreParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

function parseCoreMetadata(xml: string): { section: string; title: string } {
  try {
    const parsed = coreParser.parse(xml) as Record<string, unknown>;
    const props = parsed['cp:coreProperties'] as Record<string, unknown> | undefined;
    const subject = props?.['dc:subject'];
    const titleVal = props?.['dc:title'];
    // dc:subject is free-text in Word — normalize so non-conforming values degrade
    // to 'unknown' and the orchestrator's content inference takes over (instead of
    // leaking prose downstream where the worker section-gate would kill the job).
    const section =
      typeof subject === 'string' ? (normalizeSectionNumber(subject) ?? 'unknown') : 'unknown';
    return {
      section,
      title: typeof titleVal === 'string' && titleVal.trim() ? titleVal.trim() : 'unknown',
    };
  } catch {
    return { section: 'unknown', title: 'unknown' };
  }
}

// Detect spec source from style names.
// ARCAT: every file embeds ARCAT-prefixed styles (ARCATPart, ARCATArticle, …).
// CPI v1 (older): uses generic Word styles — Heading1 for PART lines, no vendor prefix.
// CPI v2 (newer): uses short-form CPI styles — PRT, ART, PR1, PR2, … with numPr in styles.xml.
function detectSource(styleMap: StyleMap): Source {
  if ([...styleMap.styles.keys()].some((id) => id.startsWith('ARCAT'))) return 'arcat';
  // CPI v2: vendor-specific PRT + ART styles (not present in generic Word templates)
  if (styleMap.styles.has('ART') && styleMap.styles.has('PRT')) return 'cpi';
  return 'unknown';
}

// Detect articleIlvl using StyleMap first, then numbering.xml as fallback.
// ARCAT: ARCATArticle style has numPr ilvl=1 → articleIlvl=1.
// CPI v2: ART style has numPr ilvl=3 → articleIlvl=3.
// Fallback: numbering.xml detectArticleIlvl (SCHEDULE/PDS lvlText heuristic).
function detectArticleIlvl(styleMap: StyleMap, numberingMap: NumberingMap): number {
  const artStyle = styleMap.resolvedNumPr.get('ART') ?? styleMap.resolvedNumPr.get('ARCATArticle');
  if (artStyle) return artStyle.ilvl;
  // Fall back to numbering.xml detection (SCHEDULE/PDS lvlText heuristic)
  return numberingMap.articleIlvl;
}

async function extractEntries(zip: JSZip): Promise<{
  numberingXml: string | null;
  stylesXml: string | null;
  documentXml: string | null;
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
  const [numberingXml, stylesXml, documentXml, coreXml, themeXml] = await Promise.all([
    read('word/numbering.xml'),
    read('word/styles.xml'),
    read('word/document.xml'),
    read('docProps/core.xml'),
    read('word/theme/theme1.xml'),
  ]);
  return { numberingXml, stylesXml, documentXml, coreXml, themeXml };
}

interface ValidEntries {
  readonly numberingXml: string | null;
  readonly stylesXml: string;
  readonly documentXml: string;
  readonly coreXml: string | null;
}

function runPipeline(
  entries: ValidEntries,
  onProgress?: (stage: string, pct: number) => void
): SpecTree {
  // Override articleIlvl now that StyleMap is available — numbering.xml alone cannot
  // distinguish CPI-v2 (ART at ilvl=3) from ARCAT (article at ilvl=1).
  const { classified, styleMap } = buildClassification(entries, onProgress);

  const source = detectSource(styleMap);
  // Section/title from core.xml only; when absent, the parse() orchestrator's
  // inferSectionMeta (lib/infer-section.ts) recovers them from tree content
  // with method/confidence reporting — do not duplicate that here.
  const meta = entries.coreXml
    ? parseCoreMetadata(entries.coreXml)
    : { section: 'unknown', title: 'unknown' };

  onProgress?.('complete', 100);
  const tree = buildTree(classified, meta.section, meta.title, source);
  const warnings = auditTreeStructure(tree.parts);
  return warnings.length > 0 ? { ...tree, warnings } : tree;
}

// ─── Internal classification helper ──────────────────────────────────────────

interface Classification {
  readonly classified: readonly ClassifiedParagraph[];
  // styleMap is consumed by runPipeline (detectSource); analyzeDocxStyles
  // ignores it — effective styles come from resolveStyleCascade instead.
  readonly styleMap: StyleMap;
}

function buildClassification(
  entries: {
    readonly numberingXml: string | null;
    readonly stylesXml: string;
    readonly documentXml: string;
  },
  onProgress?: (stage: string, pct: number) => void
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
  const paragraphs = parseDocument(entries.documentXml, resolvedNumberingMap);

  if (paragraphs.length === 0) {
    throw new ParserError('document contains no paragraphs');
  }

  onProgress?.('classifying', 75);
  return {
    classified: classifyParagraphs(paragraphs, resolvedNumberingMap, styleMap),
    styleMap,
  };
}

// ─── Public exports ───────────────────────────────────────────────────────────

export { assertDocxSafe } from './safety.js';
export { resolveStyleCascade } from './resolver.js';
export type { ClassifiedParagraph } from './types.js';
export { deriveTemplate } from './derive-template.js';
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
    throw new ParserError('failed to read DOCX archive', { cause: err });
  }
  const { numberingXml, stylesXml, documentXml, themeXml } = await extractEntries(zip);
  if (!stylesXml) throw new ParserError('DOCX missing word/styles.xml');
  if (!documentXml) throw new ParserError('DOCX missing word/document.xml');
  const { classified } = buildClassification({ numberingXml, stylesXml, documentXml });
  return {
    classified,
    effectiveStyles: resolveStyleCascade(stylesXml, numberingXml, themeXml),
  };
}

export async function parseDocx(
  buffer: Buffer,
  onProgress?: (stage: string, pct: number) => void
): Promise<SpecTree> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    throw new ParserError('failed to read DOCX archive', { cause: err });
  }

  onProgress?.('extracting', 10);
  const { numberingXml, stylesXml, documentXml, coreXml } = await extractEntries(zip);

  if (!stylesXml) throw new ParserError('DOCX missing word/styles.xml');
  if (!documentXml) throw new ParserError('DOCX missing word/document.xml');

  return runPipeline({ numberingXml, stylesXml, documentXml, coreXml }, onProgress);
}
