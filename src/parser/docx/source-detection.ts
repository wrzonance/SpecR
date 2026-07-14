import type { NumberingMap, StyleMap } from './types.js';

export type Source = 'arcat' | 'cpi' | 'unknown';

// Detect spec source from style names.
// Coarse provenance tag inferred from a document's style-vocabulary fingerprint.
// ANNOTATION ONLY: surfaced as meta.source, computed after classification, and never
// read back as an inference input — structure is derived from signals, not this tag.
// The fingerprints below are two recurring authoring conventions seen in the corpus:
//   • styles sharing a common heading prefix (…Part, …Article, …)
//   • short-form PRT + ART styles carrying numPr in styles.xml (absent from the
//     generic Word templates a flat <ol> export produces)
export function detectSource(styleMap: StyleMap): Source {
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
export function detectArticleIlvl(styleMap: StyleMap, numberingMap: NumberingMap): number {
  const artStyle = styleMap.resolvedNumPr.get('ART') ?? styleMap.resolvedNumPr.get('ARCATArticle');
  if (artStyle) return artStyle.ilvl;
  // Fall back to the numbering.xml scan (reserved-level lvlText heuristic).
  return numberingMap.articleIlvl;
}
