import type {
  ConventionRules,
  Editability,
  SourceChoiceTokenFact,
  SourceColorFact,
  SourceFacts,
  SpecNode,
  SpecTree,
} from '../ast/index.js';
import type { ClassificationEvidence, ClassifyResult, ParagraphClassification } from './types.js';

/**
 * Pure editability classification (ADR-022 D4). Maps each paragraph's persisted
 * `meta.sourceFacts` + a convention profile to one of the closed four values
 * (`locked | editable | choice | note`) with confidence and rule/fact-referencing
 * evidence. Deterministic and side-effect-free: same `(tree, rules)` always yields
 * deep-equal output, re-runnable forever without the source document.
 *
 * Precedence when signals conflict (highest first), per ADR-022 D1 / issue O-6:
 *   0. body-object — `object`/`objectText` nodes (#300, ADR-072 D2) are fixed
 *      to `locked`/`editable` respectively, never derived from sourceFacts
 *   1. note   — banner fact or a `noteBanners` regex match on the text
 *   2. note/… — comment policy (`comments.treatAs`) when comments are present
 *   3. choice — a choice-token candidate whose `kind` the profile enables
 *   4. color  — highest-coverage run color with a `colorMeanings` entry
 *   5. default — `defaultEditability` (and `locked` when unset)
 */
export function classify(tree: SpecTree, rules: ConventionRules): ClassifyResult {
  const out: ParagraphClassification[] = [];
  // Compile the rule lookups once here, not per node — a large tree would
  // otherwise recompile regexes and rebuild Set/Map structures thousands of times.
  const compiled = compileRules(rules);
  for (const part of tree.parts) collectNode(part, rules, compiled, out);
  return out;
}

// Per-classify lookups derived from the rule profile, built once and reused
// across every node so each rung is a cheap lookup rather than a rescan.
interface CompiledRules {
  readonly noteBanners: readonly (RegExp | null)[];
  readonly enabledChoiceKinds: ReadonlySet<SourceChoiceTokenFact['kind']>;
  readonly colorMeanings: ReadonlyMap<string, Editability>;
}

function compileRules(rules: ConventionRules): CompiledRules {
  return {
    noteBanners: compilePatterns(rules.noteBanners),
    enabledChoiceKinds: new Set((rules.choiceTokens ?? []).map((t) => t.kind)),
    colorMeanings: buildColorMeanings(rules.colorMeanings),
  };
}

// First mapping for a color wins, matching the prior `Array.find` semantics.
function buildColorMeanings(
  meanings: ConventionRules['colorMeanings']
): ReadonlyMap<string, Editability> {
  const map = new Map<string, Editability>();
  for (const m of meanings ?? []) if (!map.has(m.color)) map.set(m.color, m.meaning);
  return map;
}

// Pre-order walk: a node is classified before its children (document order).
function collectNode(
  node: SpecNode,
  rules: ConventionRules,
  compiled: CompiledRules,
  out: ParagraphClassification[]
): void {
  out.push(classifyNode(node, rules, compiled));
  for (const child of node.children) collectNode(child, rules, compiled, out);
}

/** Verdict for one node: first matching rung wins; default closes the ladder. */
function classifyNode(
  node: SpecNode,
  rules: ConventionRules,
  compiled: CompiledRules
): ParagraphClassification {
  const facts: SourceFacts = node.meta.sourceFacts ?? {};
  const verdict =
    objectFixationRung(node.type) ??
    noteRung(node.text, facts, compiled.noteBanners) ??
    commentRung(facts, rules) ??
    choiceRung(facts, compiled.enabledChoiceKinds) ??
    colorRung(facts, compiled.colorMeanings) ??
    defaultRung(rules);
  return { nodeId: node.id, ...verdict };
}

// At least one evidence entry — every rung records why it fired, so the
// public `ParagraphClassification.evidence` contract ("never empty") holds.
type Evidence = readonly [ClassificationEvidence, ...ClassificationEvidence[]];

interface RungVerdict {
  readonly editability: Editability;
  readonly confidence: number;
  readonly evidence: Evidence;
}

// ── Rung 0: body-object fixation (#300, ADR-072 decision 2) ───────────────────
// `object`/`objectText` editability is fixed at capture time, never derived by
// classification: an `object` holds an opaque, un-editable OOXML blob (always
// `locked`); its `objectText` children are exactly the interior paragraph text
// an editor may redline (always `editable`). This rung runs FIRST and
// short-circuits the entire ladder — body-object-attach.ts never populates
// meta.sourceFacts on these node types, so nothing below it could fire anyway,
// but skipping the ladder entirely (rather than merely outranking it) keeps
// the invariant true regardless of what a future signal-capture pass adds.

function objectFixationRung(type: SpecNode['type']): RungVerdict | null {
  if (type === 'object') return fixed('locked');
  if (type === 'objectText') return fixed('editable');
  return null;
}

function fixed(editability: Editability): RungVerdict {
  return { editability, confidence: 1, evidence: [{ rule: 'body-object' }] };
}

// ── Rung 1: note ──────────────────────────────────────────────────────────────
// A captured banner fact is the strongest signal; otherwise a profile noteBanners
// regex matched against the paragraph text. Banner facts/text are why a paragraph
// is a specifier note regardless of any color it also carries (AC: banner wins).

