import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../index.js';
import type { ParseOptions } from '../index.js';
import { renderMarkdown } from '../../generator/markdown.js';
import type { SpecNode, SpecTree } from '../../ast/types.js';
import type { NumberingProfile } from '../../ast/index.js';

const FIXTURE = resolve('tests/fixtures/libreoffice/csi-spec-sample.docx');
const NAME = 'csi-spec-sample.docx';

// Node ids are uuidv4() per parse, so two separate parses differ on ids alone.
// Project to a deterministic id-free shape to assert STRUCTURAL byte-for-byte
// identity (type/text/meta/children-shape) — the real backward-compat invariant.
function strip(node: SpecNode): unknown {
  return { type: node.type, text: node.text, meta: node.meta, children: node.children.map(strip) };
}
function project(tree: SpecTree): unknown {
  return {
    section: tree.section,
    title: tree.title,
    parts: tree.parts.map(strip),
    warnings: tree.warnings,
  };
}

// The built-in 'CSI Default' the API injects for un-onboarded specs.
const CSI_DEFAULT: NumberingProfile = {
  tiers: { part: { numberStyle: 'integer', maxCount: 5 } },
  numbering: [],
  styleLadder: [],
};

describe.skipIf(!existsSync(FIXTURE))('#299 numbering profile — backward-compat invariant', () => {
  it('INV1: no-profile parse is byte-for-byte identical to today (clean LibreOffice fixture)', async () => {
    const buf = readFileSync(FIXTURE);
    const without = await parse(buf, NAME);
    // exactOptionalPropertyTypes forbids `{ numberingProfile: undefined }`; the
    // canonical "no profile provided" is the key absent. Passing an options object
    // without a profile must reach the identical inference-only path as no options.
    const noProfile: ParseOptions = {};
    const explicitNoProfile = await parse(buf, NAME, noProfile);

    expect(project(explicitNoProfile.tree)).toEqual(project(without.tree));
    expect(renderMarkdown(explicitNoProfile.tree)).toBe(renderMarkdown(without.tree));
    expect(explicitNoProfile.sectionInference).toEqual(without.sectionInference);
  });

  it('INV2: empty CSI-default profile is a no-op (the injected built-in changes nothing)', async () => {
    const buf = readFileSync(FIXTURE);
    const without = await parse(buf, NAME);
    const withDefault = await parse(buf, NAME, { numberingProfile: CSI_DEFAULT });

    expect(project(withDefault.tree)).toEqual(project(without.tree));
    expect(renderMarkdown(withDefault.tree)).toBe(renderMarkdown(without.tree));
    expect(withDefault.sectionInference).toEqual(without.sectionInference);
  });
});

// Extend the backward-compat invariant to both real-fixture families
// (#299 review): a reserved-low-level DOCX reserves ilvl 1–2 for a Schedule/Product-Data
// block and normalizes differently from the no-reserved-levels family, so the no-profile / empty-CSI-default path is
// pinned against BOTH families — the riskiest normalization split. Fixtures are
// licensing-restricted (gitignored): these skip locally and run in CI where
// docs/references/* is present.
const ARCAT_FIXTURE = resolve('docs/references/ARCAT/07_21_00ksp.docx');
const CPI_FIXTURE = resolve('docs/references/MANUFACTURER_CPI/CPI_BUSBAR_CSIMFS.docx');

describe.skipIf(!existsSync(ARCAT_FIXTURE))(
  '#299 numbering profile — articleIlvl=1 backward-compat',
  () => {
    it('INV1/INV2: no-profile and empty-CSI-default parses match the inference-only tree (articleIlvl=1 family)', async () => {
      const buf = readFileSync(ARCAT_FIXTURE);
      const without = await parse(buf, 'arcat.docx');
      const explicitNoProfile = await parse(buf, 'arcat.docx', {});
      const withDefault = await parse(buf, 'arcat.docx', { numberingProfile: CSI_DEFAULT });

      expect(project(explicitNoProfile.tree)).toEqual(project(without.tree));
      expect(project(withDefault.tree)).toEqual(project(without.tree));
      expect(renderMarkdown(withDefault.tree)).toBe(renderMarkdown(without.tree));
    });
  }
);

describe.skipIf(!existsSync(CPI_FIXTURE))(
  '#299 numbering profile — articleIlvl=3 (reserved-low-level) backward-compat',
  () => {
    it('INV1/INV2: no-profile and empty-CSI-default parses match the inference-only tree (ilvl 1–2 offset)', async () => {
      const buf = readFileSync(CPI_FIXTURE);
      const without = await parse(buf, 'cpi.docx');
      const explicitNoProfile = await parse(buf, 'cpi.docx', {});
      const withDefault = await parse(buf, 'cpi.docx', { numberingProfile: CSI_DEFAULT });

      expect(project(explicitNoProfile.tree)).toEqual(project(without.tree));
      expect(project(withDefault.tree)).toEqual(project(without.tree));
      expect(renderMarkdown(withDefault.tree)).toBe(renderMarkdown(without.tree));
    });
  }
);
