import { describe, it, expect } from 'vitest';
import { createOrderedDocumentXmlParser, createOrderedDocumentXmlBuilder } from './xml-utils.js';
import { stripAlternateContentFallback } from './alternate-content.js';
import type { ObjectBlobNode } from '../../ast/index.js';

function parseBlob(xml: string): ObjectBlobNode {
  const [root] = createOrderedDocumentXmlParser().parse(xml) as ObjectBlobNode[];
  if (!root) throw new Error(`fixture XML produced no root node: ${xml}`);
  return root;
}

function toXml(node: ObjectBlobNode): string {
  return createOrderedDocumentXmlBuilder().build([node]);
}

// Attribute-bearing fixture nodes need a computed-key builder, not a direct
// object literal: a hand-assembled literal combining a plain element key
// (whose value is `ObjectBlobNode[]`) with the separately-intersected `:@`
// attribute key can't be checked against ObjectBlobNode's recursive
// index-signature-plus-intersection shape in one pass — a known TS
// limitation, not a sign the literal is the wrong shape (mirrors
// generator/object-block.test.ts's own established `attrNode` helper for
// exactly this case).
function attrNode(
  tag: string,
  attrs: Readonly<Record<string, string | number>>,
  children: readonly ObjectBlobNode[]
): ObjectBlobNode {
  return { [tag]: children, ':@': attrs } as ObjectBlobNode;
}

// Every tag name reachable anywhere in `node`'s subtree (depth-first,
// including `node`'s own tag) — lets a test assert an eliminated tag
// (mc:Fallback) never survives anywhere in the rebuilt tree, not just at
// the top level.
function collectTags(node: ObjectBlobNode, acc: string[] = []): string[] {
  const tag = Object.keys(node).find((key) => key !== ':@');
  if (!tag) return acc;
  acc.push(tag);
  const value = node[tag];
  if (Array.isArray(value)) {
    for (const child of value as readonly ObjectBlobNode[]) collectTags(child, acc);
  }
  return acc;
}

// A realistic body-paragraph run wrapping a DrawingML text box in
// mc:AlternateContent, with a VML mc:Fallback carrying its own distinct
// interior text — the same shape a real Word-authored .docx emits for a
// modern text box (ADR-072 decision 9, body-drawings.ts's own header
// comment), sitting between two ordinary sibling runs.
const ALTERNATE_CONTENT_RUN_XML =
  '<w:p><w:r><w:t>before</w:t></w:r>' +
  '<w:r><mc:AlternateContent>' +
  '<mc:Choice Requires="wps">' +
  '<w:drawing><wp:inline><a:graphic><a:graphicData>' +
  '<wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Choice text</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp>' +
  '</a:graphicData></a:graphic></wp:inline></w:drawing>' +
  '</mc:Choice>' +
  '<mc:Fallback>' +
  '<w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Fallback text</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict>' +
  '</mc:Fallback>' +
  '</mc:AlternateContent></w:r>' +
  '<w:r><w:t>after</w:t></w:r></w:p>';

// A nested mc:AlternateContent sitting as a DIRECT CHILD of the surviving
// mc:Choice — the shape real Word output produces when a text box's own
// DrawingML content is itself wrapped in a further Requires-gated choice
// (e.g. a wps shape whose graphicData carries a nested wpg alternate). The
// outer AlternateContent's Choice is chosen first, exposing the inner
// AlternateContent as one of ITS children — the site the fix targets.
const NESTED_ALTERNATE_CONTENT_XML =
  '<w:r><mc:AlternateContent>' +
  '<mc:Choice Requires="wps">' +
  '<mc:AlternateContent>' +
  '<mc:Choice Requires="wpg"><w:t>inner Choice text</w:t></mc:Choice>' +
  '<mc:Fallback><w:t>inner Fallback text</w:t></mc:Fallback>' +
  '</mc:AlternateContent>' +
  '</mc:Choice>' +
  '<mc:Fallback><w:t>outer Fallback text</w:t></mc:Fallback>' +
  '</mc:AlternateContent></w:r>';

