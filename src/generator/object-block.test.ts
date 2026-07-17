import { describe, it, expect } from 'vitest';
import { Document } from 'docx';
import type { IContext } from 'docx';
import { ImportedObjectBlock, buildObjectBlocks } from './object-block.js';
import { GeneratorError } from './error.js';
import type { ObjectBlobNode } from '../ast/index.js';

const OBJECT_NODE_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

function textNode(text: string): ObjectBlobNode {
  return { '#text': text };
}

// Attribute-bearing fixture nodes need `as ObjectBlobNode`: a hand-assembled
// literal combining a plain element key (whose value is `ObjectBlobNode[]`)
// with the separately-intersected `:@` attribute key can't be checked
// against ObjectBlobNode's recursive index-signature-plus-intersection shape
// in one pass — a known TS limitation, not a sign the literal is the wrong
// shape (mirrors parser/docx/body-objects.ts's own established `as
// ObjectBlobNode` narrowing for exactly this case).
function attrNode(
  tag: string,
  attrs: Readonly<Record<string, string | number>>,
  children: readonly ObjectBlobNode[] = []
): ObjectBlobNode {
  return { [tag]: children, ':@': attrs } as ObjectBlobNode;
}

// `IContext` requires `file`/`viewWrapper` alongside `stack`, but this test
// only ever exercises code paths that touch `context.stack` (docx's own
// `XmlComponent.prepForXml`, which `ImportedObjectBlock`/`ImportedXmlComponent`
// inherit) — never `file`/`viewWrapper`. Rather than cast a partial object,
// this builds a fully real, minimal `Document` and pulls its own `.Document`
// view wrapper, so the fixture is genuinely type-correct with no assertion.
function testContext(): IContext {
  const file = new Document({ sections: [{ children: [] }] });
  return { stack: [], file, viewWrapper: file.Document };
}

