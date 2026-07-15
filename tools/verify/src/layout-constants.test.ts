// Pins layout-constants.ts's own extraction invariant before trusting it:
// the synthetic-fixture cases below prove the detector actually reads
// #layout/#panes's grid-template-columns declarations (and fails loudly on
// malformed CSS), then the final case proves it against the REAL, shipped
// public/index.html — the artifact config.test.ts's viewport-margin
// invariant (issue #150 finding 7) depends on.
import { describe, expect, it } from 'vitest';
import {
  extractPaneColumnCount,
  extractSidebarWidthPx,
  readHarnessIndexHtml,
} from './layout-constants.js';

const syntheticHtml = `
<style>
  #layout {
    display: grid;
    grid-template-columns: 1fr 320px;
  }
  #panes {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
  }
</style>
`;

describe('extractSidebarWidthPx', () => {
  it("reads the fixed sidebar width from #layout's grid-template-columns", () => {
    expect(extractSidebarWidthPx(syntheticHtml)).toBe(320);
  });

  it('throws when #layout has no rule at all', () => {
    expect(() => extractSidebarWidthPx('<style></style>')).toThrow(/#layout/);
  });

  it('throws when #layout has no grid-template-columns declaration', () => {
    const html = '<style>#layout { display: grid; }</style>';
    expect(() => extractSidebarWidthPx(html)).toThrow(/grid-template-columns/);
  });

  it('throws when #layout columns have no pixel width', () => {
    const html = '<style>#layout { grid-template-columns: 1fr 1fr; }</style>';
    expect(() => extractSidebarWidthPx(html)).toThrow(/pixel width/);
  });
});

describe('extractPaneColumnCount', () => {
  it("reads the pane column count from #panes's grid-template-columns", () => {
    expect(extractPaneColumnCount(syntheticHtml)).toBe(3);
  });

  it('throws when #panes has no rule at all', () => {
    expect(() => extractPaneColumnCount('<style></style>')).toThrow(/#panes/);
  });

  it('throws when #panes columns are not a repeat(N, ...) expression', () => {
    const html = '<style>#panes { grid-template-columns: 1fr 1fr 1fr; }</style>';
    expect(() => extractPaneColumnCount(html)).toThrow(/repeat/);
  });
});

describe('readHarnessIndexHtml against the real shipped page', () => {
  it('reads the real public/index.html current sidebar width and pane count', () => {
    const html = readHarnessIndexHtml();

    expect(extractSidebarWidthPx(html)).toBe(320);
    expect(extractPaneColumnCount(html)).toBe(3);
  });
});
