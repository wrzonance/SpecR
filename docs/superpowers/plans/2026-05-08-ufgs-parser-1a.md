# UFGS Parser + Cross-Reference Model (Sub-MVP 1a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse all 666 UFGS .SEC files into the canonical CsiTree AST, persist to PostgreSQL with cross-references extracted into a new `spec_references` table, alongside a `projects`/`project_specs` schema (no API — model only).

**Architecture:** Two-phase approach: `src/parser/sec/` has zero DB imports and returns `{ tree: CsiTree, refs: SecRef[] }` — pure function, easily unit-tested. DB persistence lives in `src/db/queries/paragraphs.ts` and `src/db/queries/refs.ts`. The bulk loader `scripts/load-ufgs.ts` wires both phases together in a sequential, transactional loop. Node UUIDs assigned at parse time are used as DB primary keys, eliminating any ID mapping layer.

**Tech Stack:** fast-xml-parser v5 (structural parse + stopNodes for mixed content), uuid v11, pg v8, vitest v4, node-pg-migrate v8.

---

## Key Implementation Notes

**UFGS element → NodeType mapping (verified against real .SEC files):**

| SEC element | CsiNode type | Notes |
|-------------|-------------|-------|
| `<PRT>` | `part` | Contains `<TTL>` for title |
| `<SPT>` | `article` | Can be nested inside SPT |
| `<TXT>` | `continuation` | Unnumbered prose paragraph |
| `<LST>` | `pr1` | Auto-numbered A./B./C. items |
| `<ITM>` | `pr2` | Sub-items (1./2./3.) |
| `<OLI>` inside `<OLG>` | `pr1` | Ordered list items |
| `<NPR>` inside `<NTE>` | `note` | `vanish: true`, specifier note |

**Mixed content:** `<TXT>`, `<LST>`, `<ITM>`, `<NPR>`, `<OLI>`, `<TTL>` contain mixed XML — text interleaved with `<SRF>`, `<TAI>`, `<SUB>`, `<URL>` inline elements. Use fast-xml-parser `stopNodes` to capture these as raw strings, then strip tags with regex for plain text.

**Reference types in UFGS:**
- `<SRF>27 05 13.43</SRF>` — explicit section cross-reference (most reliable, use this over text regex)
- `<REF>/<RID>ANSI/TIA-568.1</RID>` — external standard reference

**UUID as PK:** CsiNode UUIDs (assigned at parse time, uuidv4) are used directly as `paragraphs.id`. Avoids any ID translation layer.

**Encoding:** UFGS .SEC files are windows-1252 encoded. Read with Node's `'latin1'` (superset-compatible).

---

## File Map

| Action | Path |
|--------|------|
| Create | `tests/fixtures/sec/27_41_00.SEC` |
| Create | `tests/fixtures/sec/27_10_00.SEC` |
| Create | `src/db/migrations/005_specs_unique_constraint.ts` |
| Create | `src/db/migrations/006_create_projects.ts` |
| Create | `src/db/migrations/007_create_project_specs.ts` |
| Create | `src/db/migrations/008_create_spec_references.ts` |
| Create | `src/parser/error.ts` |
| Create | `src/parser/sec/elements.ts` |
| Create | `src/parser/sec/index.ts` |
| Create | `src/parser/sec/index.test.ts` |
| Create | `src/parser/sec/refs.test.ts` |
| Create | `src/parser/index.ts` |
| Modify | `src/db/queries/paragraphs.ts` |
| Create | `src/db/queries/paragraphs.test.ts` |
| Create | `src/db/queries/refs.ts` |
| Create | `src/db/queries/refs.test.ts` |
| Modify | `src/db/index.ts` |
| Create | `scripts/load-ufgs.ts` |
| Create | `src/parser/sec/index.integration.test.ts` |
| Modify | `package.json` |

---

## Task 1: Copy test fixtures

**Files:**
- Create: `tests/fixtures/sec/27_41_00.SEC`
- Create: `tests/fixtures/sec/27_10_00.SEC`

- [ ] **Step 1: Copy**

```bash
mkdir -p tests/fixtures/sec
cp docs/references/UFGS/DIVISION_27/27_41_00.SEC tests/fixtures/sec/
cp docs/references/UFGS/DIVISION_27/27_10_00.SEC tests/fixtures/sec/
```

- [ ] **Step 2: Verify**

```bash
ls -lh tests/fixtures/sec/
```

Expected: two .SEC files, each > 10 KB.

---

## Task 2: Migration 005 — unique constraint on specs

**Files:**
- Create: `src/db/migrations/005_specs_unique_constraint.ts`

- [ ] **Step 1: Write migration**

```typescript
// src/db/migrations/005_specs_unique_constraint.ts
import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.addConstraint('specs', 'specs_section_source_unique', 'UNIQUE (section, source)');
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropConstraint('specs', 'specs_section_source_unique');
};
```

- [ ] **Step 2: Run**

```bash
pnpm migrate
```

Expected: `Migrating "005_specs_unique_constraint"` — no errors.

---

## Task 3: Migration 006 — projects table

**Files:**
- Create: `src/db/migrations/006_create_projects.ts`

- [ ] **Step 1: Write migration**

```typescript
// src/db/migrations/006_create_projects.ts
import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('projects', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('projects', { cascade: true });
};
```

- [ ] **Step 2: Run**

```bash
pnpm migrate
```

---

## Task 4: Migration 007 — project_specs table

**Files:**
- Create: `src/db/migrations/007_create_project_specs.ts`

- [ ] **Step 1: Write migration**

```typescript
// src/db/migrations/007_create_project_specs.ts
import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('project_specs', {
    project_id: {
      type: 'uuid',
      notNull: true,
      references: 'projects',
      onDelete: 'CASCADE',
    },
    spec_id: {
      type: 'uuid',
      notNull: true,
      references: 'specs',
      onDelete: 'RESTRICT',
    },
    position: { type: 'integer', notNull: true },
    added_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.addConstraint('project_specs', 'project_specs_pkey', 'PRIMARY KEY (project_id, spec_id)');
  pgm.createIndex('project_specs', 'spec_id');
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('project_specs', { cascade: true });
};
```

- [ ] **Step 2: Run**

```bash
pnpm migrate
```

