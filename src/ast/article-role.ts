// Pure, deterministic CSI article-role classifier (ADR-033). Role is DERIVED
// from the article heading, never stored. One source of truth, applied at parse
// (parser/index.ts) and on read (db buildNodeTree). Tolerant of a leading CSI
// numbering prefix so it works whether or not a parser already stripped it, and
// ilvl-agnostic (the inference engine normalizes the CPI offset into
// node_type='article' before this runs).

import type { ArticleRole, SpecNode } from './types.js';

export type { ArticleRole } from './types.js';

interface ArticleRoleRule {
  readonly role: ArticleRole;
  /** Exact normalized-heading strings (uppercased, prefix-stripped) that map here. */
  readonly titles: readonly string[];
}

// Data table: canonical CSI title + documented variants. Order does not matter —
// titles are matched exactly against the normalized heading, so no rule shadows
// another. Add a role by adding one row here and one enum member in types.ts.
export const ARTICLE_ROLE_RULES: readonly ArticleRoleRule[] = [
  { role: 'summary', titles: ['SUMMARY', 'SECTION INCLUDES'] },
  {
    role: 'related-sections',
    titles: ['RELATED SECTIONS', 'RELATED REQUIREMENTS', 'RELATED WORK', 'RELATED DOCUMENTS'],
  },
  { role: 'references', titles: ['REFERENCES', 'REFERENCE STANDARDS', 'REFERENCED STANDARDS'] },
  { role: 'definitions', titles: ['DEFINITIONS'] },
  { role: 'submittals', titles: ['SUBMITTALS', 'ACTION SUBMITTALS', 'INFORMATIONAL SUBMITTALS'] },
  { role: 'quality-assurance', titles: ['QUALITY ASSURANCE'] },
  {
    role: 'delivery-storage-handling',
    titles: [
      'DELIVERY, STORAGE AND HANDLING',
      'DELIVERY, STORAGE, AND HANDLING',
      'DELIVERY STORAGE AND HANDLING',
    ],
  },
  { role: 'warranty', titles: ['WARRANTY'] },
];

const LOOKUP: ReadonlyMap<string, ArticleRole> = new Map(
  ARTICLE_ROLE_RULES.flatMap((rule) => rule.titles.map((t) => [t, rule.role] as const))
);

// Leading CSI numbering prefix: "1.1", "1.02", "1.1.1", optionally trailed by a
// separator. Stripped before lookup so "1.1 REFERENCES" === "REFERENCES".
const NUMBER_PREFIX_RE = /^\d+(?:\.\d+)*\s*[-–—.)]?\s*/;

function normalizeHeading(text: string): string {
  return text.replace(NUMBER_PREFIX_RE, '').trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Resolve a CSI article role from its heading text, or undefined if unknown. */
export function deriveArticleRole(text: string): ArticleRole | undefined {
  return LOOKUP.get(normalizeHeading(text));
}

/** Deep, immutable: set meta.articleRole on every `article` node whose heading
 *  resolves to a role. Non-article nodes (note/continuation/part/pr*) untouched. */
export function tagArticleRoles(nodes: readonly SpecNode[]): readonly SpecNode[] {
  return nodes.map((node) => {
    const children = tagArticleRoles(node.children);
    if (node.type !== 'article') {
      return children === node.children ? node : { ...node, children };
    }
    const role = deriveArticleRole(node.text);
    if (role === undefined) {
      return children === node.children ? node : { ...node, children };
    }
    return { ...node, children, meta: { ...node.meta, articleRole: role } };
  });
}