function noteRung(
  text: string,
  facts: SourceFacts,
  noteBanners: readonly (RegExp | null)[]
): RungVerdict | null {
  if (typeof facts.banner === 'string') {
    return note(1, [{ rule: 'banner', fact: 'banner' }]);
  }
  const index = matchNoteBanner(text, noteBanners);
  if (index !== null) {
    return note(0.9, [{ rule: `noteBanners[${index}]` }]);
  }
  return null;
}

function note(confidence: number, evidence: Evidence): RungVerdict {
  return { editability: 'note', confidence, evidence };
}

// Compiles each noteBanners source once. Invalid regex sources become `null`
// holes — kept (not filtered) so an index into this array still lines up with
// the original `rules.noteBanners[i]` that the evidence references. Invalid
// sources are bounded/validated at the CRUD write boundary per ADR-022 D5;
// here we stay pure and never throw.
function compilePatterns(patterns: readonly string[] | undefined): readonly (RegExp | null)[] {
  if (patterns === undefined) return [];
  return patterns.map((source) => tryCompile(source));
}

// Returns the index of the first compiled noteBanners pattern that matches, or
// null. Null holes (invalid sources) are skipped.
function matchNoteBanner(text: string, patterns: readonly (RegExp | null)[]): number | null {
  for (let i = 0; i < patterns.length; i++) {
    const compiled = patterns[i];
    if (compiled != null && compiled.test(text)) return i;
  }
  return null;
}

function tryCompile(source: string | undefined): RegExp | null {
  if (source === undefined) return null;
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

// ── Rung 2: comment policy ────────────────────────────────────────────────────

function commentRung(facts: SourceFacts, rules: ConventionRules): RungVerdict | null {
  const policy = rules.comments;
  if (policy === undefined) return null;
  if (facts.comments === undefined || facts.comments.length === 0) return null;
  return {
    editability: policy.treatAs,
    confidence: 0.9,
    evidence: [{ rule: 'comments', fact: 'comments[0]' }],
  };
}

// ── Rung 3: choice tokens ─────────────────────────────────────────────────────
// A choice-token candidate only means "choice" when the profile enables its kind
// (AC). Confidence is fixed: presence of an enabled token is a binary signal.

function choiceRung(
  facts: SourceFacts,
  enabled: ReadonlySet<SourceChoiceTokenFact['kind']>
): RungVerdict | null {
  if (enabled.size === 0 || facts.choiceTokens === undefined) return null;
  const hit = findEnabledToken(facts.choiceTokens, enabled);
  if (hit === null) return null;
  return {
    editability: 'choice',
    confidence: 0.85,
    evidence: [{ rule: `choiceTokens[${hit.token.kind}]`, fact: `choiceTokens[${hit.index}]` }],
  };
}

function findEnabledToken(
  tokens: readonly SourceChoiceTokenFact[],
  enabled: ReadonlySet<SourceChoiceTokenFact['kind']>
): { readonly token: SourceChoiceTokenFact; readonly index: number } | null {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token !== undefined && enabled.has(token.kind)) return { token, index: i };
  }
  return null;
}

// ── Rung 4: color meanings ────────────────────────────────────────────────────
// The highest-coverage run color that has a colorMeanings entry decides; a color
// without a mapped meaning does NOT fire this rung (AC — it falls through to
// default). Confidence scales with that color's coverage (full vs sparse).

function colorRung(
  facts: SourceFacts,
  meanings: ReadonlyMap<string, Editability>
): RungVerdict | null {
  if (meanings.size === 0 || facts.colors === undefined) return null;
  const best = bestMappedColor(facts.colors, meanings);
  if (best === null) return null;
  return {
    editability: best.meaning,
    confidence: clampConfidence(best.color.coverage),
    evidence: [{ rule: `colorMeanings[${best.color.color}]`, fact: `colors[${best.index}]` }],
  };
}

interface MappedColor {
  readonly color: SourceColorFact;
  readonly index: number;
  readonly meaning: Editability;
}

// The mapped color with the greatest coverage; ties resolve to first occurrence.
function bestMappedColor(
  colors: readonly SourceColorFact[],
  meanings: ReadonlyMap<string, Editability>
): MappedColor | null {
  let best: MappedColor | null = null;
  for (let i = 0; i < colors.length; i++) {
    const color = colors[i];
    if (color === undefined) continue;
    const meaning = meanings.get(color.color);
    if (meaning === undefined) continue;
    if (best === null || color.coverage > best.color.coverage) {
      best = { color, index: i, meaning };
    }
  }
  return best;
}

// ── Rung 5: default ───────────────────────────────────────────────────────────

function defaultRung(rules: ConventionRules): RungVerdict {
  const editability: Editability = rules.defaultEditability ?? 'locked';
  return {
    editability,
    confidence: 0.3,
    evidence: [{ rule: 'defaultEditability', detail: 'no higher-precedence signal fired' }],
  };
}

// Coverage is a 0..1 share; keep confidence in the same band, clamped defensively
// since source_facts is an open/untrusted schema (ADR-022 D5).
function clampConfidence(coverage: number): number {
  if (!Number.isFinite(coverage)) return 0.3;
  return Math.min(1, Math.max(0, coverage));
}