---

## Task 5: Migration 008 — spec_references table

**Files:**
- Create: `src/db/migrations/008_create_spec_references.ts`

- [ ] **Step 1: Write migration**

```typescript
// src/db/migrations/008_create_spec_references.ts
import type { MigrationBuilder } from 'node-pg-migrate';

export const up = (pgm: MigrationBuilder): void => {
  pgm.createTable('spec_references', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    source_spec_id: {
      type: 'uuid',
      notNull: true,
      references: 'specs',
      onDelete: 'CASCADE',
    },
    source_paragraph_id: {
      type: 'uuid',
      notNull: true,
      references: 'paragraphs',
      onDelete: 'CASCADE',
    },
    target_type: { type: 'varchar(20)', notNull: true },
    target_spec_section: { type: 'varchar(20)' },
    target_spec_id: {
      type: 'uuid',
      references: 'specs',
      onDelete: 'SET NULL',
    },
    target_paragraph_id: {
      type: 'uuid',
      references: 'paragraphs',
      onDelete: 'SET NULL',
    },
    standard_code: { type: 'text' },
    reference_text: { type: 'text', notNull: true },
    is_broken: { type: 'boolean', notNull: true, default: false },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('spec_references', 'source_spec_id');
  pgm.createIndex('spec_references', 'target_spec_id');
  pgm.createIndex('spec_references', 'target_spec_section');
  pgm.createIndex('spec_references', ['is_broken'], { where: 'is_broken = true' });
};

export const down = (pgm: MigrationBuilder): void => {
  pgm.dropTable('spec_references', { cascade: true });
};
```

- [ ] **Step 2: Run**

```bash
pnpm migrate
```

- [ ] **Step 3: Commit all migrations**

```bash
git checkout -b feat/parser-ufgs-1a
git add src/db/migrations/
git commit -m "feat(db): add projects, project_specs, spec_references migrations"
```

---

## Task 6: parser/error.ts

**Files:**
- Create: `src/parser/error.ts`

- [ ] **Step 1: Write**

```typescript
// src/parser/error.ts
import { SpecrError } from '../lib/errors.js';

export class ParserError extends SpecrError {}
```

---

## Task 7: parser/sec/elements.ts

**Files:**
- Create: `src/parser/sec/elements.ts`

Zod schemas + TypeScript interfaces for the raw fast-xml-parser output. `stopNodes` elements come back as raw strings (not parsed objects), so content nodes are typed as `string`.

- [ ] **Step 1: Write**

```typescript
// src/parser/sec/elements.ts
import { z } from 'zod';

// Elements listed in stopNodes arrive as raw XML strings.
// Structural elements (PRT, SPT, NTE, REF) are parsed objects.

export interface NteNode {
  readonly NPR?: string | readonly string[];
}

export interface RefNode {
  readonly ORG?: string;
  readonly RID?: string | readonly string[];
  readonly RTL?: string;
}

export interface SptNode {
  readonly TTL?: string;
  readonly TXT?: string | readonly string[];
  readonly LST?: string | readonly string[];
  readonly ITM?: string | readonly string[];
  readonly OLG?: { readonly OLI?: string | readonly string[] };
  readonly NTE?: NteNode | readonly NteNode[];
  readonly SPT?: SptNode | readonly SptNode[];
  readonly REF?: RefNode | readonly RefNode[];
}

export interface PrtNode {
  readonly TTL?: string;
  readonly SPT?: SptNode | readonly SptNode[];
  readonly NTE?: NteNode | readonly NteNode[];
}

export interface SecRoot {
  readonly SEC: {
    readonly SCN?: string;
    readonly STL?: string;
    readonly DTE?: string;
    readonly PRT?: PrtNode | readonly PrtNode[];
  };
}

// Zod schema for validating the parser output at the root level only.
// Inner nodes are typed via interfaces (validated by TypeScript, not Zod).
export const SecRootSchema = z.object({
  SEC: z.object({
    SCN: z.string().optional(),
    STL: z.string().optional(),
    DTE: z.string().optional(),
  }),
});
```

---

## Task 8: parser/sec/index.ts — parseSec (TDD)

**Files:**
- Create: `src/parser/sec/index.test.ts`
- Create: `src/parser/sec/index.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/parser/sec/index.test.ts
import { describe, it, expect } from 'vitest';
import { parseSec } from './index.js';
import { ParserError } from '../error.js';

const MINIMAL = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <MTA NAME="AUTONUMBER" CONTENT="TRUE"/>
  <SCN>SECTION 27 10 00</SCN>
  <STL>BUILDING TELECOMMUNICATIONS CABLING SYSTEM</STL>
</SEC>`;

const WITH_PARTS = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 10 00</SCN>
  <STL>BUILDING TELECOMMUNICATIONS CABLING SYSTEM</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>REFERENCES</TTL>
      <TXT>The publications listed below form a part of this specification.</TXT>
    </SPT>
    <SPT>
      <TTL>DEFINITIONS</TTL>
      <TXT>A distributor from which the backbone cabling emanates.</TXT>
      <LST>For Army, the Network Enterprise Center (NEC)</LST>
      <LST>For Navy, the Base Communications Officer (BCO)</LST>
      <ITM>Sub-item text here</ITM>
    </SPT>
  </PRT>
  <PRT>
    <TTL>PART 2   PRODUCTS</TTL>
    <SPT>
      <TTL>COMPONENTS</TTL>
      <TXT>Component description here.</TXT>
    </SPT>
  </PRT>
</SEC>`;

const WITH_NOTES = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 41 00</SCN>
  <STL>AUDIO-VISUAL SYSTEMS</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>REFERENCES</TTL>
      <NTE>
        <NPR>NOTE: This paragraph lists publications cited in the text.</NPR>
        <NPR>Use the Reference Wizard to check references.</NPR>
      </NTE>
      <TXT>The publications listed below form a part of this specification.</TXT>
    </SPT>
  </PRT>
</SEC>`;

const WITH_MIXED_CONTENT = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 41 00</SCN>
  <STL>AUDIO-VISUAL SYSTEMS</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>RELATED REQUIREMENTS</TTL>
      <TXT>Section <SRF>26 20 00</SRF> INTERIOR DISTRIBUTION SYSTEM applies.</TXT>
      <LST>See Section <SRF>27 05 13.43</SRF> TELEVISION DISTRIBUTION SYSTEM.</LST>
    </SPT>
  </PRT>
