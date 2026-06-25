import { describe, expect, it } from 'vitest';
import type { ParagraphAssociation, SpecNode, SpecTree } from '../ast/index.js';
import { buildSubmittalRegister } from './index.js';

const emptyMeta = {};

function assoc(id: string, label: string): ParagraphAssociation {
  return {
    id,
    label,
    url: `https://example.test/${id}.pdf`,
    externalMetadata: {},
    createdAt: '2026-06-24T00:00:00.000Z',
  };
}

function node(
  id: string,
  type: SpecNode['type'],
  text: string,
  children: readonly SpecNode[] = [],
  associations: readonly ParagraphAssociation[] = []
): SpecNode {
  return {
    id,
    type,
    text,
    children,
    meta: associations.length > 0 ? { associations } : emptyMeta,
  };
}

function spec(id: string, section: string, title: string, parts: readonly SpecNode[]): SpecTree {
  return { id, section, title, parts };
}

function part1WithSubmittals(...items: string[]): SpecNode {
  return node('p1', 'part', 'PART 1 - GENERAL', [
    node(
      'submittals',
      'article',
      'SUBMITTALS',
      items.map((text, index) => node(`sub-${index}`, 'pr1', text)),
      []
    ),
  ]);
}

function productsPart(...products: SpecNode[]): SpecNode {
  return node('p2', 'part', 'PART 2 - PRODUCTS', products);
}

function executionPart(...items: SpecNode[]): SpecNode {
  return node('p3', 'part', 'PART 3 - EXECUTION', items);
}

describe('buildSubmittalRegister', () => {
  it('submittals: two selected specs with Part 2 products -> rows with source, required types, datasheets, and deduped identical products', () => {
    const first = spec('spec-a', '27 11 00', 'Communications Rooms', [
      part1WithSubmittals('SD-03 Product Data', 'SD-02 Shop Drawings'),
      productsPart(
        node('patch-a', 'article', 'PATCH PANELS', [], [assoc('ds-a', 'Patch panel datasheet')]),
        node('rack-a', 'article', 'EQUIPMENT RACKS', [], [assoc('ds-rack', 'Rack datasheet')])
      ),
    ]);
    const second = spec('spec-b', '27 13 00', 'Communications Backbone', [
      part1WithSubmittals('Product Data'),
      productsPart(
        node('patch-b', 'article', 'PATCH PANELS', [], [assoc('ds-b', 'Patch panel B')])
      ),
    ]);

    const register = buildSubmittalRegister([first, second]);

    expect(register.rows.map((row) => row.productName)).toEqual([
      'Patch Panels',
      'Equipment Racks',
    ]);
    const patchPanels = register.rows.find((row) => row.productName === 'Patch Panels');
    expect(patchPanels?.requiredSubmittalTypes).toEqual(['Product Data', 'Shop Drawings']);
    expect(patchPanels?.sources.map((source) => source.section)).toEqual(['27 11 00', '27 13 00']);
    expect(patchPanels?.sources.map((source) => source.paragraphId)).toEqual([
      'patch-a',
      'patch-b',
    ]);
    expect(patchPanels?.datasheets.map((sheet) => sheet.label)).toEqual([
      'Patch panel datasheet',
      'Patch panel B',
    ]);
    const rack = register.rows.find((row) => row.productName === 'Equipment Racks');
    expect(rack?.requiredSubmittalTypes).toEqual(['Product Data', 'Shop Drawings']);
    expect(register.summary.rows).toBe(2);
  });

  it('submittals: Part 2 product with no required submittal type -> product_without_submittal_type', () => {
    const tree = spec('spec-a', '08 71 00', 'Door Hardware', [
      node('p1', 'part', 'PART 1 - GENERAL', [node('submittals', 'article', 'SUBMITTALS')]),
      productsPart(node('closers', 'article', 'DOOR CLOSERS', [], [assoc('ds-closers', 'Closer')])),
    ]);

    const register = buildSubmittalRegister([tree]);

    expect(register.findings).toEqual([
      {
        type: 'product_without_submittal_type',
        specId: 'spec-a',
        sourceSpecSection: '08 71 00',
        productName: 'Door Closers',
        sourceParagraphId: 'closers',
      },
    ]);
    expect(register.summary.productWithoutSubmittalType).toBe(1);
  });

  it('submittals: required submittal type with no specifying product -> submittal_type_without_product', () => {
    const tree = spec('spec-a', '09 90 00', 'Painting', [
      part1WithSubmittals('Product Data', 'Samples'),
      productsPart(),
    ]);

    const register = buildSubmittalRegister([tree]);

    expect(register.rows).toHaveLength(0);
    expect(register.findings).toEqual([
      {
        type: 'submittal_type_without_product',
        specId: 'spec-a',
        sourceSpecSection: '09 90 00',
        submittalType: 'Product Data',
      },
      {
        type: 'submittal_type_without_product',
        specId: 'spec-a',
        sourceSpecSection: '09 90 00',
        submittalType: 'Samples',
      },
    ]);
    expect(register.summary.submittalTypeWithoutProduct).toBe(2);
  });

  it('submittals: specified product with no datasheet association -> product_missing_datasheet', () => {
    const tree = spec('spec-a', '07 92 00', 'Joint Sealants', [
      part1WithSubmittals('Product Data'),
      productsPart(node('sealants', 'article', 'JOINT SEALANTS')),
    ]);

    const register = buildSubmittalRegister([tree]);

    expect(register.findings).toEqual([
      {
        type: 'product_missing_datasheet',
        specId: 'spec-a',
        sourceSpecSection: '07 92 00',
        productName: 'Joint Sealants',
        sourceParagraphId: 'sealants',
      },
    ]);
    expect(register.summary.productMissingDatasheet).toBe(1);
  });

  it('submittals: Part 3 product mentions never create register rows', () => {
    const tree = spec('spec-a', '26 05 33', 'Raceways', [
      part1WithSubmittals('Product Data'),
      productsPart(),
      executionPart(
        node('install', 'article', 'INSTALLATION', [node('emt', 'pr1', 'Install EMT conduit')])
      ),
    ]);

    const register = buildSubmittalRegister([tree]);

    expect(register.rows).toHaveLength(0);
    expect(register.findings).toEqual([
      {
        type: 'submittal_type_without_product',
        specId: 'spec-a',
        sourceSpecSection: '26 05 33',
        submittalType: 'Product Data',
      },
    ]);
  });

  it('submittals: spec with no Part 2 products and no submittal types contributes nothing', () => {
    const tree = spec('spec-a', '01 10 00', 'Summary', [
      node('p1', 'part', 'PART 1 - GENERAL', [node('summary', 'article', 'SUMMARY')]),
      executionPart(node('closeout', 'article', 'CLOSEOUT')),
    ]);

    const register = buildSubmittalRegister([tree]);

    expect(register.rows).toEqual([]);
    expect(register.findings).toEqual([]);
    expect(register.summary.totalFindings).toBe(0);
  });
});
