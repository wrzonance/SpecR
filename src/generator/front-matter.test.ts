import { describe, it, expect } from 'vitest';
import { Document, Packer, TableOfContents, type FileChild } from 'docx';
import JSZip from 'jszip';
import { buildFrontMatter } from './front-matter.js';
import type { StyleRule } from '../ast/index.js';

async function renderToXml(children: readonly FileChild[]): Promise<string> {
  // Front-matter children are docx FileChild instances; render through a Document.
  const doc = new Document({ sections: [{ children: [...children] }] });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('document.xml missing');
  return file.async('string');
}

describe('buildFrontMatter', () => {
  it('emits a TableOfContents (TOC field) instance', () => {
    const fm = buildFrontMatter({ name: 'Acme Tower', description: 'New HQ' });
    expect(fm.some((c) => c instanceof TableOfContents)).toBe(true);
  });

  it('cover carries the project name and description text', async () => {
    const xml = await renderToXml(buildFrontMatter({ name: 'Acme Tower', description: 'New HQ' }));
    expect(xml).toContain('Acme Tower');
    expect(xml).toContain('New HQ');
  });

  it('renders a TOC field code (TOC \\o heading instruction)', async () => {
    const xml = await renderToXml(buildFrontMatter({ name: 'Acme Tower', description: null }));
    // dolanmiu/docx emits `TOC \h \o "1-1"`: a real TOC field with hyperlinked
    // entries drawn from Heading1. Assert the field + the heading-range switch.
    expect(xml).toMatch(/instrText[^>]*>TOC .*\\o &quot;1-1&quot;/);
  });

  it('renders the project name when description is null', async () => {
    const xml = await renderToXml(buildFrontMatter({ name: 'Acme Tower', description: null }));
    expect(xml).toContain('Acme Tower');
  });

  it('applies the part style rule run properties to the cover title', async () => {
    const rules: StyleRule[] = [{ nodeType: 'part', properties: { rPr: { sz: 56, b: true } } }];
    const xml = await renderToXml(
      buildFrontMatter({ name: 'Acme Tower', description: null }, rules)
    );
    // Half-point size 56 from the template surfaces on the cover title run.
    expect(xml).toContain('w:val="56"');
  });

  it('renders revision identity on the cover/front matter', async () => {
    const xml = await renderToXml(
      buildFrontMatter({
        name: 'Acme Tower',
        description: null,
        revision: { displayName: '100% CD', date: '2026-06-17', packageName: 'CD Set' },
      })
    );
    expect(xml).toContain('CD Set');
    expect(xml).toContain('100% CD');
    expect(xml).toContain('2026-06-17');
  });

  it('renders addendum affected sections on the cover/front matter', async () => {
    const xml = await renderToXml(
      buildFrontMatter({
        name: 'Acme Tower',
        description: null,
        revision: { displayName: 'Addendum 1', date: '2026-06-18', packageName: 'CD Set' },
        addendum: {
          affectedSections: [
            { section: '09 91 00', title: 'Painting' },
            { section: '23 09 23', title: 'Direct Digital Control' },
          ],
        },
      })
    );
    expect(xml).toContain('Affected Sections');
    expect(xml).toContain('09 91 00 - Painting');
    expect(xml).toContain('23 09 23 - Direct Digital Control');
  });
});
