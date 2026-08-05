// End-to-end regression for the #650 review finding (HIGH): generateManual
// previously unioned every SpecTree's captured `vanishCharStyleIds` into ONE
// shared `w:styles` character-style block (object-vanish-styles.ts's
// collectVanishCharacterStyleIds + vanishStylesOptions). Two DIFFERENT
// source documents combined into one manual that happen to define their OWN
// character style under the SAME raw id — one genuinely vanish, the other
// used for unrelated formatting on visible text — collided: the vanish
// stub for that shared id silently overwrote the OTHER tree's definition,
// which would hide that tree's previously-visible text on re-open. No test
// anywhere in the codebase exercised generateManual's multi-tree path with
// real captured vanish objects (object-vanish-styles.test.ts and
// body-object-round-trip.test.ts only exercise generateDocx's single-tree
// path) — this file closes that gap directly against the real DOCX bytes.
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { generateManual } from './index.js';
import type { ManualMeta } from './front-matter.js';
import type { ObjectBlobNode, SpecNode, SpecTree } from '../ast/index.js';

const META: ManualMeta = { name: 'Acme Portfolio', description: 'Two-section test manual' };

// Computed `['w:rStyle']` key (rather than a literal `'w:rStyle':` property)
// mirrors body-objects.test.ts's own established `attrNode` helper — the
// workaround for a TS limitation where a hand-assembled object literal can't
// satisfy ObjectBlobNode's index signature + intersected `:@` key at once
// when the tag is a literal property name.
function rStyleNode(styleId: string): ObjectBlobNode {
  const tag: string = 'w:rStyle';
  return { [tag]: [], ':@': { '@_w:val': styleId } } as ObjectBlobNode;
}

// A `w:tbl > ... > w:r` blob whose single run's `w:rPr > w:rStyle` names
// `styleId` and carries `text` — the shape a real capture persists.
function tableBlobWithRStyle(styleId: string, text: string): ObjectBlobNode[] {
  return [
    {
      'w:tbl': [
        {
          'w:tr': [
            {
              'w:tc': [
                {
                  'w:p': [
                    {
                      'w:r': [{ 'w:rPr': [rStyleNode(styleId)] }, { 'w:t': [{ '#text': text }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

function objectNode(
  id: string,
  styleId: string,
  text: string,
  vanishCharStyleIds?: readonly string[]
): SpecNode {
  return {
    id,
    type: 'object',
    text: '',
    meta: {
      object: {
        kind: 'table',
        floating: false,
        generation: 'drawingml',
        blob: tableBlobWithRStyle(styleId, text),
        ...(vanishCharStyleIds !== undefined
          ? { vanishCharStyleIds: [...vanishCharStyleIds] }
          : {}),
      },
    },
    children: [],
  };
}

function treeWithObject(
  treeId: string,
  section: string,
  objectId: string,
  obj: SpecNode
): SpecTree {
  return {
    id: treeId,
    section,
    title: 'Test Section',
    parts: [
      {
        id: `${objectId}-part`,
        type: 'part',
        text: 'GENERAL',
        meta: {},
        children: [obj],
      },
    ],
  };
}

async function getDocXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('word/document.xml not found in generated DOCX');
  return file.async('string');
}

async function getStylesXml(buffer: Buffer): Promise<string | undefined> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file('word/styles.xml');
  return file ? file.async('string') : undefined;
}

describe('generateManual — vanish-character-style cross-tree isolation (#650 review finding)', () => {
  it('does not let one tree’s vanish stub for a raw style id capture another tree’s unrelated same-named style', async () => {
    // Tree A: an object genuinely hidden via a w:rStyle-referenced vanish
    // character style named "Hidden1" — mirrors body-object-round-trip.test.ts's
    // real "#650" capture fixture.
    const treeA = treeWithObject(
      'tree-a',
      '03 30 00',
      'obj-a',
      objectNode('obj-a', 'Hidden1', 'Secret from document A', ['Hidden1'])
    );
    // Tree B: an UNRELATED source document whose own object references a
    // character style it ALSO happens to call "Hidden1" — but in tree B's
    // own source, that style was never vanish (its captured
    // vanishCharStyleIds is empty/absent), e.g. a bold/underline-only style.
    const treeB = treeWithObject(
      'tree-b',
      '09 91 00',
      'obj-b',
      objectNode('obj-b', 'Hidden1', 'Visible text from document B')
    );

    const buffer = await generateManual([treeA, treeB], META);
    const documentXml = await getDocXml(buffer);
    const stylesXml = await getStylesXml(buffer);

    // Tree B's own reference to the raw id "Hidden1" must survive UNTOUCHED
    // — it must never be redirected onto tree A's vanish-stub id, or tree
    // B's visible text would render hidden when the document is opened.
    expect(documentXml).toContain('<w:rStyle w:val="Hidden1"/>');
    expect(documentXml).toContain('Visible text from document B');
    // The BLOB itself is always re-emitted verbatim regardless of vanish
    // (ADR-072 decision 1 — Word hides it via the style, SpecR never
    // reinterprets or drops the underlying content), so tree A's text is
    // still present in the XML — but its w:rStyle reference must have moved
    // to a tree-scoped id, the exact rewrite that prevents the collision.
    expect(documentXml).toContain('Secret from document A');
    const namespacedIdMatch = /w:rStyle w:val="(Hidden1#specr-vanish-t\d+)"/.exec(documentXml);
    expect(namespacedIdMatch).not.toBeNull();

    // The emitted styles.xml must NOT define the raw "Hidden1" id as vanish
    // — that would be exactly the corruption this fix prevents, since
    // "Hidden1" is the id tree B's own (non-vanish) reference still uses.
    expect(stylesXml).toBeDefined();
    expect(stylesXml).not.toContain('w:styleId="Hidden1"');
    // It DOES define tree A's namespaced id as vanish, preserving the
    // original privacy behavior for tree A's own object.
    const namespacedId = namespacedIdMatch?.[1];
    expect(namespacedId).toBeDefined();
    expect(stylesXml).toContain(`w:styleId="${namespacedId}"`);
  });

  it('never namespaces or synthesizes a vanish character style when no tree carries any vanish ids (byte-identical common case)', async () => {
    const treeA = treeWithObject(
      'tree-a',
      '03 30 00',
      'obj-a',
      objectNode('obj-a', 'Bold1', 'A text')
    );
    const treeB = treeWithObject(
      'tree-b',
      '09 91 00',
      'obj-b',
      objectNode('obj-b', 'Bold1', 'B text')
    );

    const buffer = await generateManual([treeA, treeB], META);
    const documentXml = await getDocXml(buffer);
    const stylesXml = await getStylesXml(buffer);

    // Docx-package Documents always carry a default styles.xml (heading /
    // paragraph styles), independent of this fix — what must NOT happen is
    // "Bold1" being renamed or a vanish stub being synthesized for it, since
    // neither tree ever marked it vanish.
    expect(documentXml).toContain('<w:rStyle w:val="Bold1"/>');
    expect(stylesXml).not.toContain('w:styleId="Bold1"');
    expect(stylesXml).not.toContain('specr-vanish');
  });
});