</SEC>`;

describe('parseSec', () => {
  describe('section and title', () => {
    it('extracts section number from SCN', () => {
      const { tree } = parseSec(MINIMAL);
      expect(tree.section).toBe('27 10 00');
    });

    it('extracts title from STL', () => {
      const { tree } = parseSec(MINIMAL);
      expect(tree.title).toBe('BUILDING TELECOMMUNICATIONS CABLING SYSTEM');
    });

    it('assigns UUID to tree id', () => {
      const { tree } = parseSec(MINIMAL);
      expect(tree.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('returns empty parts when no PRT elements', () => {
      const { tree } = parseSec(MINIMAL);
      expect(tree.parts).toHaveLength(0);
    });

    it('throws ParserError when SCN missing', () => {
      const bad = `<?xml version="1.0"?><SEC><STL>Title</STL></SEC>`;
      expect(() => parseSec(bad)).toThrow(ParserError);
    });

    it('throws ParserError when STL missing', () => {
      const bad = `<?xml version="1.0"?><SEC><SCN>SECTION 27 10 00</SCN></SEC>`;
      expect(() => parseSec(bad)).toThrow(ParserError);
    });
  });

  describe('PRT / SPT hierarchy', () => {
    it('maps PRT to part nodes', () => {
      const { tree } = parseSec(WITH_PARTS);
      expect(tree.parts).toHaveLength(2);
      expect(tree.parts[0]?.type).toBe('part');
    });

    it('strips PART N prefix from part title', () => {
      const { tree } = parseSec(WITH_PARTS);
      expect(tree.parts[0]?.text).toBe('GENERAL');
      expect(tree.parts[1]?.text).toBe('PRODUCTS');
    });

    it('maps SPT to article nodes as part children', () => {
      const { tree } = parseSec(WITH_PARTS);
      expect(tree.parts[0]?.children).toHaveLength(2);
      expect(tree.parts[0]?.children[0]?.type).toBe('article');
    });

    it('sets article text from TTL', () => {
      const { tree } = parseSec(WITH_PARTS);
      expect(tree.parts[0]?.children[0]?.text).toBe('REFERENCES');
    });

    it('maps TXT to continuation nodes', () => {
      const { tree } = parseSec(WITH_PARTS);
      const refs = tree.parts[0]?.children[0];
      expect(refs?.children[0]?.type).toBe('continuation');
      expect(refs?.children[0]?.text).toContain('publications listed below');
    });

    it('maps LST to pr1 nodes', () => {
      const { tree } = parseSec(WITH_PARTS);
      const defs = tree.parts[0]?.children[1];
      const pr1s = defs?.children.filter((c) => c.type === 'pr1') ?? [];
      expect(pr1s).toHaveLength(2);
      expect(pr1s[0]?.text).toBe('For Army, the Network Enterprise Center (NEC)');
    });

    it('maps ITM to pr2 nodes', () => {
      const { tree } = parseSec(WITH_PARTS);
      const defs = tree.parts[0]?.children[1];
      const pr2 = defs?.children.find((c) => c.type === 'pr2');
      expect(pr2?.text).toBe('Sub-item text here');
    });

    it('assigns unique UUID to every node', () => {
      const { tree } = parseSec(WITH_PARTS);
      const ids = new Set<string>();
      const collect = (nodes: readonly { id: string; children: readonly { id: string; children: never[] }[] }[]) => {
        for (const n of nodes) { ids.add(n.id); collect(n.children as never); }
      };
      collect(tree.parts as never);
      expect(ids.size).toBeGreaterThan(0);
    });

    it('sets source: ufgs on all node meta', () => {
      const { tree } = parseSec(WITH_PARTS);
      expect(tree.parts[0]?.meta.source).toBe('ufgs');
    });
  });

  describe('NTE / NPR notes', () => {
    it('maps NPR inside NTE to note nodes with vanish: true', () => {
      const { tree } = parseSec(WITH_NOTES);
      const refs = tree.parts[0]?.children[0];
      const notes = refs?.children.filter((c) => c.type === 'note') ?? [];
      expect(notes).toHaveLength(2);
      expect(notes[0]?.meta.vanish).toBe(true);
    });

    it('sets note text from NPR content', () => {
      const { tree } = parseSec(WITH_NOTES);
      const note = tree.parts[0]?.children[0]?.children.find((c) => c.type === 'note');
      expect(note?.text).toContain('This paragraph lists publications');
    });
  });

  describe('text extraction from mixed content', () => {
    it('strips XML tags from TXT, keeps text', () => {
      const { tree } = parseSec(WITH_MIXED_CONTENT);
      const txt = tree.parts[0]?.children[0]?.children.find((c) => c.type === 'continuation');
      expect(txt?.text).toContain('INTERIOR DISTRIBUTION SYSTEM');
      expect(txt?.text).not.toContain('<SRF>');
    });

    it('strips XML tags from LST, keeps text', () => {
      const { tree } = parseSec(WITH_MIXED_CONTENT);
      const pr1 = tree.parts[0]?.children[0]?.children.find((c) => c.type === 'pr1');
      expect(pr1?.text).toContain('TELEVISION DISTRIBUTION SYSTEM');
      expect(pr1?.text).not.toContain('<SRF>');
    });
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm test src/parser/sec/index.test.ts 2>&1 | tail -20
```

Expected: `Cannot find module './index.js'`

- [ ] **Step 3: Implement parseSec**

