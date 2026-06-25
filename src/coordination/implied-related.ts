export interface SectionTitleEntry {
  readonly section: string;
  readonly title: string;
}

export interface TitleKeywordEntry extends SectionTitleEntry {
  readonly keywords: readonly string[];
}

export interface TitleKeywordIndex {
  readonly entries: readonly TitleKeywordEntry[];
}

export interface SourceParagraph {
  readonly id: string;
  readonly text: string;
}

export interface SourceSpecBody {
  readonly specId: string;
  readonly section: string;
  readonly relatedSections: readonly string[];
  readonly bodyCitedSections: readonly string[];
  readonly paragraphs: readonly SourceParagraph[];
}

export interface ImpliedRelatedSectionFinding {
  readonly type: 'implied_related_section';
  readonly sourceSpecId: string;
  readonly sourceSpecSection: string;
  readonly sourceParagraphId: string;
  readonly impliedSection: string;
  readonly impliedTitle: string;
  readonly matchedKeyword: string;
  readonly confidence: number;
}

interface CandidateMatch {
  readonly keyword: string;
  readonly confidence: number;
}

interface StemRule {
  readonly suffix: string;
  readonly minLength: number;
  readonly transform: (base: string) => string;
}

const MAX_KEYWORD_SECTIONS = 2;
const BASE_CONFIDENCE = 0.72;
const EXTRA_KEYWORD_CONFIDENCE = 0.08;
const MAX_CONFIDENCE = 0.92;

const STEM_RULES: readonly StemRule[] = [
  { suffix: 'ing', minLength: 6, transform: undoubleFinal },
  { suffix: 'ied', minLength: 5, transform: (base) => `${base}y` },
  { suffix: 'ed', minLength: 5, transform: undoubleFinal },
  { suffix: 'ies', minLength: 5, transform: (base) => `${base}y` },
  { suffix: 'es', minLength: 4, transform: (base) => base },
  { suffix: 's', minLength: 4, transform: (base) => base },
];

const STOP_WORDS = new Set([
  'and',
  'are',
  'basic',
  'common',
  'communications',
  'concrete',
  'conveying',
  'division',
  'documents',
  'earthwork',
  'electrical',
  'electronic',
  'equipment',
  'execution',
  'exterior',
  'finishes',
  'general',
  'hvac',
  'improvements',
  'masonry',
  'materials',
  'metals',
  'moisture',
  'openings',
  'part',
  'plumbing',
  'process',
  'product',
  'products',
  'project',
  'related',
  'requirement',
  'requirements',
  'safety',
  'section',
  'sections',
  'specialties',
  'specification',
  'specifications',
  'summary',
  'system',
  'systems',
  'the',
  'thermal',
  'transportation',
  'utilities',
  'waterway',
  'wood',
  'work',
]);

function stemToken(token: string): string {
  const rule = STEM_RULES.find((candidate) => {
    return token.length > candidate.minLength && token.endsWith(candidate.suffix);
  });
  if (rule === undefined) return token;
  return rule.transform(token.slice(0, -rule.suffix.length));
}

function undoubleFinal(token: string): string {
  const last = token.at(-1);
  const prior = token.at(-2);
  if (last === undefined || prior === undefined || last !== prior || isVowel(last)) return token;
  return token.slice(0, -1);
}

function isVowel(char: string): boolean {
  return char === 'a' || char === 'e' || char === 'i' || char === 'o' || char === 'u';
}

function normalizeToken(token: string): string | null {
  if (token.length < 4 || STOP_WORDS.has(token)) return null;
  const stemmed = stemToken(token);
  if (stemmed.length < 4 || STOP_WORDS.has(stemmed)) return null;
  return stemmed;
}

function normalizedTokens(text: string): readonly string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .map(normalizeToken)
    .filter((token): token is string => token !== null);
}

function uniqueKeywords(title: string): readonly string[] {
  return [...new Set(normalizedTokens(title))].sort((a, b) => a.localeCompare(b));
}

function countKeywords(entries: readonly TitleKeywordEntry[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    for (const keyword of entry.keywords) counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
  }
  return counts;
}

