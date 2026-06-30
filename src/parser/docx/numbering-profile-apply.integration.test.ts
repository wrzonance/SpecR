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
  it('INV1: no-profile parse is byte-for-byte identical to today (ARCAT-clean LibreOffice fixture)', async () => {
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