describe('stripAlternateContentFallback', () => {
  it('returns a no-AlternateContent tree structurally unchanged, but as a FRESH object once it walks any children', () => {
    const xml = '<w:p><w:r><w:t>hello</w:t></w:r></w:p>';
    const node = parseBlob(xml);
    const result = stripAlternateContentFallback(node);
    expect(result).toEqual(node);
    expect(toXml(result)).toBe(xml);
    // `toEqual` alone can't tell a rebuilt-but-structurally-identical tree
    // apart from the exact same input reference passed straight through —
    // this node has children (a `w:r`), so it takes the rebuild branch below
    // and must come back as a new object, never the original.
    expect(result).not.toBe(node);
  });

  // The rebuild branch above only fires once a node has at least one child to
  // walk. A node with a tag but ZERO children (nothing to rewrite) instead
  // takes the short-circuit `if (children.length === 0) return node;` path —
  // deliberately returning the SAME reference rather than paying for an
  // allocation that would produce an identical copy. Pinned explicitly with
  // `toBe` so a future change can't silently swap this for a deep-copy (or
  // vice versa start mutating) without a test noticing either way.
  it('aliases the input node when it has zero children — nothing to rewrite, no allocation', () => {
    const node: ObjectBlobNode = { 'w:t': [] };
    const result = stripAlternateContentFallback(node);
    expect(result).toBe(node);
  });

  it('extracts the mc:Choice content from a realistic nested fixture, discarding mc:Fallback', () => {
    const node = parseBlob(ALTERNATE_CONTENT_RUN_XML);
    const xml = toXml(stripAlternateContentFallback(node));
    expect(xml).toContain('Choice text');
    expect(xml).not.toContain('Fallback text');
    expect(xml).not.toContain('mc:AlternateContent');
    expect(xml).not.toContain('mc:Choice');
    expect(xml).not.toContain('mc:Fallback');
  });

  it('preserves sibling run content (before/after the AlternateContent run) untouched and in order', () => {
    const node = parseBlob(ALTERNATE_CONTENT_RUN_XML);
    const xml = toXml(stripAlternateContentFallback(node));
    const beforeIdx = xml.indexOf('before');
    const choiceIdx = xml.indexOf('Choice text');
    const afterIdx = xml.indexOf('after');
    expect(beforeIdx).toBeGreaterThan(-1);
    expect(choiceIdx).toBeGreaterThan(beforeIdx);
    expect(afterIdx).toBeGreaterThan(choiceIdx);
  });

  it('never leaves an mc:Fallback tag reachable anywhere in the result', () => {
    const node = parseBlob(ALTERNATE_CONTENT_RUN_XML);
    const result = stripAlternateContentFallback(node);
    expect(collectTags(result)).not.toContain('mc:Fallback');
  });

  it('leaves an mc:AlternateContent with no mc:Choice as-is (malformed input, never faked)', () => {
    const malformed: ObjectBlobNode = {
      'w:r': [
        {
          'mc:AlternateContent': [{ 'mc:Fallback': [{ 'w:pict': [] }] }],
        },
      ],
    };
    const result = stripAlternateContentFallback(malformed);
    expect(result).toEqual(malformed);
  });

  // KNOWN AMBIGUITY: OOXML permits multiple mc:Choice siblings (one per
  // Requires alternative) inside one mc:AlternateContent; real Word emits
  // exactly one Choice, so which sibling should win is undecidable from the
  // fixture alone. This pins the first-wins pick (mirrors the same caveat in
  // alternate-content.ts's choiceChildren).
  it('KNOWN AMBIGUITY: multiple mc:Choice siblings — the first wins, later ones discarded', () => {
    const choiceOne = attrNode('mc:Choice', { '@_Requires': 'a' }, [
      { 'w:t': [{ '#text': 'first' }] },
    ]);
    const choiceTwo = attrNode('mc:Choice', { '@_Requires': 'b' }, [
      { 'w:t': [{ '#text': 'second' }] },
    ]);
    const multiChoice: ObjectBlobNode = {
      'w:r': [{ 'mc:AlternateContent': [choiceOne, choiceTwo] }],
    };
    const xml = toXml(stripAlternateContentFallback(multiChoice));
    expect(xml).toContain('first');
    expect(xml).not.toContain('second');
  });

  it('collapses a nested mc:AlternateContent sitting as a direct child of the surviving mc:Choice (#517 regression)', () => {
    const node = parseBlob(NESTED_ALTERNATE_CONTENT_XML);
    const result = stripAlternateContentFallback(node);
    const xml = toXml(result);
    expect(xml).toContain('inner Choice text');
    expect(xml).not.toContain('inner Fallback text');
    expect(xml).not.toContain('outer Fallback text');
    expect(collectTags(result)).not.toContain('mc:AlternateContent');
    expect(collectTags(result)).not.toContain('mc:Choice');
    expect(collectTags(result)).not.toContain('mc:Fallback');
  });

  it('is pure: never mutates the input node', () => {
    const node = parseBlob(ALTERNATE_CONTENT_RUN_XML);
    const before = JSON.parse(JSON.stringify(node)) as unknown;
    stripAlternateContentFallback(node);
    expect(JSON.parse(JSON.stringify(node))).toEqual(before);
  });

  it('is total: never throws, even on a tag-less node', () => {
    const tagless = {} as ObjectBlobNode;
    expect(() => stripAlternateContentFallback(tagless)).not.toThrow();
  });
});