function suppressCommonKeywords(
  entries: readonly TitleKeywordEntry[],
  counts: ReadonlyMap<string, number>
): readonly TitleKeywordEntry[] {
  return entries.map((entry) => ({
    ...entry,
    keywords: entry.keywords.filter(
      (keyword) => (counts.get(keyword) ?? 0) <= MAX_KEYWORD_SECTIONS
    ),
  }));
}

export function buildTitleKeywordIndex(entries: readonly SectionTitleEntry[]): TitleKeywordIndex {
  const indexed = entries.map((entry) => ({
    ...entry,
    keywords: uniqueKeywords(entry.title),
  }));
  return { entries: suppressCommonKeywords(indexed, countKeywords(indexed)) };
}

function matchEntry(
  entry: TitleKeywordEntry,
  bodyTokens: ReadonlySet<string>
): CandidateMatch | null {
  const matched = entry.keywords.filter((keyword) => bodyTokens.has(keyword));
  const keyword = matched[0];
  if (keyword === undefined) return null;
  const confidence = Math.min(
    MAX_CONFIDENCE,
    BASE_CONFIDENCE + (matched.length - 1) * EXTRA_KEYWORD_CONFIDENCE
  );
  return { keyword, confidence: Number(confidence.toFixed(2)) };
}

function findingKey(specId: string, impliedSection: string): string {
  return `${specId}:${impliedSection}`;
}

function toFinding(
  spec: SourceSpecBody,
  paragraph: SourceParagraph,
  entry: TitleKeywordEntry,
  match: CandidateMatch
): ImpliedRelatedSectionFinding {
  return {
    type: 'implied_related_section',
    sourceSpecId: spec.specId,
    sourceSpecSection: spec.section,
    sourceParagraphId: paragraph.id,
    impliedSection: entry.section,
    impliedTitle: entry.title,
    matchedKeyword: match.keyword,
    confidence: match.confidence,
  };
}

function isSuppressed(
  spec: SourceSpecBody,
  entry: TitleKeywordEntry,
  listed: ReadonlySet<string>,
  emitted: ReadonlySet<string>
): boolean {
  return (
    entry.section === spec.section ||
    listed.has(entry.section) ||
    emitted.has(findingKey(spec.specId, entry.section))
  );
}

function findingForEntry(
  spec: SourceSpecBody,
  paragraph: SourceParagraph,
  entry: TitleKeywordEntry,
  bodyTokens: ReadonlySet<string>,
  listed: ReadonlySet<string>,
  emitted: Set<string>
): ImpliedRelatedSectionFinding | null {
  if (isSuppressed(spec, entry, listed, emitted)) return null;
  const match = matchEntry(entry, bodyTokens);
  if (match === null) return null;
  emitted.add(findingKey(spec.specId, entry.section));
  return toFinding(spec, paragraph, entry, match);
}

function findingsForParagraph(
  spec: SourceSpecBody,
  paragraph: SourceParagraph,
  catalog: TitleKeywordIndex,
  listed: ReadonlySet<string>,
  emitted: Set<string>
): readonly ImpliedRelatedSectionFinding[] {
  const bodyTokens = new Set(normalizedTokens(paragraph.text));
  return catalog.entries.flatMap((entry) => {
    const finding = findingForEntry(spec, paragraph, entry, bodyTokens, listed, emitted);
    return finding === null ? [] : [finding];
  });
}

function findingsForSpec(
  spec: SourceSpecBody,
  catalog: TitleKeywordIndex,
  emitted: Set<string>
): readonly ImpliedRelatedSectionFinding[] {
  const listed = new Set([...spec.relatedSections, ...spec.bodyCitedSections]);
  return spec.paragraphs.flatMap((paragraph) => {
    return findingsForParagraph(spec, paragraph, catalog, listed, emitted);
  });
}

export function findImpliedRelatedSections(input: {
  readonly catalog: TitleKeywordIndex;
  readonly specs: readonly SourceSpecBody[];
}): readonly ImpliedRelatedSectionFinding[] {
  const emitted = new Set<string>();
  return input.specs.flatMap((spec) => findingsForSpec(spec, input.catalog, emitted));
}