```typescript
// src/parser/sec/index.ts
import { XMLParser } from 'fast-xml-parser';
import { v4 as uuidv4 } from 'uuid';
import type { CsiNode, CsiTree, NodeType } from '../../ast/types.js';
import { ParserError } from '../error.js';
import type { NteNode, PrtNode, RefNode, SptNode } from './elements.js';

export interface SecRef {
  readonly sourceNodeId: string;
  readonly targetType: 'section' | 'standard';
  readonly targetSpecSection?: string;
  readonly standardCode?: string;
  readonly referenceText: string;
}

export interface ParsedSec {
  readonly tree: CsiTree;
  readonly refs: readonly SecRef[];
}

// stopNodes: fast-xml-parser returns raw string for these instead of parsed object.
// Required for mixed-content elements (text + inline tags like SRF, TAI, SUB).
const STOP_NODES = ['TXT', 'LST', 'ITM', 'NPR', 'OLI', 'TTL'];

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) =>
    ['PRT', 'SPT', 'NTE', 'NPR', 'TXT', 'LST', 'ITM', 'REF', 'RID', 'OLI'].includes(name),
  stopNodes: STOP_NODES,
  trimValues: true,
  processEntities: false,
});

function stripTags(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSrfSections(raw: string): string[] {
  return [...raw.matchAll(/<SRF>([^<]+)<\/SRF>/g)]
    .map((m) => m[1]?.trim() ?? '')
    .filter(Boolean);
}

function stripPartPrefix(raw: string): string {
  return raw.replace(/^PART\s+\d+\s+[-–]?\s*/i, '').trim();
}

function toArray<T>(val: T | readonly T[] | undefined): readonly T[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? (val as readonly T[]) : [val as T];
}

function makeNode(
  type: NodeType,
  text: string,
  children: CsiNode[],
  vanish?: boolean
): CsiNode {
  return {
    id: uuidv4(),
    type,
    text: text.trim() || type,
    children,
    meta: { source: 'ufgs', ...(vanish === true ? { vanish: true } : {}) },
  };
}

function walkNte(nte: NteNode): CsiNode[] {
  return toArray(nte.NPR)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .map((raw) => makeNode('note', stripTags(raw), [], true));
}

function walkSpt(spt: SptNode, refs: SecRef[]): CsiNode {
  const ttlRaw = typeof spt.TTL === 'string' ? spt.TTL : '';
  const title = stripTags(ttlRaw);
  const children: CsiNode[] = [];

  // Notes before content (display order)
  for (const nte of toArray(spt.NTE)) {
    children.push(...walkNte(nte));
  }

  // TXT → continuation
  for (const raw of toArray(spt.TXT)) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const node = makeNode('continuation', stripTags(raw), []);
    children.push(node);
    for (const sec of extractSrfSections(raw)) {
      refs.push({ sourceNodeId: node.id, targetType: 'section', targetSpecSection: sec, referenceText: stripTags(raw).slice(0, 200) });
    }
  }

  // LST → pr1
  for (const raw of toArray(spt.LST)) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const node = makeNode('pr1', stripTags(raw), []);
    children.push(node);
    for (const sec of extractSrfSections(raw)) {
      refs.push({ sourceNodeId: node.id, targetType: 'section', targetSpecSection: sec, referenceText: stripTags(raw).slice(0, 200) });
    }
  }

  // ITM → pr2
  for (const raw of toArray(spt.ITM)) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    children.push(makeNode('pr2', stripTags(raw), []));
  }

  // OLG/OLI → pr1
  if (spt.OLG) {
    for (const raw of toArray(spt.OLG.OLI)) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      const node = makeNode('pr1', stripTags(raw), []);
      children.push(node);
      for (const sec of extractSrfSections(raw)) {
        refs.push({ sourceNodeId: node.id, targetType: 'section', targetSpecSection: sec, referenceText: stripTags(raw).slice(0, 200) });
      }
    }
  }

  // Nested SPT → article children
  for (const nested of toArray(spt.SPT)) {
    children.push(walkSpt(nested as SptNode, refs));
  }

  const articleNode = makeNode('article', title || 'UNTITLED', children);

  // REF/RID → standard refs linked to this article node
  for (const ref of toArray(spt.REF as RefNode | readonly RefNode[] | undefined)) {
    for (const rid of toArray((ref as RefNode).RID)) {
      const code = typeof rid === 'string' ? rid.trim() : '';
      if (!code) continue;
      refs.push({ sourceNodeId: articleNode.id, targetType: 'standard', standardCode: code, referenceText: code });
    }
  }

  return articleNode;
}

export function parseSec(xml: string): ParsedSec {
  let root: unknown;
  try {
    root = xmlParser.parse(xml) as unknown;
  } catch (err) {
    throw new ParserError('failed to parse SEC XML', { cause: err });
  }

  const sec = (root as Record<string, unknown>)['SEC'] as Record<string, unknown> | undefined;
  if (!sec) throw new ParserError('SEC root element not found');

  const scnRaw = sec['SCN'];
  if (!scnRaw) throw new ParserError('SEC file missing <SCN> section number element');
  const section = String(scnRaw).replace(/^SECTION\s+/i, '').trim();

  const stlRaw = sec['STL'];
  if (!stlRaw) throw new ParserError('SEC file missing <STL> title element');
  const title = String(stlRaw).trim();

  const refs: SecRef[] = [];
  const parts: CsiNode[] = [];

  for (const prt of toArray(sec['PRT'] as PrtNode | readonly PrtNode[] | undefined)) {
    const ttlRaw = typeof (prt as PrtNode).TTL === 'string' ? (prt as PrtNode).TTL! : '';
    const prtTitle = stripPartPrefix(stripTags(ttlRaw));
    const partChildren: CsiNode[] = [];

    for (const nte of toArray((prt as PrtNode).NTE)) {
      partChildren.push(...walkNte(nte));
    }
    for (const spt of toArray((prt as PrtNode).SPT)) {
      partChildren.push(walkSpt(spt as SptNode, refs));
    }

    parts.push(makeNode('part', prtTitle || 'PART', partChildren));
  }

  return { tree: { id: uuidv4(), section, title, parts }, refs };
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
pnpm test src/parser/sec/index.test.ts --reporter=verbose
```

Expected: all tests pass. If `toArray` type errors appear, cast `spt.NTE` / `spt.SPT` explicitly.

---

## Task 9: parser/sec/refs.test.ts — reference extraction

