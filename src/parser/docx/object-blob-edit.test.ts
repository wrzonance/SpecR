import { describe, it, expect } from 'vitest';
import { findAnchoredParagraph, replaceAnchoredParagraphText } from './object-blob-edit.js';
import { wrapBlobParagraphWithAnchor } from './object-anchor.js';
import { createOrderedDocumentXmlBuilder } from './xml-utils.js';
import { ParserError } from '../error.js';
import { UUID_TAG_PREFIX } from '../../ast/index.js';
import type { ObjectBlobNode } from '../../ast/index.js';

const UUID_A = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const UUID_B = '11111111-2222-3333-4444-555555555555';
const UUID_MISSING = '99999999-9999-9999-9999-999999999999';

function run(text: string): ObjectBlobNode {
  return { 'w:r': [{ 'w:t': [{ '#text': text }] }] };
}

function paragraph(...children: readonly ObjectBlobNode[]): ObjectBlobNode {
  return { 'w:p': children };
}

/** One table cell wrapping a single anchored paragraph — the realistic
 * shape a captured object's blob actually carries (body-objects.ts). */
function cell(anchoredParagraph: ObjectBlobNode): ObjectBlobNode {
  return { 'w:tc': [anchoredParagraph] };
}

function toXml(nodes: readonly ObjectBlobNode[]): string {
  return createOrderedDocumentXmlBuilder().build(nodes);
}

/** A w:sdt anchor tagged with `uuid` whose w:sdtContent is missing entirely —
 * corrupted capture data a real capture pass never produces, but a
 * defensive boundary this module must still detect rather than silently
 * mistake for "not found". */
function malformedAnchor(uuid: string): ObjectBlobNode {
  // `filler` is an ALREADY-TYPED sibling (not w:sdtContent) — deliberately
  // present so this literal has the identical two-element-array shape
  // wrapBlobParagraphWithAnchor's own `as ObjectBlobNode` cast uses (one
  // raw `:@`-bearing literal element alongside one already-typed
  // ObjectBlobNode element); the same known TS limitation documented there
  // (index signature + intersected `:@` key can't both be checked against
  // one hand-assembled literal at once) otherwise rejects the cast here too.
  // The anchor is still genuinely malformed: no `w:sdtContent` child exists.
  const filler: ObjectBlobNode = paragraph(run('unused'));
  return {
    'w:sdt': [
      { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `${UUID_TAG_PREFIX}${uuid}` } }] },
      filler,
    ],
  } as ObjectBlobNode;
}

/** A w:sdt anchor tagged with `uuid` carrying TWO w:sdtContent children —
 * corrupted capture data: `wrapBlobParagraphWithAnchor` only ever emits
 * one. Guards against "take the first match" silently rewriting the wrong
 * (or both) content nodes. */
function multiContentAnchor(uuid: string): ObjectBlobNode {
  return {
    'w:sdt': [
      { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `${UUID_TAG_PREFIX}${uuid}` } }] },
      { 'w:sdtContent': [paragraph(run('first'))] },
      { 'w:sdtContent': [paragraph(run('second'))] },
    ],
  } as ObjectBlobNode;
}

/** A w:sdt anchor whose sole w:sdtContent child is not a w:p paragraph —
 * corrupted capture data `wrapBlobParagraphWithAnchor` never produces. */
function nonParagraphContentAnchor(uuid: string): ObjectBlobNode {
  return {
    'w:sdt': [
      { 'w:sdtPr': [{ 'w:tag': [], ':@': { '@_w:val': `${UUID_TAG_PREFIX}${uuid}` } }] },
      { 'w:sdtContent': [{ 'w:tbl': [] }] },
    ],
  } as ObjectBlobNode;
}

