import { deriveArticleRole, normalizeArticleTitle, type ArticleRole } from '../ast/index.js';

export interface GeneralRequirementScopeSpec {
  readonly specId: string;
  readonly section: string;
}

export interface GeneralRequirementArticle extends GeneralRequirementScopeSpec {
  readonly paragraphId: string;
  readonly title: string;
  readonly partNumber: number;
}

export interface GeneralRequirementDuplicatedFinding {
  readonly type: 'general_requirement_duplicated';
  readonly sourceSpecId: string;
  readonly sourceSpecSection: string;
  readonly sourceParagraphId: string;
  readonly sourceArticleTitle: string;
  readonly authoritySpecId: string;
  readonly authoritySpecSection: string;
  readonly authorityParagraphId: string;
  readonly authorityArticleTitle: string;
  readonly authorityKind: 'division_00_01' | 'division_umbrella';
  readonly matchBasis: 'article_role' | 'normalized_title';
  readonly matchedValue: string;
}

export interface GeneralRequirementDuplicationResult {
  readonly findings: readonly GeneralRequirementDuplicatedFinding[];
  readonly notes: readonly string[];
}

interface AuthorityArticle {
  readonly article: GeneralRequirementArticle;
  readonly kind: GeneralRequirementDuplicatedFinding['authorityKind'];
}

interface Match {
  readonly basis: GeneralRequirementDuplicatedFinding['matchBasis'];
  readonly value: string;
}

const POINTER_ROLES: ReadonlySet<ArticleRole> = new Set(['references', 'related-sections']);
const NO_DIVISION_GENERAL_NOTE =
  'general-requirement duplicate check skipped Division 00/01 comparison: no Division 00/01 specs in scope';

function divisionOf(section: string): string | null {
  return /^(\d{2}) /.exec(section)?.[1] ?? null;
}

function umbrellaSection(division: string): string {
  return `${division} 00 00`;
}

function isDivisionGeneral(section: string): boolean {
  const division = divisionOf(section);
  return division === '00' || division === '01';
}

function isUmbrella(section: string): boolean {
  const division = divisionOf(section);
  return division !== null && section === umbrellaSection(division);
}

function isTechnical(spec: GeneralRequirementScopeSpec): boolean {
  return (
    divisionOf(spec.section) !== null &&
    !isDivisionGeneral(spec.section) &&
    !isUmbrella(spec.section)
  );
}

function articleMatch(
  source: GeneralRequirementArticle,
  authority: GeneralRequirementArticle
): Match | null {
  const sourceRole = deriveArticleRole(source.title);
  const authorityRole = deriveArticleRole(authority.title);
  if (
    (sourceRole !== undefined && POINTER_ROLES.has(sourceRole)) ||
    (authorityRole !== undefined && POINTER_ROLES.has(authorityRole))
  ) {
    return null;
  }
  if (sourceRole !== undefined && sourceRole === authorityRole) {
    return { basis: 'article_role', value: sourceRole };
  }
  const sourceTitle = normalizeArticleTitle(source.title);
  return sourceTitle !== '' && sourceTitle === normalizeArticleTitle(authority.title)
    ? { basis: 'normalized_title', value: sourceTitle }
    : null;
}

function toFinding(
  source: GeneralRequirementArticle,
  authority: AuthorityArticle,
  match: Match
): GeneralRequirementDuplicatedFinding {
  return {
    type: 'general_requirement_duplicated',
    sourceSpecId: source.specId,
    sourceSpecSection: source.section,
    sourceParagraphId: source.paragraphId,
    sourceArticleTitle: source.title,
    authoritySpecId: authority.article.specId,
    authoritySpecSection: authority.article.section,
    authorityParagraphId: authority.article.paragraphId,
    authorityArticleTitle: authority.article.title,
    authorityKind: authority.kind,
    matchBasis: match.basis,
    matchedValue: match.value,
  };
}

function authoritiesFor(
  source: GeneralRequirementArticle,
  articles: readonly GeneralRequirementArticle[]
): readonly AuthorityArticle[] {
  const division = divisionOf(source.section);
  if (division === null) return [];
  const umbrella = umbrellaSection(division);
  return articles.flatMap<AuthorityArticle>((article) => {
    if (isDivisionGeneral(article.section)) {
      return [{ article, kind: 'division_00_01' as const }];
    }
    return article.section === umbrella ? [{ article, kind: 'division_umbrella' as const }] : [];
  });
}

function buildNotes(
  scope: readonly GeneralRequirementScopeSpec[],
  technical: readonly GeneralRequirementScopeSpec[]
): readonly string[] {
  if (technical.length === 0) return [];
  const sections = new Set(scope.map((spec) => spec.section));
  const missingUmbrellas = [
    ...new Set(
      technical.flatMap((spec) => {
        const division = divisionOf(spec.section);
        const umbrella = division === null ? null : umbrellaSection(division);
        return umbrella === null || sections.has(umbrella) ? [] : [umbrella];
      })
    ),
  ].sort((a, b) => a.localeCompare(b));
  return [
    ...(scope.some((spec) => isDivisionGeneral(spec.section)) ? [] : [NO_DIVISION_GENERAL_NOTE]),
    ...(missingUmbrellas.length === 0
      ? []
      : [
          `general-requirement duplicate check skipped umbrella comparison for absent sections: ${missingUmbrellas.join(', ')}`,
        ]),
  ];
}

function orderedUniqueFindings(
  findings: readonly GeneralRequirementDuplicatedFinding[]
): readonly GeneralRequirementDuplicatedFinding[] {
  const unique = new Map<string, GeneralRequirementDuplicatedFinding>();
  for (const finding of findings) {
    unique.set(`${finding.sourceParagraphId}:${finding.authorityParagraphId}`, finding);
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = `${left.sourceSpecSection}:${left.sourceParagraphId}:${left.authoritySpecSection}:${left.authorityParagraphId}`;
    const rightKey = `${right.sourceSpecSection}:${right.sourceParagraphId}:${right.authoritySpecSection}:${right.authorityParagraphId}`;
    return leftKey.localeCompare(rightKey);
  });
}

export function buildGeneralRequirementDuplication(
  scope: readonly GeneralRequirementScopeSpec[],
  articles: readonly GeneralRequirementArticle[]
): GeneralRequirementDuplicationResult {
  const technical = scope.filter(isTechnical);
  const technicalIds = new Set(technical.map((spec) => spec.specId));
  const partOneArticles = articles.filter((article) => article.partNumber === 1);
  const findings = partOneArticles.flatMap((source) => {
    if (!technicalIds.has(source.specId)) return [];
    return authoritiesFor(source, partOneArticles).flatMap((authority) => {
      const match = articleMatch(source, authority.article);
      return match === null ? [] : [toFinding(source, authority, match)];
    });
  });
  return { findings: orderedUniqueFindings(findings), notes: buildNotes(scope, technical) };
}