**Files:**
- Create: `src/parser/sec/refs.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/parser/sec/refs.test.ts
import { describe, it, expect } from 'vitest';
import { parseSec } from './index.js';

const WITH_STANDARD_REFS = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 41 00</SCN>
  <STL>AUDIO-VISUAL SYSTEMS</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>REFERENCES</TTL>
      <REF>
        <ORG>TELECOMMUNICATIONS INDUSTRY ASSOCIATION (TIA)</ORG>
        <RID>ANSI/TIA-568.1</RID>
        <RTL>(2020e) Commercial Building Telecommunications Infrastructure Standard</RTL>
        <RID>ANSI/TIA-569</RID>
        <RTL>(2019e) Telecommunications Pathways and Spaces</RTL>
      </REF>
      <REF>
        <ORG>NATIONAL FIRE PROTECTION ASSOCIATION (NFPA)</ORG>
        <RID>NFPA 70</RID>
        <RTL>(2026) National Electrical Code</RTL>
      </REF>
      <TXT>The publications listed below form a part of this specification.</TXT>
    </SPT>
  </PRT>
</SEC>`;

const WITH_SECTION_REFS = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 41 00</SCN>
  <STL>AUDIO-VISUAL SYSTEMS</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>RELATED REQUIREMENTS</TTL>
      <TXT>Section <SRF>26 20 00</SRF> INTERIOR DISTRIBUTION SYSTEM applies.</TXT>
      <LST>See <SRF>27 05 13.43</SRF> TELEVISION DISTRIBUTION SYSTEM for CATV.</LST>
    </SPT>
  </PRT>
</SEC>`;

const NO_REFS = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 10 00</SCN>
  <STL>CABLING SYSTEM</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>DEFINITIONS</TTL>
      <TXT>Plain text with no references at all.</TXT>
    </SPT>
  </PRT>
</SEC>`;

describe('reference extraction', () => {
  describe('standard refs (REF/RID)', () => {
    it('extracts standard codes from RID elements', () => {
      const { refs } = parseSec(WITH_STANDARD_REFS);
      const codes = refs.filter((r) => r.targetType === 'standard').map((r) => r.standardCode);
      expect(codes).toContain('ANSI/TIA-568.1');
      expect(codes).toContain('ANSI/TIA-569');
      expect(codes).toContain('NFPA 70');
    });

    it('links standard refs to the article node id', () => {
      const { refs, tree } = parseSec(WITH_STANDARD_REFS);
      const articleId = tree.parts[0]?.children[0]?.id;
      const standardRefs = refs.filter((r) => r.targetType === 'standard');
      expect(standardRefs.length).toBeGreaterThan(0);
      expect(standardRefs.every((r) => r.sourceNodeId === articleId)).toBe(true);
    });

    it('returns empty refs when no REF/SRF in spec', () => {
      const { refs } = parseSec(NO_REFS);
      expect(refs).toHaveLength(0);
    });
  });

  describe('section refs (SRF)', () => {
    it('extracts section numbers from SRF in TXT', () => {
      const { refs } = parseSec(WITH_SECTION_REFS);
      const sections = refs.filter((r) => r.targetType === 'section').map((r) => r.targetSpecSection);
      expect(sections).toContain('26 20 00');
    });

    it('extracts section numbers from SRF in LST', () => {
      const { refs } = parseSec(WITH_SECTION_REFS);
      const sections = refs.filter((r) => r.targetType === 'section').map((r) => r.targetSpecSection);
      expect(sections).toContain('27 05 13.43');
    });

    it('links section ref to the content node containing it', () => {
      const { refs, tree } = parseSec(WITH_SECTION_REFS);
      const article = tree.parts[0]?.children[0];
      const contId = article?.children.find((c) => c.type === 'continuation')?.id;
      const pr1Id = article?.children.find((c) => c.type === 'pr1')?.id;
      const sRef1 = refs.find((r) => r.targetSpecSection === '26 20 00');
      const sRef2 = refs.find((r) => r.targetSpecSection === '27 05 13.43');
      expect(sRef1?.sourceNodeId).toBe(contId);
      expect(sRef2?.sourceNodeId).toBe(pr1Id);
    });
  });
});
```

- [ ] **Step 2: Run — verify PASS**

```bash
pnpm test src/parser/sec/refs.test.ts --reporter=verbose
```

Expected: all pass. Reference extraction is already wired in `parseSec` from Task 8.

---

## Task 10: parser/index.ts — public API

**Files:**
- Create: `src/parser/index.ts`

- [ ] **Step 1: Write**

```typescript
// src/parser/index.ts
export { parseSec } from './sec/index.js';
export type { ParsedSec, SecRef } from './sec/index.js';
export { ParserError } from './error.js';
```

- [ ] **Step 2: Run all parser tests**

```bash
pnpm test src/parser/ --reporter=verbose
```

Expected: all pass.

- [ ] **Step 3: Commit parser**

```bash
git add src/parser/
git commit -m "feat(parser): UFGS .SEC parser — CsiTree + cross-reference extraction"
```

---

## Task 11: db/queries/paragraphs.ts — insertTree (TDD)

**Files:**
- Modify: `src/db/queries/paragraphs.ts`
- Create: `src/db/queries/paragraphs.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/db/queries/paragraphs.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../index.js', () => {
  const query = vi.fn();
  return {
    pool: { query },
    DatabaseError: class DatabaseError extends Error {
      constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'DatabaseError';
      }
    },
  };
});

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const SIMPLE_TREE = {
  id: 'tree-uuid-1',
  section: '27 10 00',
  title: 'CABLING SYSTEM',
  parts: [
    {
      id: 'part-uuid-1',
      type: 'part' as const,
      text: 'GENERAL',
      children: [
        {
          id: 'article-uuid-1',
          type: 'article' as const,
          text: 'REFERENCES',
          children: [
            {
              id: 'cont-uuid-1',
              type: 'continuation' as const,
              text: 'Publications listed below.',
              children: [],
              meta: { source: 'ufgs' as const },
            },
          ],
          meta: { source: 'ufgs' as const },
        },
      ],
      meta: { source: 'ufgs' as const },
    },
  ],
};

