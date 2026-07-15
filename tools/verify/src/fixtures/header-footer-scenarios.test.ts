// Header/footer fixture scenario catalog tests (#305 task 4/7). No live
// API/DB — buildScenarioReferenceDocx runs entirely offline against the
// `docx` package, so every assertion here reads the produced zip directly.
//
// The core invariant this file pins (per the design's spike finding 1
// correction): a scenario's section/title identity round-trips through
// docProps/core.xml's dc:subject/dc:title — the exact part the real
// parser's parseCoreMetadata reads (src/parser/docx/core-metadata.ts) —
// never through body text. This file cannot import that parser directly
// (tools/verify has zero import from repo-root src/, pinned by
// import-boundary.test.ts), so the assertions below read the generated
// XML at the string level instead, per this task's own design note.

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { VerifyRenderError } from '../errors.js';
import { assertPageNumberingRestart } from './assert-page-numbering.js';
import {
  HEADER_FOOTER_SCENARIOS,
  buildScenarioReferenceDocx,
  findScenario,
  type HeaderFooterScenarioId,
} from './header-footer-scenarios.js';

async function loadZip(buffer: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buffer);
}

async function readEntry(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  expect(entry).not.toBeNull();
  return entry!.async('string');
}

describe('HEADER_FOOTER_SCENARIOS', () => {
  it('covers exactly the five documented scenario ids', () => {
    expect(HEADER_FOOTER_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      'default',
      'first',
      'even',
      'fields',
      'restartPerSpec',
    ]);
  });
});

describe('findScenario', () => {
  it('returns the matching catalog entry for each known id', () => {
    for (const scenario of HEADER_FOOTER_SCENARIOS) {
      expect(findScenario(scenario.id)).toBe(scenario);
    }
  });

  it('throws VerifyRenderError for an id outside the closed catalog', () => {
    expect(() => findScenario('bogus' as HeaderFooterScenarioId)).toThrow(VerifyRenderError);
  });
});

describe('buildScenarioReferenceDocx', () => {
  it.each(HEADER_FOOTER_SCENARIOS)(
    'produces a readable zip carrying its own section/title in core.xml, not body text ($id)',
    async (scenario) => {
      const buffer = await buildScenarioReferenceDocx(scenario);
      const zip = await loadZip(buffer);

      expect(zip.file('word/document.xml')).not.toBeNull();
      const coreXml = await readEntry(zip, 'docProps/core.xml');
      expect(coreXml).toContain(`<dc:subject>${scenario.section}</dc:subject>`);
      expect(coreXml).toContain(`<dc:title>${scenario.title}</dc:title>`);
    }
  );

  it("'default' scenario resolves its footer sectionNumber field to the scenario's own section", async () => {
    const scenario = findScenario('default');
    const zip = await loadZip(await buildScenarioReferenceDocx(scenario));

    const headerXml = await readEntry(zip, 'word/header1.xml');
    expect(headerXml).toContain('PROJECT MASTER');
    const footerXml = await readEntry(zip, 'word/footer1.xml');
    expect(footerXml).toContain(scenario.section);
  });

  it("'fields' scenario resolves header/footer fields from section identity, not literal text", async () => {
    const scenario = findScenario('fields');
    const zip = await loadZip(await buildScenarioReferenceDocx(scenario));

    const headerXml = await readEntry(zip, 'word/header1.xml');
    expect(headerXml).toContain(scenario.section);
    const footerXml = await readEntry(zip, 'word/footer1.xml');
    expect(footerXml).toContain(scenario.title);
  });

  it("'first' scenario emits a distinct first-page header and enables titlePg", async () => {
    const scenario = findScenario('first');
    const zip = await loadZip(await buildScenarioReferenceDocx(scenario));

    const documentXml = await readEntry(zip, 'word/document.xml');
    expect(documentXml).toContain('<w:titlePg/>');
    // A run-level page break (`<w:br w:type="page"/>`), not the pPr-level
    // `pageBreakBefore` property — docx-preview 0.4.0 only honors the
    // latter when it comes from a named style, never a paragraph's own
    // direct override (see buildBodyChildren's docstring).
    expect(documentXml).toContain('<w:br w:type="page"/>');
    const defaultHeaderXml = await readEntry(zip, 'word/header1.xml');
    expect(defaultHeaderXml).toContain('CONTINUATION');
    const firstHeaderXml = await readEntry(zip, 'word/header2.xml');
    expect(firstHeaderXml).toContain('COVER PAGE');
  });

  it("'even' scenario emits a distinct even-page header and enables evenAndOddHeaders", async () => {
    const scenario = findScenario('even');
    const zip = await loadZip(await buildScenarioReferenceDocx(scenario));

    const settingsXml = await readEntry(zip, 'word/settings.xml');
    expect(settingsXml).toContain('evenAndOddHeaders');
    const defaultHeaderXml = await readEntry(zip, 'word/header1.xml');
    expect(defaultHeaderXml).toContain('ODD PAGE');
    const evenHeaderXml = await readEntry(zip, 'word/header2.xml');
    expect(evenHeaderXml).toContain('EVEN PAGE');
  });

  it("'restartPerSpec' scenario's own DOCX satisfies assertPageNumberingRestart at its own startAt", async () => {
    const scenario = findScenario('restartPerSpec');
    const buffer = await buildScenarioReferenceDocx(scenario);
    const startAt = scenario.composition.pageNumbering?.startAt;
    expect(startAt).toBeDefined();

    await expect(assertPageNumberingRestart(buffer, startAt!)).resolves.toBeUndefined();
  });
});
