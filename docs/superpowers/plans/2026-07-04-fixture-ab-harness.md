# Fixture A/B Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the throwaway before/after fixture-parsing harness into a committed local tool, add a note-leak invariant to the corpus test, and document the "A/B the corpus before any parser change" rule.

**Architecture:** Pure logic (banner matcher, per-fixture record builder, snapshot diff) lives under `src/` so the unit project can test it corpus-free and the integration test can share the matcher; `scripts/fixture-ab.ts` is a thin argv/IO wrapper that imports from `src/` exactly as `scripts/load-files.ts` does. Snapshots are copyright-derived → written to gitignored `.fixture-snapshots/`, never committed.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers, `verbatimModuleSyntax` → `import type` for types), Node 22 (`node:fs` `glob`/`globSync`), vitest, tsx, pnpm.

## Global Constraints

- ESM: every relative import ends in `.js`; type-only imports use `import type`.
- ESLint (enforced on `src/**` via `pnpm lint = eslint src/`): `complexity` ≤ 10, `sonarjs/cognitive-complexity` ≤ 10, `max-lines-per-function` ≤ 50, `max-lines` ≤ 400, `no-console` = error, `@typescript-eslint/no-explicit-any` = error, no non-null `!`. `scripts/**` and `src/**/*.test.ts` relax line/console caps. `scripts/` is **outside** the `eslint src/` sweep.
- TS strict + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`. Index access is `T | undefined` — guard it.
- vitest projects: unit = `src/**/*.test.ts` (excludes `*.integration.test.ts`); integration = `src/**/*.integration.test.ts`. Unit needs no DB; integration needs Postgres.
- `renderMarkdown` and `getLabel` are imported directly from `src/generator/markdown.ts` (not barrelled) — established pattern.
- Note render form is exactly `> **[NOTE]** …` (one blockquote line per note).
- Snapshot baseline is gitignored; the committed script/logic contains no corpus text.

---

## File Structure

- `src/lib/specifier-note-banner.ts` — CREATE. `containsSpecifierNoteBanner(text)`, a contains-style mirror of the two `heuristics.ts` banner patterns, in the migration-024 keep-in-sync set. Shared by the tool and the integration test.
- `src/lib/specifier-note-banner.test.ts` — CREATE. Unit tests.
- `src/lib/fixture-snapshot.ts` — CREATE. Pure `fixtureRecord()` + `diffSnapshots()`, and I/O `snapshotCorpus()` / `writeSnapshot()` / `readSnapshot()`. Types `FixtureRecord`, `Snapshot`, `FixtureDelta`, `DiffResult`.
- `src/lib/fixture-snapshot.test.ts` — CREATE. Unit tests for the two pure functions.
- `scripts/fixture-ab.ts` — CREATE. `snapshot <label>` / `diff <a> <b>` CLI wrapper.
- `package.json` — MODIFY. Add `fixture:snapshot`, `fixture:diff` scripts.
- `.gitignore` — MODIFY. Add `.fixture-snapshots/`.
- `CONTRIBUTING.md` — MODIFY. Add the "Changing the parser? A/B the corpus first" section.
- `src/parser/docx/corpus-parts.integration.test.ts` — MODIFY (Task 7, **after PR #367 merges**). Fold in the note-leak assertion.

---

### Task 1: Banner matcher + gitignore

**Files:**
- Create: `src/lib/specifier-note-banner.ts`
- Test: `src/lib/specifier-note-banner.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `containsSpecifierNoteBanner(text: string): boolean`

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/specifier-note-banner.test.ts
import { describe, it, expect } from 'vitest';
import { containsSpecifierNoteBanner } from './specifier-note-banner.js';

