import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { ParserError } from '../error.js';
import { buildNumberingMap, emptyNumberingMap } from './numbering.js';
import { buildStyleMap } from './styles.js';
import { parseDocument } from './document.js';
import { classifyParagraphs, buildTree } from './inference.js';
import type { CsiTree } from '../../ast/types.js';
import type { NumberingMap, StyleMap } from './types.js';

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
    return {
      section: typeof subject === 'string' && subject.trim() ? subject.trim() : 'unknown',
      title: typeof titleVal === 'string' && titleVal.trim() ? titleVal.trim() : 'unknown',
    };
  } catch {
    return { section: 'unknown', title: 'unknown' };
  }
}

// Detect spec source from style names — ARCAT embeds ARCAT-prefixed styles in every file.
// CPI files use generic styles (Heading1, etc.) with no vendor prefix.
// articleIlvl is not reliable for CPI detection since CPI numbering.xml carries no
// pStyle links or Schedule/PDS lvlText markers in the actual fixture files.
function detectSource(styleMap: StyleMap): Source {
  const hasArcatStyle = [...styleMap.styles.keys()].some((id) => id.startsWith('ARCAT'));
  if (hasArcatStyle) return 'arcat';
  // CPI: detect by Heading1 presence (used for PART lines) combined with absence of ARCAT styles.
  // Future: add CPI-specific style fingerprint if other vendors also use Heading1.
  const hasHeading1 = styleMap.styles.has('Heading1');
  if (hasHeading1) return 'cpi';
  return 'unknown';
}

async function extractEntries(zip: JSZip): Promise<{
  numberingXml: string | null;
  stylesXml: string | null;
  documentXml: string | null;
  coreXml: string | null;
}> {
  const read = async (name: string): Promise<string | null> => {
    const file = zip.file(name);
    return file ? file.async('string') : null;
  };
  const [numberingXml, stylesXml, documentXml, coreXml] = await Promise.all([
    read('word/numbering.xml'),
    read('word/styles.xml'),
    read('word/document.xml'),
    read('docProps/core.xml'),
  ]);
  return { numberingXml, stylesXml, documentXml, coreXml };
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
): CsiTree {
  onProgress?.('numbering', 25);
  const numberingMap = entries.numberingXml
    ? buildNumberingMap(entries.numberingXml)
    : emptyNumberingMap();

  onProgress?.('styles', 40);
  const styleMap = buildStyleMap(entries.stylesXml);

  onProgress?.('document', 55);
  const paragraphs = parseDocument(entries.documentXml, numberingMap);

  if (paragraphs.length === 0) {
    throw new ParserError('document contains no paragraphs');
  }

  onProgress?.('classifying', 75);
  const classified = classifyParagraphs(paragraphs, numberingMap, styleMap);

  const source = detectSource(styleMap);
  const meta = entries.coreXml
    ? parseCoreMetadata(entries.coreXml)
    : { section: 'unknown', title: 'unknown' };

  onProgress?.('complete', 100);
  return buildTree(classified, meta.section, meta.title, source);
}

export async function parseDocx(
  buffer: Buffer,
  onProgress?: (stage: string, pct: number) => void
): Promise<CsiTree> {
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