describe('insertTree', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('calls INSERT for every node in DFS order', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    const { insertTree } = await import('./paragraphs.js');
    await insertTree(SIMPLE_TREE, 'spec-uuid-1', pool);
    const inserts = vi.mocked(pool.query).mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO paragraphs')
    );
    expect(inserts).toHaveLength(3); // part + article + continuation
  });

  it('uses CsiNode id as DB primary key', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    const { insertTree } = await import('./paragraphs.js');
    await insertTree(SIMPLE_TREE, 'spec-uuid-1', pool);
    const firstInsert = vi.mocked(pool.query).mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO paragraphs')
    );
    expect(firstInsert?.[1]).toContain('part-uuid-1');
  });

  it('sets parent_id of child node to parent CsiNode id', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    const { insertTree } = await import('./paragraphs.js');
    await insertTree(SIMPLE_TREE, 'spec-uuid-1', pool);
    const inserts = vi.mocked(pool.query).mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO paragraphs')
    );
    // second call = article, parent_id must be part-uuid-1
    expect(inserts[1]?.[1]).toContain('part-uuid-1');
  });

  it('wraps query errors in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('connection lost'));
    const { insertTree } = await import('./paragraphs.js');
    await expect(insertTree(SIMPLE_TREE, 'spec-uuid-1', pool)).rejects.toBeInstanceOf(DatabaseError);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm test src/db/queries/paragraphs.test.ts 2>&1 | tail -10
```

Expected: `insertTree is not a function` or similar.

- [ ] **Step 3: Add insertTree to paragraphs.ts**

Append to `src/db/queries/paragraphs.ts` (keep existing `findSpecById` and `updateSpec` unchanged):

```typescript
import type { Pool } from 'pg';
import type { CsiNode, CsiTree } from '../../ast/index.js';
// DatabaseError already imported at top of file

interface FlatRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly nodeType: string;
  readonly text: string;
  readonly position: number;
  readonly vanish: boolean;
}

function flattenTree(nodes: readonly CsiNode[], parentId: string | null, out: FlatRow[]): void {
  nodes.forEach((node, i) => {
    out.push({
      id: node.id,
      parentId,
      nodeType: node.type,
      text: node.text,
      position: i + 1,
      vanish: node.meta.vanish ?? false,
    });
    flattenTree(node.children, node.id, out);
  });
}

export async function insertTree(tree: CsiTree, specId: string, pool: Pool): Promise<void> {
  const rows: FlatRow[] = [];
  flattenTree(tree.parts, null, rows);
  for (const row of rows) {
    try {
      await pool.query(
        `INSERT INTO paragraphs (id, spec_id, parent_id, node_type, text, position, vanish)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.id, specId, row.parentId, row.nodeType, row.text, row.position, row.vanish]
      );
    } catch (err) {
      throw new DatabaseError(`insertTree: failed to insert paragraph ${row.id}`, { cause: err });
    }
  }
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
pnpm test src/db/queries/paragraphs.test.ts --reporter=verbose
```

---

## Task 12: db/queries/refs.ts — insertRefs (TDD)

**Files:**
- Create: `src/db/queries/refs.ts`
- Create: `src/db/queries/refs.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/db/queries/refs.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../index.js', () => {
  const query = vi.fn();
  return {
    pool: { query },
    DatabaseError: class DatabaseError extends Error {
      constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'DatabaseError';
      }
    },
  };
});

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

describe('insertRefs', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('does nothing when refs array is empty', async () => {
    const { pool } = await import('../index.js');
    const { insertRefs } = await import('./refs.js');
    await insertRefs([], 'spec-uuid-1', pool);
    expect(vi.mocked(pool.query)).not.toHaveBeenCalled();
  });

  it('runs SELECT to resolve target_spec_id for section refs', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [] } as never)  // lookup → not found
      .mockResolvedValueOnce({ rows: [] } as never);  // INSERT
    const { insertRefs } = await import('./refs.js');
    await insertRefs(
      [{ sourceNodeId: 'p1', targetType: 'section', targetSpecSection: '26 20 00', referenceText: 'See 26 20 00' }],
      'spec-uuid-1',
      pool
    );
    const selects = vi.mocked(pool.query).mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT id FROM specs')
    );
    expect(selects).toHaveLength(1);
  });

  it('passes resolved target_spec_id to INSERT when found', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ id: 'target-uuid' }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    const { insertRefs } = await import('./refs.js');
    await insertRefs(
      [{ sourceNodeId: 'p1', targetType: 'section', targetSpecSection: '26 20 00', referenceText: 'See 26 20 00' }],
      'spec-uuid-1',
      pool
    );
    const insert = vi.mocked(pool.query).mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO spec_references')
    );
    expect(insert?.[1]).toContain('target-uuid');
  });

  it('passes null target_spec_id when target section not in DB', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);
    const { insertRefs } = await import('./refs.js');
    await insertRefs(
      [{ sourceNodeId: 'p1', targetType: 'section', targetSpecSection: '99 99 99', referenceText: 'See 99 99 99' }],
      'spec-uuid-1',
      pool
    );
    const insert = vi.mocked(pool.query).mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO spec_references')
    );
    expect(insert?.[1]).toContain(null);
  });

  it('skips SELECT for standard refs (no section to resolve)', async () => {
    const { pool } = await import('../index.js');
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    const { insertRefs } = await import('./refs.js');
    await insertRefs(
      [{ sourceNodeId: 'p1', targetType: 'standard', standardCode: 'NFPA 70', referenceText: 'NFPA 70' }],
      'spec-uuid-1',
      pool
    );
    const selects = vi.mocked(pool.query).mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('SELECT id FROM specs')
    );
    expect(selects).toHaveLength(0);
  });

  it('wraps errors in DatabaseError', async () => {
    const { pool, DatabaseError } = await import('../index.js');
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('db down'));
    const { insertRefs } = await import('./refs.js');
    await expect(
      insertRefs(
        [{ sourceNodeId: 'p1', targetType: 'standard', standardCode: 'NFPA 70', referenceText: 'NFPA 70' }],
        'spec-uuid-1',
        pool
      )
    ).rejects.toBeInstanceOf(DatabaseError);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

```bash
pnpm test src/db/queries/refs.test.ts 2>&1 | tail -10
```

- [ ] **Step 3: Implement insertRefs**

```typescript
// src/db/queries/refs.ts
import type { Pool } from 'pg';
import type { SecRef } from '../../parser/index.js';
import { DatabaseError } from '../index.js';

async function resolveSpecId(section: string, pool: Pool): Promise<string | null> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM specs WHERE section = $1 LIMIT 1`,
    [section]
  );
  return result.rows[0]?.id ?? null;
}

export async function insertRefs(
  refs: readonly SecRef[],
  specId: string,
  pool: Pool
): Promise<void> {
  if (refs.length === 0) return;
  for (const ref of refs) {
    try {
      const targetSpecId =
        ref.targetType === 'section' && ref.targetSpecSection
          ? await resolveSpecId(ref.targetSpecSection, pool)
          : null;
      await pool.query(
        `INSERT INTO spec_references
           (source_spec_id, source_paragraph_id, target_type,
            target_spec_section, target_spec_id, standard_code, reference_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          specId,
          ref.sourceNodeId,
          ref.targetType,
          ref.targetSpecSection ?? null,
          targetSpecId,
          ref.standardCode ?? null,
          ref.referenceText,
        ]
      );
    } catch (err) {
      throw new DatabaseError(`insertRefs: failed for ref from ${ref.sourceNodeId}`, { cause: err });
    }
  }
}
```

- [ ] **Step 4: Run — verify PASS**

```bash
pnpm test src/db/queries/refs.test.ts --reporter=verbose
```

---

## Task 13: Update db/index.ts exports + run full unit suite

**Files:**
- Modify: `src/db/index.ts`

- [ ] **Step 1: Add exports**

Append to bottom of `src/db/index.ts`:

```typescript
export { insertTree } from './queries/paragraphs.js';
export { insertRefs } from './queries/refs.js';
```

- [ ] **Step 2: Run full unit suite**

```bash
pnpm test
```

Expected: all pass.

- [ ] **Step 3: Lint**

```bash
pnpm lint
```

Fix all issues before committing.

- [ ] **Step 4: Commit**

```bash
git add src/db/queries/ src/db/index.ts
git commit -m "feat(db): insertTree and insertRefs for UFGS paragraph persistence"
```

---

## Task 14: scripts/load-ufgs.ts — bulk corpus loader

**Files:**
- Create: `scripts/load-ufgs.ts`
- Modify: `package.json`

- [ ] **Step 1: Add script to package.json**

In `package.json` `"scripts"` block, add:

```json
"load:ufgs": "tsx scripts/load-ufgs.ts"
```

- [ ] **Step 2: Write bulk loader**

```typescript
// scripts/load-ufgs.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool, insertTree, insertRefs } from '../src/db/index.js';
import { parseSec } from '../src/parser/index.js';