describe('buildObjectBlocks', () => {
  it('returns an ImportedObjectBlock for a single-root blob', () => {
    const blob: readonly ObjectBlobNode[] = [{ 'w:tbl': [] }];
    const result = buildObjectBlocks(OBJECT_NODE_ID, blob);
    expect(result).toBeInstanceOf(ImportedObjectBlock);
  });

  it('prepForXml delegates 1:1 — no wrapper tag around the re-emitted subtree', () => {
    const blob: readonly ObjectBlobNode[] = [
      {
        'w:tbl': [
          {
            'w:tr': [
              {
                'w:tc': [{ 'w:p': [{ 'w:r': [{ 'w:t': [textNode('Cell text')] }] }] }],
              },
            ],
          },
        ],
      },
    ];
    const block = buildObjectBlocks(OBJECT_NODE_ID, blob);
    const output = block.prepForXml(testContext());
    // The root key is the blob's OWN root tag ('w:tbl'), never a wrapper
    // ('w:importedObjectBlock' or anything else) introduced by the block.
    expect(output).toStrictEqual({
      'w:tbl': [
        {
          'w:tr': [
            {
              'w:tc': [
                {
                  'w:p': [{ 'w:r': [{ 'w:t': ['Cell text'] }] }],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('preserves nested w:tbl structure through multiple levels', () => {
    const blob: readonly ObjectBlobNode[] = [
      {
        'w:tbl': [
          { 'w:tblPr': [] },
          {
            'w:tr': [
              { 'w:tc': [{ 'w:p': [] }] },
              { 'w:tc': [{ 'w:p': [{ 'w:r': [{ 'w:t': [textNode('B')] }] }] }] },
            ],
          },
        ],
      },
    ];
    const output = buildObjectBlocks(OBJECT_NODE_ID, blob).prepForXml(testContext());
    expect(output).toStrictEqual({
      'w:tbl': [
        { 'w:tblPr': {} },
        {
          'w:tr': [
            { 'w:tc': [{ 'w:p': {} }] },
            { 'w:tc': [{ 'w:p': [{ 'w:r': [{ 'w:t': ['B'] }] }] }] },
          ],
        },
      ],
    });
  });

  it('strips the fast-xml-parser @_ prefix from attribute-bearing elements', () => {
    const blob: readonly ObjectBlobNode[] = [
      {
        'w:tbl': [{ 'w:tblGrid': [attrNode('w:gridCol', { '@_w:w': 1440 })] }],
      },
    ];
    const output = buildObjectBlocks(OBJECT_NODE_ID, blob).prepForXml(testContext());
    expect(output).toStrictEqual({
      'w:tbl': [
        {
          'w:tblGrid': [{ 'w:gridCol': { _attr: { 'w:w': '1440' } } }],
        },
      ],
    });
  });

  it('coerces numeric attribute values to strings', () => {
    const blob: readonly ObjectBlobNode[] = [
      { 'w:tbl': [attrNode('w:tblGrid', { '@_w:count': 3 })] },
    ];
    const output = buildObjectBlocks(OBJECT_NODE_ID, blob).prepForXml(testContext());
    expect(output).toStrictEqual({
      'w:tbl': [{ 'w:tblGrid': { _attr: { 'w:count': '3' } } }],
    });
  });

  it('re-emits a self-closing/empty element as an empty object, not a missing key', () => {
    const blob: readonly ObjectBlobNode[] = [{ 'w:tbl': [{ 'w:tblPr': [] }] }];
    const output = buildObjectBlocks(OBJECT_NODE_ID, blob).prepForXml(testContext());
    expect(output).toStrictEqual({ 'w:tbl': [{ 'w:tblPr': {} }] });
  });

  it('throws a GeneratorError carrying the objectNodeId when blob has 0 roots', () => {
    expect(() => buildObjectBlocks(OBJECT_NODE_ID, [])).toThrow(GeneratorError);
    expect(() => buildObjectBlocks(OBJECT_NODE_ID, [])).toThrow(
      new RegExp(`${OBJECT_NODE_ID}.*0 blob root`)
    );
  });

  it('throws a GeneratorError carrying the objectNodeId when blob has 2+ roots', () => {
    const blob: readonly ObjectBlobNode[] = [{ 'w:tbl': [] }, { 'w:tbl': [] }];
    expect(() => buildObjectBlocks(OBJECT_NODE_ID, blob)).toThrow(GeneratorError);
    expect(() => buildObjectBlocks(OBJECT_NODE_ID, blob)).toThrow(
      new RegExp(`${OBJECT_NODE_ID}.*2 blob root`)
    );
  });

  it('throws rather than silently dropping a tag-less blob node, wrapped with objectNodeId context', () => {
    // A node that is neither a '#text' leaf nor a single-key element wrapper
    // — malformed capture data that must never be silently absorbed.
    const tagless = {} as ObjectBlobNode;
    const blob: readonly ObjectBlobNode[] = [{ 'w:tbl': [tagless] }];
    expect(() => buildObjectBlocks(OBJECT_NODE_ID, blob)).toThrow(GeneratorError);
    expect(() => buildObjectBlocks(OBJECT_NODE_ID, blob)).toThrow(
      new RegExp(`failed to re-emit body object ${OBJECT_NODE_ID}`)
    );
  });

  it('chains the underlying cause on the tag-less-node failure', () => {
    const tagless = {} as ObjectBlobNode;
    const blob: readonly ObjectBlobNode[] = [{ 'w:tbl': [tagless] }];
    try {
      buildObjectBlocks(OBJECT_NODE_ID, blob);
      expect.unreachable('expected buildObjectBlocks to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GeneratorError);
      expect((err as GeneratorError).cause).toBeInstanceOf(GeneratorError);
    }
  });

  it('object-block: multi-key blob node throws rather than silently dropping a sibling branch', () => {
    // A node with two element keys (`{ 'w:p': [], 'w:tbl': [] }`) is malformed
    // preserveOrder data — every well-formed node carries exactly one element
    // tag. Picking the first key would silently drop the second branch into a
    // corrupt re-emitted document, so it must throw instead.
    const multiKey = { 'w:p': [], 'w:tbl': [] } as ObjectBlobNode;
    const blob: readonly ObjectBlobNode[] = [{ 'w:tbl': [multiKey] }];
    expect(() => buildObjectBlocks(OBJECT_NODE_ID, blob)).toThrow(GeneratorError);
    expect(() => buildObjectBlocks(OBJECT_NODE_ID, blob)).toThrow(
      new RegExp(`failed to re-emit body object ${OBJECT_NODE_ID}`)
    );
  });

  it('object-block: multi-key blob node surfaces the "exactly one element tag" cause', () => {
    const multiKey = { 'w:p': [], 'w:tbl': [] } as ObjectBlobNode;
    const blob: readonly ObjectBlobNode[] = [{ 'w:tbl': [multiKey] }];
    try {
      buildObjectBlocks(OBJECT_NODE_ID, blob);
      expect.unreachable('expected buildObjectBlocks to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GeneratorError);
      const cause = (err as GeneratorError).cause;
      expect(cause).toBeInstanceOf(GeneratorError);
      expect((cause as GeneratorError).message).toMatch(/exactly one element tag/);
    }
  });
});
