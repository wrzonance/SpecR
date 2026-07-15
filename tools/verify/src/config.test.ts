import { describe, expect, it } from 'vitest';
import { loadVerifyEnv } from './config.js';
import { VerifyValidationError, toRunError } from './errors.js';
import {
  extractPaneColumnCount,
  extractSidebarWidthPx,
  readHarnessIndexHtml,
} from './layout-constants.js';

const validEnv = {
  SPECR_API_BASE_URL: 'http://localhost:3000',
  VERIFY_VIEWPORT_WIDTH: '3200',
};

describe('loadVerifyEnv', () => {
  it('loads a valid env into camelCase VerifyEnv fields', () => {
    expect(loadVerifyEnv(validEnv)).toEqual({
      specrApiBaseUrl: 'http://localhost:3000',
      viewportWidth: 3200,
      port: 4300,
    });
  });

  it('defaults viewportWidth to 3200 when VERIFY_VIEWPORT_WIDTH is unset', () => {
    const env = { SPECR_API_BASE_URL: 'http://localhost:3000' };

    expect(loadVerifyEnv(env).viewportWidth).toBe(3200);
  });

  it('defaults port to 4300 when VERIFY_PORT is unset', () => {
    const env = { SPECR_API_BASE_URL: 'http://localhost:3000' };

    expect(loadVerifyEnv(env).port).toBe(4300);
  });

  it('loads a custom VERIFY_PORT', () => {
    expect(loadVerifyEnv({ ...validEnv, VERIFY_PORT: '5000' }).port).toBe(5000);
  });

  it('throws VerifyValidationError when VERIFY_PORT is not numeric', () => {
    expect(() => loadVerifyEnv({ ...validEnv, VERIFY_PORT: 'not-a-number' })).toThrow(
      VerifyValidationError
    );
  });

  it('throws VerifyValidationError when VERIFY_PORT is zero or negative', () => {
    expect(() => loadVerifyEnv({ ...validEnv, VERIFY_PORT: '0' })).toThrow(VerifyValidationError);
    expect(() => loadVerifyEnv({ ...validEnv, VERIFY_PORT: '-1' })).toThrow(VerifyValidationError);
  });

  it('ignores unrelated keys already present on process.env (PATH, HOME, ...)', () => {
    const env = { ...validEnv, PATH: '/usr/bin', HOME: '/home/whoever', RANDOM_UNRELATED: 'x' };

    expect(loadVerifyEnv(env)).toEqual({
      specrApiBaseUrl: 'http://localhost:3000',
      viewportWidth: 3200,
      port: 4300,
    });
  });

  it('throws VerifyValidationError (stage: config) when SPECR_API_BASE_URL is missing', () => {
    expect(() => loadVerifyEnv({})).toThrow(VerifyValidationError);
    try {
      loadVerifyEnv({});
      expect.unreachable('loadVerifyEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(VerifyValidationError);
      expect((error as VerifyValidationError).stage).toBe('config');
      expect((error as VerifyValidationError).cause).toBeDefined();
    }
  });

  it('throws VerifyValidationError when SPECR_API_BASE_URL is not a valid URL', () => {
    const env = { ...validEnv, SPECR_API_BASE_URL: 'not-a-url' };

    expect(() => loadVerifyEnv(env)).toThrow(VerifyValidationError);
  });

  it('throws VerifyValidationError when VERIFY_VIEWPORT_WIDTH is not numeric', () => {
    const env = { ...validEnv, VERIFY_VIEWPORT_WIDTH: 'not-a-number' };

    expect(() => loadVerifyEnv(env)).toThrow(VerifyValidationError);
  });

  it('throws VerifyValidationError when VERIFY_VIEWPORT_WIDTH is zero or negative', () => {
    expect(() => loadVerifyEnv({ ...validEnv, VERIFY_VIEWPORT_WIDTH: '0' })).toThrow(
      VerifyValidationError
    );
    expect(() => loadVerifyEnv({ ...validEnv, VERIFY_VIEWPORT_WIDTH: '-3200' })).toThrow(
      VerifyValidationError
    );
  });

  // Pins the task-8 manual-smoke-test finding (config.ts's VerifyEnv.viewportWidth
  // docstring): confirmed via Playwright that below ~2768px, docx-preview's
  // centered Letter-width (816 CSS px) page overflows the reference pane's
  // column of public/index.html's 3-column grid (sidebar fixed at 320px),
  // driving pageGeom.x negative even at a "pinned" viewport. The sidebar
  // width and pane-column count below are read from the REAL, shipped
  // public/index.html (layout-constants.ts), not duplicated as literals that
  // could silently drift from it — so a future change to any of them
  // (default width, sidebar width, or page width) that reopens the gap fails
  // loudly here, not silently in a real capture.
  it('default viewportWidth leaves a positive margin for the widest common page in the 3-pane grid', () => {
    // LETTER_PAGE_WIDTH_PX is a physical-unit fact (8.5in @ 96 CSS px/in, the
    // wider of Letter/A4 at that resolution) — it names a page size
    // docx-preview centers, not a public/index.html CSS rule, so there is
    // nothing to read it from; it stays a literal here by design.
    const LETTER_PAGE_WIDTH_PX = 816;

    const indexHtml = readHarnessIndexHtml();
    const sidebarWidthPx = extractSidebarWidthPx(indexHtml);
    const paneColumnCount = extractPaneColumnCount(indexHtml);

    const { viewportWidth } = loadVerifyEnv({ SPECR_API_BASE_URL: 'http://localhost:3000' });
    const paneColumnWidth = (viewportWidth - sidebarWidthPx) / paneColumnCount;
    const margin = (paneColumnWidth - LETTER_PAGE_WIDTH_PX) / 2;

    expect(margin).toBeGreaterThan(0);
  });

  it('a config failure converts into a serializable RunError carrying stage, message, and cause', () => {
    let thrown: unknown;
    try {
      loadVerifyEnv({});
    } catch (error) {
      thrown = error;
    }

    const runError = toRunError('config', thrown);

    expect(runError.stage).toBe('config');
    expect(runError.message).toBe('invalid tools/verify environment configuration');
    expect(runError.cause).toBeDefined();
    expect(JSON.parse(JSON.stringify(runError))).toEqual(runError);
  });
});