describe('findAnchoredParagraph', () => {
  it('locates the interior w:p node anchored by uuid — not the w:sdt shell', () => {
    const interior = paragraph(run('hello'));
    const blob = [cell(wrapBlobParagraphWithAnchor(interior, UUID_A))];

    const found = findAnchoredParagraph(blob, UUID_A);

    expect(found).toEqual(interior);
    expect(found ? Object.keys(found) : []).toEqual(['w:p']);
  });

  it('is total: returns undefined when uuid is not anchored anywhere in the blob', () => {
    const blob = [cell(wrapBlobParagraphWithAnchor(paragraph(run('hello')), UUID_A))];

    expect(findAnchoredParagraph(blob, UUID_MISSING)).toBeUndefined();
  });

  it('throws ParserError (never undefined) when a matching anchor has a malformed w:sdtContent', () => {
    const blob = [malformedAnchor(UUID_A)];

    expect(() => findAnchoredParagraph(blob, UUID_A)).toThrow(ParserError);
  });

  it('throws ParserError when a matching anchor carries more than one w:sdtContent child', () => {
    const blob = [multiContentAnchor(UUID_A)];

    expect(() => findAnchoredParagraph(blob, UUID_A)).toThrow(ParserError);
  });

  it('throws ParserError when the single w:sdtContent child is not a w:p paragraph', () => {
    const blob = [nonParagraphContentAnchor(UUID_A)];

    expect(() => findAnchoredParagraph(blob, UUID_A)).toThrow(ParserError);
  });
});