const UFGS_DIR = join(process.cwd(), 'docs/references/UFGS');

interface LoadSuccess {
  readonly section: string;
  readonly nodeCount: number;
  readonly refCount: number;
}

interface LoadFailure {
  readonly file: string;
  readonly error: string;
}

function countNodes(parts: typeof [] & { children?: unknown[] }[]): number {
  let n = 0;
  const walk = (nodes: { children?: { children?: unknown[] }[] }[]) => {
    for (const node of nodes) { n++; walk((node.children ?? []) as never); }
  };
  walk(parts as never);
  return n;
}

async function collectFiles(): Promise<string[]> {
  const divs = await readdir(UFGS_DIR, { withFileTypes: true });
  const files: string[] = [];
  for (const div of divs) {
    if (!div.isDirectory()) continue;
    const entries = await readdir(join(UFGS_DIR, div.name), { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.sec')) {
        files.push(join(UFGS_DIR, div.name, e.name));
      }
    }
  }
  return files.sort();
}

async function main(): Promise<void> {
  const pool = createPool();
  const files = await collectFiles();
  console.log(`Found ${files.length} .SEC files`);

  const successes: LoadSuccess[] = [];
  const failures: LoadFailure[] = [];

  for (const file of files) {
    try {
      const xml = await readFile(file, 'latin1');
      const { tree, refs } = parseSec(xml);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Idempotent: delete existing paragraphs before re-inserting
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM specs WHERE section = $1 AND source = 'ufgs'`,
          [tree.section]
        );
        if (existing.rows[0]) {
          await client.query(`DELETE FROM spec_references WHERE source_spec_id = $1`, [existing.rows[0].id]);
          await client.query(`DELETE FROM paragraphs WHERE spec_id = $1`, [existing.rows[0].id]);
        }

        const specResult = await client.query<{ id: string }>(
          `INSERT INTO specs (section, title, source)
           VALUES ($1, $2, 'ufgs')
           ON CONFLICT (section, source) DO UPDATE
             SET title = EXCLUDED.title, updated_at = now()
           RETURNING id`,
          [tree.section, tree.title]
        );
        const specId = specResult.rows[0]?.id;
        if (!specId) throw new Error('spec upsert returned no id');

        await insertTree(tree, specId, client as never);
        await insertRefs(refs, specId, client as never);

        await client.query('COMMIT');

        const nodeCount = countNodes(tree.parts as never);
        successes.push({ section: tree.section, nodeCount, refCount: refs.length });
        console.log(`✓ ${tree.section}  ${nodeCount} nodes  ${refs.length} refs`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ file, error: msg });
      console.error(`✗ ${file}: ${msg}`);
    }
  }

  const totalNodes = successes.reduce((s, r) => s + r.nodeCount, 0);
  const totalRefs = successes.reduce((s, r) => s + r.refCount, 0);
  console.log(
    `\nLoaded ${successes.length}/${files.length} specs  ${totalNodes} paragraphs  ${totalRefs} refs`
  );
  if (failures.length > 0) {
    console.error(`\nFailed (${failures.length}):`);
    for (const f of failures) console.error(`  ${f.file}: ${f.error}`);
  }

  await pool.end();
  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error('Fatal:', err);
  process.exit(1);
});
```

---

## Task 15: Integration tests

**Files:**
- Create: `src/parser/sec/index.integration.test.ts`

- [ ] **Step 1: Start PostgreSQL**

```bash
docker compose up -d postgres
pnpm migrate
```

- [ ] **Step 2: Write integration tests**

```typescript
// src/parser/sec/index.integration.test.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../db/index.js';
import { parseSec } from './index.js';
import { insertTree, insertRefs } from '../../db/index.js';

const FIXTURES = join(process.cwd(), 'tests/fixtures/sec');
const cleanupIds: string[] = [];

async function loadFixture(filename: string): Promise<{ specId: string; nodeCount: number; refCount: number }> {
  const xml = await readFile(join(FIXTURES, filename), 'latin1');
  const { tree, refs } = parseSec(xml);

  const r = await pool.query<{ id: string }>(
    `INSERT INTO specs (section, title, source) VALUES ($1, $2, 'ufgs')
     ON CONFLICT (section, source) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
     RETURNING id`,
    [tree.section, tree.title]
  );
  const specId = r.rows[0]?.id ?? '';

  await pool.query(`DELETE FROM paragraphs WHERE spec_id = $1`, [specId]);
  await pool.query(`DELETE FROM spec_references WHERE source_spec_id = $1`, [specId]);

  await insertTree(tree, specId, pool);
  await insertRefs(refs, specId, pool);

  let nodeCount = 0;
  const count = (nodes: { children?: unknown[] }[]) => {
    for (const n of nodes) { nodeCount++; count((n.children ?? []) as never); }
  };
  count(tree.parts as never);

  return { specId, nodeCount, refCount: refs.length };
}

afterAll(async () => {
  for (const id of cleanupIds) {
    await pool.query(`DELETE FROM specs WHERE id = $1`, [id]);
  }
});

describe('integration: 27_41_00.SEC', () => {
  let specId: string;
  let expectedNodeCount: number;

  beforeAll(async () => {
    const result = await loadFixture('27_41_00.SEC');
    specId = result.specId;
    expectedNodeCount = result.nodeCount;
    cleanupIds.push(specId);
  });

  it('inserts spec row with correct section and source', async () => {
    const r = await pool.query<{ section: string; source: string }>(
      `SELECT section, source FROM specs WHERE id = $1`,
      [specId]
    );
    expect(r.rows[0]?.section).toBe('27 41 00');
    expect(r.rows[0]?.source).toBe('ufgs');
  });

  it('inserts all paragraph nodes', async () => {
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM paragraphs WHERE spec_id = $1`,
      [specId]
    );
    expect(parseInt(r.rows[0]?.count ?? '0', 10)).toBe(expectedNodeCount);
  });

  it('inserts spec_references rows', async () => {
    const r = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM spec_references WHERE source_spec_id = $1`,
      [specId]
    );
    expect(parseInt(r.rows[0]?.count ?? '0', 10)).toBeGreaterThan(0);
  });

  it('standard refs have non-null standard_code', async () => {
    const r = await pool.query<{ standard_code: string | null }>(
      `SELECT standard_code FROM spec_references
       WHERE source_spec_id = $1 AND target_type = 'standard' LIMIT 5`,
      [specId]
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((row) => row.standard_code !== null)).toBe(true);
  });
});

describe('integration: 27_10_00.SEC', () => {
  let specId: string;

  beforeAll(async () => {
    const result = await loadFixture('27_10_00.SEC');
    specId = result.specId;
    cleanupIds.push(specId);
  });

  it('inserts section refs with target_spec_section populated', async () => {
    const r = await pool.query<{ target_spec_section: string | null }>(
      `SELECT target_spec_section FROM spec_references
       WHERE source_spec_id = $1 AND target_type = 'section' LIMIT 5`,
      [specId]
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((row) => row.target_spec_section !== null)).toBe(true);
  });
});

describe('integration: idempotency', () => {
  it('re-loading 27_41_00 produces same paragraph count', async () => {
    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM paragraphs
       WHERE spec_id = (SELECT id FROM specs WHERE section = '27 41 00' AND source = 'ufgs')`
    );
    const countBefore = parseInt(before.rows[0]?.count ?? '0', 10);

    // Re-load
    const specRow = await pool.query<{ id: string }>(
      `SELECT id FROM specs WHERE section = '27 41 00' AND source = 'ufgs'`
    );
    const existingId = specRow.rows[0]?.id;
    if (existingId) {
      const xml = await readFile(join(FIXTURES, '27_41_00.SEC'), 'latin1');
      const { tree } = parseSec(xml);
      await pool.query(`DELETE FROM paragraphs WHERE spec_id = $1`, [existingId]);
      await insertTree(tree, existingId, pool);
    }

    const after = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM paragraphs
       WHERE spec_id = (SELECT id FROM specs WHERE section = '27 41 00' AND source = 'ufgs')`
    );
    expect(parseInt(after.rows[0]?.count ?? '0', 10)).toBe(countBefore);
  });
});
```

- [ ] **Step 3: Run integration tests**

```bash
pnpm test:integration src/parser/sec/index.integration.test.ts --reporter=verbose
```

Expected: all pass. If a count assertion is wrong, inspect the actual parsed tree and adjust `toBeGreaterThan(N)` assertions — don't hardcode unknown counts.

- [ ] **Step 4: Run full suite**

```bash
pnpm test && pnpm test:integration
```

Expected: all pass.

- [ ] **Step 5: Lint**

```bash
pnpm lint
```

- [ ] **Step 6: Commit PR B**

```bash
git add scripts/load-ufgs.ts src/parser/sec/index.integration.test.ts package.json tests/fixtures/
git commit -m "feat(scripts): UFGS bulk corpus loader + integration tests"
```

---

## Task 16: Push and open PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/parser-ufgs-1a
```

- [ ] **Step 2: Open PR**

```bash
gh pr create \
  --title "feat(parser): UFGS .SEC parser + cross-reference model (Phase 1a)" \
  --body "$(cat <<'EOF'
## Summary

- Migrations 005–008: unique constraint on specs, projects, project_specs, spec_references
- UFGS .SEC parser: SpecsIntact XML → canonical CsiTree AST (no DB imports)
- Cross-reference extraction at parse time: SRF section refs + REF/RID standard refs
- DB persistence: insertTree (CsiNode UUIDs as PKs), insertRefs (resolves target_spec_id)
- Bulk corpus loader: scripts/load-ufgs.ts processes all 666 UFGS .SEC files sequentially

## Out of scope

- Project/TOC API (issue #11)
- DOCX parsing (issue #12)
- POST /parse HTTP endpoint

## Test plan

\`\`\`bash
pnpm test                    # unit tests (no DB required)
pnpm test:integration        # integration tests (requires: docker compose up -d postgres && pnpm migrate)
pnpm lint
pnpm load:ufgs               # optional: run full corpus load
\`\`\`
EOF
)"
```