describe('containsSpecifierNoteBanner', () => {
  // Banners anywhere in the line (contains-style, unlike the parser's anchored use).
  const hits = [
    '** NOTE TO SPECIFIER ** delete items below',
    "Display hidden notes to specifier. (Don't know how? Click Here)",
    'SPECIFIER NOTES: coordinate with Division 26',
    'NOTES TO SPEC WRITER — choose one',
    'trailing banner then SPEC NOTE here',
  ];
  for (const t of hits) {
    it(`matches: ${t.slice(0, 40)}`, () => expect(containsSpecifierNoteBanner(t)).toBe(true));
  }

  const misses = [
    'Provide inspector notes to the owner.', // "inspector notes" ≠ banner
    'The following products are noteworthy.',
    'Structural steel shall comply with ASTM A992.',
    '',
  ];
  for (const t of misses) {
    it(`rejects: ${t.slice(0, 40)}`, () => expect(containsSpecifierNoteBanner(t)).toBe(false));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/specifier-note-banner.test.ts`
Expected: FAIL — cannot resolve `./specifier-note-banner.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/specifier-note-banner.ts

// Contains-style mirror of the two anchored specifier-note banner patterns in
// src/parser/docx/heuristics.ts (isSpecifierNote). Used to detect a banner LEAKING
// into rendered body — so it must match anywhere in a line, not just at the start.
// KEEP IN SYNC with heuristics.ts and the migration-024 'Industry Default' seed
// (ADR-022 D3): if a banner variant is added there, add it here.
const NOTE_TO_SPECIFIER = /NOTES? TO (?:THE )?SPEC(?:IFIER|S| WRITER)?S?\b/;
const SPECIFIER_NOTES = /SPEC(?:IFIER)?S? NOTES?\b/;

/** True if the text contains a specifier-note banner in any decoration variant. */
export function containsSpecifierNoteBanner(text: string): boolean {
  const upper = text.toUpperCase();
  return NOTE_TO_SPECIFIER.test(upper) || SPECIFIER_NOTES.test(upper);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/specifier-note-banner.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Add the snapshot dir to `.gitignore`**

Append after the `public/` block at the end of `.gitignore`:

```gitignore

# Fixture A/B snapshots (copyright-derived parse renders; never committed)
.fixture-snapshots/
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/specifier-note-banner.ts src/lib/specifier-note-banner.test.ts .gitignore
git commit -m "feat(lib): contains-style specifier-note banner matcher + snapshot gitignore"
```

---

### Task 2: Per-fixture record builder (pure)

**Files:**
- Create: `src/lib/fixture-snapshot.ts`
- Test: `src/lib/fixture-snapshot.test.ts`

**Interfaces:**
- Consumes: `containsSpecifierNoteBanner` (Task 1); `renderMarkdown(tree: SpecTree): string` from `../generator/markdown.js`; `SpecTree`, `SecRef` from `../ast/types.js`.
- Produces:
  - `interface FixtureRecord { readonly parts: number; readonly noteLeaks: number; readonly refs: readonly string[]; readonly render: string; readonly error?: string }`
  - `fixtureRecord(tree: SpecTree, refs: readonly SecRef[]): FixtureRecord`
  - `type Snapshot = Record<string, FixtureRecord>` (keyed by repo-relative path)

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/fixture-snapshot.test.ts
import { describe, it, expect } from 'vitest';
import { fixtureRecord } from './fixture-snapshot.js';
import type { SpecTree, SecRef } from '../ast/types.js';

function leaf(type: string, text: string): any {
  return { id: type, type, text, children: [], meta: {} };
}

describe('fixtureRecord', () => {
  it('counts visible parts, note leaks, and sorts refs', () => {
    // A part whose body has a banner leaking as content (not a > **[NOTE]** line).
    const tree = {
      id: 't', section: '01 88 13', title: 'T',
      parts: [
        { ...leaf('part', 'GENERAL'),
          children: [leaf('continuation', 'Display hidden notes to specifier.')] },
        leaf('part', 'PRODUCTS'),
        leaf('part', 'EXECUTION'),
      ],
    } as unknown as SpecTree;
    const refs = [
      { sourceNodeId: 'a', targetType: 'section', targetSpecSection: '09 91 00', referenceText: 'x' },
      { sourceNodeId: 'b', targetType: 'standard', standardCode: 'ASTM A992', referenceText: 'y' },
    ] as unknown as SecRef[];

    const rec = fixtureRecord(tree, refs);
    expect(rec.parts).toBe(3);
    expect(rec.noteLeaks).toBe(1); // the leaked banner line
    expect(rec.refs).toEqual(['sec:09 91 00', 'std:ASTM A992']); // sorted, tagged
    expect(rec.render).toContain('Display hidden notes to specifier');
  });

  it('does NOT count a banner inside a proper [NOTE] line as a leak', () => {
    const tree = {
      id: 't', section: '01 00 00', title: 'T',
      parts: [
        { ...leaf('part', 'GENERAL'),
          children: [leaf('note', '** NOTE TO SPECIFIER ** delete if not required')] },
        leaf('part', 'PRODUCTS'), leaf('part', 'EXECUTION'),
      ],
    } as unknown as SpecTree;
    const rec = fixtureRecord(tree, []);
    expect(rec.noteLeaks).toBe(0); // renders as `> **[NOTE]** …`, excluded
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/fixture-snapshot.test.ts`
Expected: FAIL — `fixtureRecord` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/lib/fixture-snapshot.ts (partial — record builder)
import { renderMarkdown } from '../generator/markdown.js';
import { containsSpecifierNoteBanner } from './specifier-note-banner.js';
import type { SpecTree, SecRef, SpecNode } from '../ast/types.js';

export interface FixtureRecord {
  readonly parts: number;
  readonly noteLeaks: number;
  readonly refs: readonly string[];
  readonly render: string;
  readonly error?: string;
}

export type Snapshot = Record<string, FixtureRecord>;

const NOTE_LINE_PREFIX = '> **[NOTE]**';

function countNoteLeaks(render: string): number {
  return render
    .split('\n')
    .filter(
      (line) => containsSpecifierNoteBanner(line) && !line.trimStart().startsWith(NOTE_LINE_PREFIX)
    ).length;
}

function refKey(ref: SecRef): string {
  return ref.targetType === 'section' ? `sec:${ref.targetSpecSection}` : `std:${ref.standardCode}`;
}

export function fixtureRecord(tree: SpecTree, refs: readonly SecRef[]): FixtureRecord {
  const render = renderMarkdown(tree);
  const parts = tree.parts.filter(
    (n: SpecNode) => n.type === 'part' && n.meta.vanish !== true
  ).length;
  return {
    parts,
    noteLeaks: countNoteLeaks(render),
    refs: refs.map(refKey).sort((a, b) => a.localeCompare(b)),
    render,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/fixture-snapshot.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/fixture-snapshot.ts src/lib/fixture-snapshot.test.ts
git commit -m "feat(lib): fixtureRecord — parts/noteLeaks/refs/render per fixture"
```

---

### Task 3: Snapshot diff (pure)

**Files:**
- Modify: `src/lib/fixture-snapshot.ts` (add diff)
- Test: `src/lib/fixture-snapshot.test.ts` (add cases)

**Interfaces:**
- Consumes: `FixtureRecord`, `Snapshot` (Task 2).
- Produces:
  - `interface FixtureDelta { readonly path: string; readonly presence?: 'only-before' | 'only-after'; readonly parts?: readonly [number, number]; readonly noteLeaks?: readonly [number, number]; readonly refsAdded: readonly string[]; readonly refsRemoved: readonly string[]; readonly linesAdded: readonly string[]; readonly linesRemoved: readonly string[] }`
  - `interface DiffResult { readonly changed: readonly FixtureDelta[]; readonly total: number }`
  - `diffSnapshots(before: Snapshot, after: Snapshot): DiffResult`

- [ ] **Step 1: Write the failing test**

```typescript
// append to src/lib/fixture-snapshot.test.ts
import { diffSnapshots } from './fixture-snapshot.js';
import type { Snapshot } from './fixture-snapshot.js';

describe('diffSnapshots', () => {
  const base: Snapshot = {
    'A.docx': { parts: 3, noteLeaks: 1, refs: ['sec:09 91 00'], render: 'x\nDisplay hidden notes to specifier.\ny' },
    'B.docx': { parts: 3, noteLeaks: 0, refs: [], render: 'same' },
  };

  it('reports only changed fixtures with parts/noteLeaks/refs/line deltas', () => {
    const after: Snapshot = {
      'A.docx': { parts: 3, noteLeaks: 0, refs: ['sec:09 91 00'], render: 'x\n> **[NOTE]** Display hidden notes to specifier.\ny' },
      'B.docx': base['B.docx']!, // unchanged
    };
    const d = diffSnapshots(base, after);
    expect(d.total).toBe(2);
    expect(d.changed).toHaveLength(1);
    const a = d.changed[0]!;
    expect(a.path).toBe('A.docx');
    expect(a.noteLeaks).toEqual([1, 0]);
    expect(a.parts).toBeUndefined(); // unchanged fields omitted
    expect(a.linesRemoved).toContain('Display hidden notes to specifier.');
    expect(a.linesAdded).toContain('> **[NOTE]** Display hidden notes to specifier.');
  });

  it('flags fixtures present on only one side', () => {
    const after: Snapshot = { 'A.docx': base['A.docx']! }; // B removed
    const d = diffSnapshots(base, after);
    expect(d.changed.find((c) => c.path === 'B.docx')?.presence).toBe('only-before');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/fixture-snapshot.test.ts`
Expected: FAIL — `diffSnapshots` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to src/lib/fixture-snapshot.ts
export interface FixtureDelta {
  readonly path: string;
  readonly presence?: 'only-before' | 'only-after';
  readonly parts?: readonly [number, number];
  readonly noteLeaks?: readonly [number, number];
  readonly refsAdded: readonly string[];
  readonly refsRemoved: readonly string[];
  readonly linesAdded: readonly string[];
  readonly linesRemoved: readonly string[];
}

export interface DiffResult {
  readonly changed: readonly FixtureDelta[];
  readonly total: number;
}

function diffLists(before: readonly string[], after: readonly string[]): {
  added: string[];
  removed: string[];
} {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x)),
  };
}

function delta(path: string, before: FixtureRecord, after: FixtureRecord): FixtureDelta | null {
  const refs = diffLists(before.refs, after.refs);
  const lines = diffLists(before.render.split('\n'), after.render.split('\n'));
  const changed =
    before.parts !== after.parts ||
    before.noteLeaks !== after.noteLeaks ||
    refs.added.length + refs.removed.length + lines.added.length + lines.removed.length > 0 ||
    before.error !== after.error;
  if (!changed) return null;
  return {
    path,
    ...(before.parts !== after.parts ? { parts: [before.parts, after.parts] as const } : {}),
    ...(before.noteLeaks !== after.noteLeaks
      ? { noteLeaks: [before.noteLeaks, after.noteLeaks] as const }
      : {}),
    refsAdded: refs.added,
    refsRemoved: refs.removed,
    linesAdded: lines.added,
    linesRemoved: lines.removed,
  };
}

export function diffSnapshots(before: Snapshot, after: Snapshot): DiffResult {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed: FixtureDelta[] = [];
  for (const path of paths) {
    const b = before[path];
    const a = after[path];
    if (b && !a) {
      changed.push({ path, presence: 'only-before', refsAdded: [], refsRemoved: [], linesAdded: [], linesRemoved: [] });
    } else if (!b && a) {
      changed.push({ path, presence: 'only-after', refsAdded: [], refsRemoved: [], linesAdded: [], linesRemoved: [] });
    } else if (b && a) {
      const d = delta(path, b, a);
      if (d) changed.push(d);
    }
  }
  return { changed, total: paths.length };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/fixture-snapshot.test.ts`
Expected: PASS (4 tests total).

- [ ] **Step 5: Lint the pure logic**

Run: `pnpm lint`
Expected: PASS. If `delta` trips `complexity`/`max-lines-per-function`, extract the `changed` boolean into a named helper — do not raise the cap.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fixture-snapshot.ts src/lib/fixture-snapshot.test.ts
git commit -m "feat(lib): diffSnapshots — per-fixture parts/leaks/refs/line deltas"
```

---

### Task 4: Corpus I/O (snapshot + read/write)

**Files:**
- Modify: `src/lib/fixture-snapshot.ts` (add I/O)
- Test: `src/lib/fixture-snapshot.io.test.ts` (unit — no DB; round-trip is corpus-free, single-`.sec` check is corpus-gated)

**Interfaces:**
- Consumes: `fixtureRecord` (Task 2); `parse` from `../parser/index.js`.
- Produces:
  - `snapshotCorpus(refDir?: string): Promise<Snapshot>` (default `refDir = 'docs/references'`)
  - `writeSnapshot(snapshot: Snapshot, outDir: string, label: string): Promise<string>` (returns written path)
  - `readSnapshot(path: string): Promise<Snapshot>`

Why a plain `.test.ts` (unit), not `.integration.test.ts`: this test touches only the filesystem, never Postgres, and the integration project serializes around a shared DB. Keeping it in the unit lane avoids a needless DB dependency. It is corpus-free except the one single-file check, which is `it.skipIf`-gated on a `.sec` being present (they are committed, so it runs in CI too — a single fast parse, not the 666-file sweep).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/fixture-snapshot.io.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, globSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSnapshot, readSnapshot, fixtureRecord } from './fixture-snapshot.js';
import type { Snapshot } from './fixture-snapshot.js';
import { parse } from '../parser/index.js';

describe('writeSnapshot / readSnapshot round-trip', () => {
  it('writes to the given output dir and reads back an identical snapshot', async () => {
    const snap: Snapshot = {
      'X.docx': { parts: 3, noteLeaks: 0, refs: ['sec:09 91 00'], render: 'a\nb' },
    };
    const out = mkdtempSync(join(tmpdir(), 'fx-'));
    const path = await writeSnapshot(snap, out, 'smoke');
    expect(path).toBe(join(out, 'smoke.json'));
    expect(await readSnapshot(path)).toEqual(snap);
  });
});

// One committed .sec fixture proves the parse → record path on real data without the
// full-corpus sweep. globSync so we don't hardcode a UFGS subpath.
const ONE_SEC = globSync('docs/references/**/*.{sec,SEC}').sort()[0];

describe.skipIf(!ONE_SEC)('fixtureRecord on a real .sec fixture', () => {
  it('produces a well-formed record', async () => {
    const { tree, refs } = await parse(readFileSync(ONE_SEC!), ONE_SEC!);
    const rec = fixtureRecord(tree, refs);
    expect(typeof rec.parts).toBe('number');
    expect(typeof rec.render).toBe('string');
    expect(Array.isArray(rec.refs)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/fixture-snapshot.io.test.ts`
Expected: FAIL — `writeSnapshot` / `readSnapshot` not exported.

- [ ] **Step 3: Write minimal implementation**

```typescript
// append to src/lib/fixture-snapshot.ts
import { readFile, writeFile, mkdir, glob } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '../parser/index.js';

const PROJECT_ROOT = process.cwd();

export async function snapshotCorpus(refDir = 'docs/references'): Promise<Snapshot> {
  const snapshot: Snapshot = {};
  for await (const rel of glob(`${refDir}/**/*.{docx,sec,SEC}`, { cwd: PROJECT_ROOT })) {
    const abs = join(PROJECT_ROOT, rel);
    try {
      const { tree, refs } = await parse(await readFile(abs), abs);
      snapshot[rel] = fixtureRecord(tree, refs);
    } catch (err) {
      snapshot[rel] = {
        parts: -1,
        noteLeaks: -1,
        refs: [],
        render: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return snapshot;
}

export async function writeSnapshot(
  snapshot: Snapshot,
  outDir: string,
  label: string
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, `${label}.json`);
  await writeFile(path, JSON.stringify(snapshot));
  return path;
}

export async function readSnapshot(path: string): Promise<Snapshot> {
  return JSON.parse(await readFile(path, 'utf8')) as Snapshot;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/fixture-snapshot.io.test.ts`
Expected: PASS — round-trip always; the `.sec` record check runs (fixtures committed) or skips.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/fixture-snapshot.ts src/lib/fixture-snapshot.io.test.ts
git commit -m "feat(lib): snapshotCorpus + read/write snapshot I/O"
```

---

### Task 5: CLI wrapper + pnpm scripts

**Files:**
- Create: `scripts/fixture-ab.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `snapshotCorpus`, `writeSnapshot`, `readSnapshot`, `diffSnapshots` (Tasks 2-4).

- [ ] **Step 1: Write the CLI**

```typescript
// scripts/fixture-ab.ts
import { existsSync } from 'node:fs';
import { snapshotCorpus, writeSnapshot, readSnapshot, diffSnapshots } from '../src/lib/fixture-snapshot.js';

const OUT_DIR = '.fixture-snapshots';

async function snapshot(label: string): Promise<number> {
  if (!existsSync('docs/references')) {
    console.log('docs/references not present — nothing to snapshot.');
    return 0;
  }
  const snap = await snapshotCorpus();
  const path = await writeSnapshot(snap, OUT_DIR, label);
  const errors = Object.values(snap).filter((r) => r.error).length;
  console.log(`snapshotted ${Object.keys(snap).length} fixtures (${errors} parse-error) → ${path}`);
  return 0;
}

async function diff(a: string, b: string): Promise<number> {
  const before = await readSnapshot(`${OUT_DIR}/${a}.json`);
  const after = await readSnapshot(`${OUT_DIR}/${b}.json`);
  const { changed, total } = diffSnapshots(before, after);
  for (const c of changed) {
    if (c.presence) { console.log(`\n=== ${c.path}  (${c.presence}) ===`); continue; }
    const bits = [
      c.parts ? `parts ${c.parts[0]}→${c.parts[1]}` : '',
      c.noteLeaks ? `noteLeaks ${c.noteLeaks[0]}→${c.noteLeaks[1]}` : '',
    ].filter(Boolean).join(' ');
    console.log(`\n=== ${c.path} ${bits} ===`);
    c.refsRemoved.forEach((r) => console.log(`  - ref ${r}`));
    c.refsAdded.forEach((r) => console.log(`  + ref ${r}`));
    c.linesRemoved.slice(0, 8).forEach((l) => console.log(`  - ${l.slice(0, 100)}`));
    c.linesAdded.slice(0, 8).forEach((l) => console.log(`  + ${l.slice(0, 100)}`));
  }
  console.log(`\n${changed.length}/${total} fixtures changed`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'snapshot' && rest[0]) return snapshot(rest[0]);
  if (cmd === 'diff' && rest[0] && rest[1]) return diff(rest[0], rest[1]);
  console.error('Usage: fixture-ab snapshot <label> | fixture-ab diff <before> <after>');
  return 1;
}

main().then((code) => process.exit(code)).catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Add pnpm scripts**

In `package.json` `"scripts"`, after the `load:files` entry:

```json
    "fixture:snapshot": "tsx scripts/fixture-ab.ts snapshot",
    "fixture:diff": "tsx scripts/fixture-ab.ts diff",
```

- [ ] **Step 3: Manual end-to-end verification**

Run:
```bash
pnpm fixture:snapshot before
pnpm fixture:snapshot after      # no change yet
pnpm fixture:diff before after
```
Expected: `snapshotted N fixtures …` twice, then `0/N fixtures changed`.

- [ ] **Step 4: Verify snapshots are gitignored**

Run: `git status --porcelain .fixture-snapshots`
Expected: empty output (ignored).

- [ ] **Step 5: Commit**

```bash
git add scripts/fixture-ab.ts package.json
git commit -m "feat(scripts): fixture-ab CLI (snapshot/diff) + pnpm scripts"
```

---

### Task 6: CONTRIBUTING.md section

**Files:**
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Add the section** (append near the testing/parser guidance; adjust the heading level to match surrounding sections)

```markdown
## Changing the parser? A/B the corpus first

The inference/parsing engine is the product. Any change to a parsing **regex** or
inference **signal** can silently reshape how hundreds of fixtures parse. Before and
after every such change, snapshot the whole reference corpus and diff:

```bash
pnpm fixture:snapshot before   # known-good baseline
# …make the parser change…
pnpm fixture:snapshot after
pnpm fixture:diff before after
```

Verify that **only the fixtures you intended to change** moved, that every real spec
still resolves to 3 parts, and that no specifier-note banner leaked into body text
(`noteLeaks` must not rise). The reference corpus is copyrighted and gitignored, so the
tool runs locally — snapshots are written to `.fixture-snapshots/` (also gitignored).
The always-on guard for the 3-part invariant is `corpus-parts.integration.test.ts`,
which also asserts no banner leaks; run it with `pnpm test:integration` where the
corpus is present.
```

- [ ] **Step 2: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs(contributing): A/B-the-corpus rule for parser changes"
```

---

### Task 7: Note-leak invariant (⚠ AFTER PR #367 merges)

**Depends on:** PR #367 (Fix A) merged to `main`, then this branch rebased onto it — the assertion only passes once "Display hidden notes to specifier" classifies as a note. Do NOT start this task until #367 is on `main`.

**Files:**
- Modify: `src/parser/docx/corpus-parts.integration.test.ts`

**Interfaces:**
- Consumes: `containsSpecifierNoteBanner` (Task 1); `renderMarkdown` from `../../generator/markdown.js`.

- [ ] **Step 1: Add imports** at the top of the file:

```typescript
import { renderMarkdown } from '../../generator/markdown.js';
import { containsSpecifierNoteBanner } from '../../lib/specifier-note-banner.js';
```

- [ ] **Step 2: Fold the leak assertion into the existing per-fixture `it()`**

Immediately after the existing `expect(names[2]).toContain('EXECUTION');` line (reusing the `tree` already parsed in that `it()` — do NOT re-parse), add:

```typescript
      // No specifier-note banner may render as CSI body — it must be a `> **[NOTE]**`
      // line or be suppressed. Banner-scoped so the open #292 asterisk-[OR] delimiters
      // (not banners) stay green. Locks in Fix A ("Display hidden notes to specifier").
      const leaks = renderMarkdown(tree)
        .split('\n')
        .filter((l) => containsSpecifierNoteBanner(l) && !l.trimStart().startsWith('> **[NOTE]**'));
      expect(leaks, `banner leaked as body in ${name}:\n${leaks.join('\n')}`).toEqual([]);
```

- [ ] **Step 3: Run the corpus test locally (corpus present)**

Run: `pnpm test:integration -- src/parser/docx/corpus-parts.integration.test.ts`
Expected: PASS for every real spec. If a fixture fails, that is a genuine banner leak — investigate before overriding.

- [ ] **Step 4: Commit**

```bash
git add src/parser/docx/corpus-parts.integration.test.ts
git commit -m "test(parser): corpus assertion — no specifier-note banner leaks to body"
```

---

## Sequencing & PR

- Tasks 1-6 are independent of #367 and form the first PR (draft): `chore/fixture-ab-harness`.
- Task 7 lands after #367 merges — either appended to this branch once rebased onto the updated `main`, or as a small follow-up PR. Note it in the PR body so a reviewer knows Task 7 is deferred.
- Open the PR as a **draft** (`gh pr create --draft`), per repo policy.
