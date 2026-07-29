import { describe, expect, it } from 'vitest';
import { lineCount, MAX_LINES } from '../test-utils/line-budget.js';

// ─── Invariant (#380 task 8): src/db/index.ts stays under the repo's 400-line
// hard cap (eslint.config.js max-lines) after every task in this feature ──
//
// The ADR-052 design spike found this file exactly AT the 400-line cap before
// task 7's flatten-to-`export *` groundwork; task 8 adds a further barrel
// export (checkpoint-index.ts). A dedicated test — mirroring the precedent in
// src/ast/schemas-line-budget.test.ts and src/parser/docx/line-budget.test.ts —
// pins this as a standing regression guard: a future addition that pushes the
// barrel back over budget fails here with the exact file and count, not a
// generic `pnpm lint` diagnostic discovered later.

describe('src/db/index.ts line budget (#380)', () => {
  it('stays at or under the 400-line hard cap', () => {
    expect(lineCount(import.meta.url, './index.ts')).toBeLessThanOrEqual(MAX_LINES);
  });
});
