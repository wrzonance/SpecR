import { describe, expect, it } from 'vitest';
import { lineCount, MAX_LINES } from '../test-utils/line-budget.js';

// ─── Invariant (#567 task 7): src/mcp/handlers.ts and src/mcp/tools.ts stay
// under the repo's 400-line hard cap (eslint.config.js max-lines) after every
// edit in this feature ──
//
// #567 folded get_spec's withdrawnAt, the generate_docx readiness-gate
// wiring, the submittal_register duplicate-id guard, and the parse_document
// extension/override fixes into these two files. generate_docx's branching
// alone was extracted to generate-docx-handler.ts specifically to keep
// handlers.ts under budget (see the design's decision #2) — this test pins
// that outcome as a standing regression guard, mirroring the precedent in
// src/db/index-line-budget.test.ts: a future addition that pushes either
// file back over budget fails here with the exact file and count, not a
// generic `pnpm lint` diagnostic discovered later.

describe('src/mcp/handlers.ts and tools.ts line budget (#567)', () => {
  it('handlers.ts stays at or under the 400-line hard cap', () => {
    expect(lineCount(import.meta.url, './handlers.ts')).toBeLessThanOrEqual(MAX_LINES);
  });

  it('tools.ts stays at or under the 400-line hard cap', () => {
    expect(lineCount(import.meta.url, './tools.ts')).toBeLessThanOrEqual(MAX_LINES);
  });
});