describe('replaceAnchoredParagraphText', () => {
  it('invariant: round-trip fidelity — rewrites only the anchored paragraph, byte-preserving everything else', () => {
    const blob = [
      cell(wrapBlobParagraphWithAnchor(paragraph(run('original A')), UUID_A)),
      cell(wrapBlobParagraphWithAnchor(paragraph(run('original B')), UUID_B)),
    ];

    const result = replaceAnchoredParagraphText(blob, UUID_A, 'replaced A');
    expect(result).toBeDefined();
    const newBlob = result as readonly ObjectBlobNode[];
    const xml = toXml(newBlob);

    expect(xml).toContain('<w:t>replaced A</w:t>');
    expect(xml).not.toContain('original A');
    expect(xml).toContain('<w:t>original B</w:t>');
  });

  it('invariant: immutability — never mutates the input blob or any of its nodes', () => {
    const blob = [
      cell(wrapBlobParagraphWithAnchor(paragraph(run('original A')), UUID_A)),
      cell(wrapBlobParagraphWithAnchor(paragraph(run('original B')), UUID_B)),
    ];
    const before = JSON.parse(JSON.stringify(blob)) as unknown;

    replaceAnchoredParagraphText(blob, UUID_A, 'replaced A');

    expect(JSON.parse(JSON.stringify(blob))).toEqual(before);
  });

  it('invariant: non-anchor siblings are untouched — an unedited anchor is returned by reference after an edit elsewhere in the same blob', () => {
    const untouchedInterior = paragraph(run('original B'));
    const blob = [
      cell(wrapBlobParagraphWithAnchor(paragraph(run('original A')), UUID_A)),
      cell(wrapBlobParagraphWithAnchor(untouchedInterior, UUID_B)),
    ];

    const result = replaceAnchoredParagraphText(blob, UUID_A, 'replaced A');
    expect(result).toBeDefined();
    const newBlob = result as readonly ObjectBlobNode[];

    // Sibling cell's top-level node is the exact same reference — never
    // rebuilt — and its anchored paragraph still resolves to the identical
    // original interior node object.
    expect(newBlob[1]).toBe(blob[1]);
    expect(findAnchoredParagraph(newBlob, UUID_B)).toBe(untouchedInterior);
  });

  it('invariant: totality on absence — returns undefined and performs no partial rewrite when uuid is not anchored', () => {
    const blob = [cell(wrapBlobParagraphWithAnchor(paragraph(run('original A')), UUID_A))];

    const result = replaceAnchoredParagraphText(blob, UUID_MISSING, 'unused');

    expect(result).toBeUndefined();
  });

  it('invariant: multi-run rewrite — preserves every existing run, placing newText in the first and blanking the rest', () => {
    const interior = paragraph(run('Hello '), run('World'));
    const blob = [cell(wrapBlobParagraphWithAnchor(interior, UUID_A))];

    const result = replaceAnchoredParagraphText(blob, UUID_A, 'Goodbye');
    expect(result).toBeDefined();
    const newBlob = result as readonly ObjectBlobNode[];
    const found = findAnchoredParagraph(newBlob, UUID_A);

    expect(found).toEqual(paragraph(run('Goodbye'), run('')));
    const xml = toXml(newBlob);
    expect([...xml.matchAll(/<w:r>/g)]).toHaveLength(2);
    expect(xml).toContain('<w:t>Goodbye</w:t>');
    expect(xml).not.toContain('Hello');
    expect(xml).not.toContain('World');
  });

  it('invariant: multi-run rewrite — the same anchor can be rewritten more than once in sequence, and the w:tag anchor survives each rewrite', () => {
    const blob = [cell(wrapBlobParagraphWithAnchor(paragraph(run('first')), UUID_A))];

    const afterFirst = replaceAnchoredParagraphText(blob, UUID_A, 'second');
    expect(afterFirst).toBeDefined();
    const afterSecond = replaceAnchoredParagraphText(
      afterFirst as readonly ObjectBlobNode[],
      UUID_A,
      'third'
    );
    expect(afterSecond).toBeDefined();

    const xml = toXml(afterSecond as readonly ObjectBlobNode[]);
    expect(xml).toContain(`<w:tag w:val="${UUID_TAG_PREFIX}${UUID_A}"/>`);
    expect(xml).toContain('<w:t>third</w:t>');
    expect(xml).not.toContain('first');
    expect(xml).not.toContain('second');
  });

  it('preserves a leading w:pPr paragraph-mark node unchanged across the rewrite', () => {
    const pPr: ObjectBlobNode = { 'w:pPr': [{ 'w:jc': [] }] };
    const interior = paragraph(pPr, run('original'));
    const blob = [cell(wrapBlobParagraphWithAnchor(interior, UUID_A))];

    const result = replaceAnchoredParagraphText(blob, UUID_A, 'rewritten');
    expect(result).toBeDefined();
    const xml = toXml(result as readonly ObjectBlobNode[]);

    expect(xml).toContain('<w:pPr>');
    expect(xml).toContain('<w:t>rewritten</w:t>');
  });

  it('throws ParserError when the matched anchor has a malformed w:sdtContent', () => {
    const blob = [malformedAnchor(UUID_A)];

    expect(() => replaceAnchoredParagraphText(blob, UUID_A, 'x')).toThrow(ParserError);
  });

  // Regression (Codex P1): capture reads interior text recursively through run
  // wrappers (body-objects.ts collectText: w:hyperlink/w:ins/w:sdt), so a
  // rewrite that only touched DIRECT w:r children left wrapped text stale and
  // appended a duplicate run beside it.
  it('rewrite: wrapped text — text inside a w:hyperlink is rewritten in place, never left stale beside an appended run', () => {
    const hyperlink: ObjectBlobNode = { 'w:hyperlink': [run('linked text')] };
    const interior = paragraph(hyperlink);
    const blob = [cell(wrapBlobParagraphWithAnchor(interior, UUID_A))];

    const result = replaceAnchoredParagraphText(blob, UUID_A, 'edited');
    expect(result).toBeDefined();
    const xml = toXml(result as readonly ObjectBlobNode[]);

    expect(xml).toContain('<w:hyperlink>');
    expect(xml).toContain('<w:t>edited</w:t>');
    expect(xml).not.toContain('linked text');
    // the single run stays INSIDE the hyperlink — no duplicate appended run
    expect([...xml.matchAll(/<w:r>/g)]).toHaveLength(1);
  });

  // Regression (Codex P2): a run's multiple w:t leaves were all overwritten
  // with the SAME node (X X duplication) and w:t attributes such as
  // xml:space="preserve" were dropped.
  it('rewrite: multi-w:t run — newText lands in the first w:t only, later w:t blanked, xml:space attribute preserved', () => {
    // One run carrying two w:t leaves, the first space-preserving. The `:@`
    // sits nested inside the outer literal (cast once at the top, like
    // malformedAnchor/multiContentAnchor above) — the index signature plus the
    // intersected optional `:@` key can't both be checked against a single
    // hand-assembled literal at once (a known TS limitation).
    const interior = {
      'w:p': [
        {
          'w:r': [
            { 'w:t': [{ '#text': 'lead ' }], ':@': { '@_xml:space': 'preserve' } },
            { 'w:t': [{ '#text': 'tail' }] },
          ],
        },
      ],
    } as ObjectBlobNode;
    const blob = [cell(wrapBlobParagraphWithAnchor(interior, UUID_A))];

    const result = replaceAnchoredParagraphText(blob, UUID_A, 'once');
    expect(result).toBeDefined();
    const xml = toXml(result as readonly ObjectBlobNode[]);

    // xml:space survives, and the new text sits in that first (preserving) w:t
    expect(xml).toContain('xml:space="preserve"');
    expect(xml).toContain('once');
    expect(xml).not.toContain('lead');
    expect(xml).not.toContain('tail');
    // exactly one occurrence of the new text — no X X duplication
    expect([...xml.matchAll(/once/g)]).toHaveLength(1);
  });
  // #641 adversarial-review finding (P1). body-objects.ts's capture walk now
  // SKIPS vanish runs, so this rewrite walk must skip them too — the two are
  // documented as mirror images. The dangerous ordering is HIDDEN-FIRST: with
  // a presence-blind walk the edit lands in the hidden run (so the user's new
  // text is invisible in Word) AND the following visible run is blanked (so
  // real spec text is destroyed). Both halves are asserted.
  it('places the edit in the first VISIBLE run when a hidden run precedes it, and never blanks the visible one', () => {
    const hidden: ObjectBlobNode = {
      'w:r': [{ 'w:rPr': [{ 'w:vanish': [] }] }, { 'w:t': [{ '#text': 'HIDDEN SECRET' }] }],
    };
    const interior = paragraph(hidden, run('visible original'));
    const blob = [cell(wrapBlobParagraphWithAnchor(interior, UUID_A))];

    const result = replaceAnchoredParagraphText(blob, UUID_A, 'edited text');
    expect(result).toBeDefined();
    const xml = toXml(result as readonly ObjectBlobNode[]);

    // the edit went into the VISIBLE run
    expect(xml).toContain('edited text');
    expect(xml).not.toContain('visible original');
    // the hidden run is untouched — neither overwritten with the edit nor blanked
    expect(xml).toContain('HIDDEN SECRET');
    // exactly one copy of the new text — it did not also land in the hidden run
    expect([...xml.matchAll(/edited text/g)]).toHaveLength(1);
  });

  // The reverse ordering, which a naive "skip the first run" fix would break:
  // a VISIBLE run first, then a hidden one. The visible run takes the edit and
  // the trailing hidden run must still be left alone rather than blanked.
  it('places the edit in the visible run when the hidden run follows it, leaving the hidden run intact', () => {
    const hidden: ObjectBlobNode = {
      'w:r': [{ 'w:rPr': [{ 'w:vanish': [] }] }, { 'w:t': [{ '#text': 'HIDDEN SECRET' }] }],
    };
    const interior = paragraph(run('visible original'), hidden);
    const blob = [cell(wrapBlobParagraphWithAnchor(interior, UUID_A))];

    const result = replaceAnchoredParagraphText(blob, UUID_A, 'edited text');
    const xml = toXml(result as readonly ObjectBlobNode[]);

    expect(xml).toContain('edited text');
    expect(xml).not.toContain('visible original');
    expect(xml).toContain('HIDDEN SECRET');
    expect([...xml.matchAll(/edited text/g)]).toHaveLength(1);
  });

  // A run whose w:vanish toggle is explicitly OFF is VISIBLE and must behave
  // like any ordinary run — it is a legitimate edit target, not a skipped one.
  it('treats a <w:vanish w:val="0"/> run as visible and edits it normally', () => {
    const toggledOff = {
      'w:r': [
        { 'w:rPr': [{ 'w:vanish': [], ':@': { '@_w:val': '0' } }] },
        { 'w:t': [{ '#text': 'visible original' }] },
      ],
    } as ObjectBlobNode;
    const interior = paragraph(toggledOff);
    const blob = [cell(wrapBlobParagraphWithAnchor(interior, UUID_A))];

    const result = replaceAnchoredParagraphText(blob, UUID_A, 'edited text');
    const xml = toXml(result as readonly ObjectBlobNode[]);

    expect(xml).toContain('edited text');
    expect(xml).not.toContain('visible original');
  });
});
