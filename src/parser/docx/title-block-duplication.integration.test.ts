import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocx } from './index.js';

// A real hand-authored artifact whose opening body text types the "SECTION <n>" /
// title lines out longhand ("SECTION 01 8813.13" / the section's own title),
// duplicating the generator's injected canonical heading on round-trip (#510).
// Before the fix these two lines survived as continuation SpecNodes at the root of
// the tree, ahead of the first real PART. The file is gitignored manufacturer
// example data — present only in local dev, so the suite skips automatically in CI.
const ARTIFACT = resolve('docs/references/MANUFACTURER_EXAMPLES/parsing-needs-fixing.docx');

describe.runIf(existsSync(ARTIFACT))(
  '#510 leading title-block suppression — a hand-authored doc',
  () => {
    it('drops the leading SECTION-line + title-line pair, leaving only PART roots', async () => {
      const buffer = readFileSync(ARTIFACT);
      const tree = await parseDocx(buffer);

      // No root continuation re-types the tree's own already-resolved identity.
      const leakedIdentityRoots = tree.parts.filter(
        (n) =>
          n.type !== 'part' &&
          (n.text.trim().toUpperCase() === tree.title.trim().toUpperCase() ||
            n.text.replace(/^SECTION\s+/i, '').trim() === tree.section)
      );
      expect(leakedIdentityRoots).toHaveLength(0);

      // Every root is a real PART heading — the duplicated lines produced no
      // SpecNode at all, matching the #292 "suppressed -> no SpecNode" precedent.
      expect(tree.parts.every((n) => n.type === 'part')).toBe(true);
    });
  }
);
