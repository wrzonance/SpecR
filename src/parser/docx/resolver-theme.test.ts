// Theme font resolution through the style cascade (issue #149).
// Split from resolver.test.ts to respect the 400-line file limit.
import { describe, it, expect } from 'vitest';
import { extractRunProps, resolveStyleCascade } from './resolver.js';
import type { StyleProperties } from '../../ast/types.js';

// ─── theme font resolution fixtures ─────────────────────────────────────────

const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">
  <a:themeElements>
    <a:fontScheme name="Office">
      <a:majorFont>
        <a:latin typeface="Calibri Light"/>
        <a:ea typeface=""/>
        <a:cs typeface=""/>
      </a:majorFont>
      <a:minorFont>
        <a:latin typeface="Calibri"/>
        <a:ea typeface="Yu Gothic"/>
        <a:cs typeface="Arial"/>
      </a:minorFont>
    </a:fontScheme>
  </a:themeElements>
</a:theme>`;

// Extract rFonts from a StyleProperties — reduces ?. chain depth in tests.
function getRFonts(p: StyleProperties | undefined): Record<string, unknown> {
  return (p?.rPr?.rFonts as Record<string, unknown> | undefined) ?? {};
}

describe('extractRunProps — theme font attributes', () => {
  it('captures asciiTheme, hAnsiTheme, cstheme, eastAsiaTheme from w:rFonts', () => {
    const rPr = {
      'w:rFonts': {
        '@_w:asciiTheme': 'minorHAnsi',
        '@_w:hAnsiTheme': 'minorHAnsi',
        '@_w:cstheme': 'minorBidi',
        '@_w:eastAsiaTheme': 'minorEastAsia',
      },
    };
    const props = extractRunProps(rPr);
    expect(props.rFonts).toMatchObject({
      asciiTheme: 'minorHAnsi',
      hAnsiTheme: 'minorHAnsi',
      cstheme: 'minorBidi',
      eastAsiaTheme: 'minorEastAsia',
    });
  });

  it('captures theme tokens alongside concrete font names when both present', () => {
    const rPr = {
      'w:rFonts': {
        '@_w:ascii': 'Courier New',
        '@_w:asciiTheme': 'minorHAnsi',
      },
    };
    const props = extractRunProps(rPr);
    expect(props.rFonts?.ascii).toBe('Courier New');
    expect(props.rFonts?.asciiTheme).toBe('minorHAnsi');
  });
});

// ─── Theme font resolution ────────────────────────────────────────────────────
// Precedence rules (ECMA-376 §17.3.2.26 / ISO 29500-1):
//   Within one w:rFonts element: *Theme attr SUPERSEDES direct attr
//     → <w:rFonts w:ascii="Courier New" w:asciiTheme="minorHAnsi"/> resolves to THEME font
//   Across cascade levels: each (direct + theme) pair is ONE logical slot;
//     a closer-level direct attr CLEARS an inherited theme attr (and vice versa).
// Token mapping (ST_Theme → script slot independent of carrying attribute):
//   majorAscii/majorHAnsi → major.latin; minorAscii/minorHAnsi → minor.latin
//   majorEastAsia → major.ea; minorEastAsia → minor.ea
//   majorBidi → major.cs; minorBidi → minor.cs
//   eastAsiaTheme="minorHAnsi" → minorFont.LATIN (token picks script, not carrying attr)
// typeface="" → treated as absent.

describe('resolveStyleCascade — theme font resolution', () => {
  it('acceptance 1: asciiTheme="minorHAnsi" resolves to minor.latin; token stays in payload', () => {
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:style w:type="paragraph" w:styleId="Normal">
        <w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/></w:rPr>
      </w:style>
    </w:styles>`;
    const fonts = getRFonts(resolveStyleCascade(styles, null, THEME_XML).get('Normal'));
    expect(fonts['ascii']).toBe('Calibri');
    expect(fonts['hAnsi']).toBe('Calibri');
    // provenance preserved
    expect(fonts['asciiTheme']).toBe('minorHAnsi');
    expect(fonts['hAnsiTheme']).toBe('minorHAnsi');
  });

  // Acceptance criterion 2: same-element conflict — theme supersedes direct
  it('acceptance 2 (same-element): asciiTheme supersedes direct ascii per §17.3.2.26', () => {
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:style w:type="paragraph" w:styleId="S">
        <w:rPr><w:rFonts w:ascii="Courier New" w:asciiTheme="minorHAnsi"/></w:rPr>
      </w:style>
    </w:styles>`;
    const map = resolveStyleCascade(styles, null, THEME_XML);
    // Theme supersedes direct: Calibri wins over Courier New
    expect(map.get('S')?.rPr?.rFonts?.ascii).toBe('Calibri');
    // both original attrs preserved as provenance
    expect(map.get('S')?.rPr?.rFonts?.asciiTheme).toBe('minorHAnsi');
  });

  // Acceptance criterion 3: cross-level conflict — closer level wins regardless of flavor
  it('acceptance 3 (cross-level): child direct ascii clears inherited asciiTheme', () => {
    // Parent carries asciiTheme, child overrides with direct ascii.
    // Per MS-OI29500: later cascade level (closer) wins; pair-slot cleared.
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:style w:type="paragraph" w:styleId="Parent">
        <w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/></w:rPr>
      </w:style>
      <w:style w:type="paragraph" w:styleId="Child">
        <w:basedOn w:val="Parent"/>
        <w:rPr><w:rFonts w:ascii="Arial"/></w:rPr>
      </w:style>
    </w:styles>`;
    const map = resolveStyleCascade(styles, null, THEME_XML);
    // Child direct ascii "Arial" wins; inherited asciiTheme is cleared
    expect(map.get('Child')?.rPr?.rFonts?.ascii).toBe('Arial');
    expect(map.get('Child')?.rPr?.rFonts?.asciiTheme).toBeUndefined();
  });

  // Acceptance criterion 4: eastAsiaTheme="minorHAnsi" → minor LATIN (token-driven, not slot-driven)
  it('acceptance 4: eastAsiaTheme="minorHAnsi" resolves to minor.latin (token picks script)', () => {
    // Stock Word docDefaults pattern: eastAsiaTheme="minorHAnsi"
    // The token "minorHAnsi" → minorFont.latin = "Calibri" (NOT minor.ea which is "")
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:style w:type="paragraph" w:styleId="S">
        <w:rPr><w:rFonts w:eastAsiaTheme="minorHAnsi"/></w:rPr>
      </w:style>
    </w:styles>`;
    const map = resolveStyleCascade(styles, null, THEME_XML);
    expect(map.get('S')?.rPr?.rFonts?.eastAsia).toBe('Calibri');
    expect(map.get('S')?.rPr?.rFonts?.eastAsiaTheme).toBe('minorHAnsi');
  });

  // Acceptance criterion 5: no theme → identical output to before
  it('acceptance 5: no theme passed → output identical to 2-arg call (regression)', () => {
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman"/></w:rPr></w:rPrDefault></w:docDefaults>
      <w:style w:type="paragraph" w:styleId="PRT"><w:rPr><w:b/></w:rPr></w:style>
    </w:styles>`;
    const twoArg = resolveStyleCascade(styles, null);
    const threeArgNoTheme = resolveStyleCascade(styles, null, null);
    expect([...twoArg.entries()]).toEqual([...threeArgNoTheme.entries()]);
  });

  it('stock docDefaults pattern: asciiTheme+hAnsiTheme+eastAsiaTheme=minorHAnsi, cstheme=minorBidi', () => {
    // Verbatim stock Word docDefaults pattern
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:docDefaults><w:rPrDefault><w:rPr>
        <w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"
                  w:eastAsiaTheme="minorHAnsi" w:cstheme="minorBidi"/>
      </w:rPr></w:rPrDefault></w:docDefaults>
      <w:style w:type="paragraph" w:styleId="Normal"/>
    </w:styles>`;
    // All four slots resolved from THEME_XML: minorHAnsi → minor.latin='Calibri', minorBidi → minor.cs='Arial'
    const fonts = getRFonts(resolveStyleCascade(styles, null, THEME_XML).get('Normal'));
    expect(fonts['ascii']).toBe('Calibri');
    expect(fonts['hAnsi']).toBe('Calibri');
    expect(fonts['eastAsia']).toBe('Calibri'); // token minorHAnsi → minor.latin (not ea slot)
    expect(fonts['cs']).toBe('Arial'); // token minorBidi → minor.cs
  });

  it('isolated hAnsiTheme: only hAnsi resolved, ascii stays absent, token preserved', () => {
    // rFonts carries ONLY hAnsiTheme — the resolution must not bleed into the ascii slot.
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:style w:type="paragraph" w:styleId="S">
        <w:rPr><w:rFonts w:hAnsiTheme="minorHAnsi"/></w:rPr>
      </w:style>
    </w:styles>`;
    const fonts = getRFonts(resolveStyleCascade(styles, null, THEME_XML).get('S'));
    expect(fonts['hAnsi']).toBe('Calibri'); // minorHAnsi → minor.latin
    expect(fonts['ascii']).toBeUndefined(); // no asciiTheme, no direct ascii → absent
    expect(fonts['hAnsiTheme']).toBe('minorHAnsi'); // provenance preserved
  });

  it('minorEastAsia token → minor.ea when ea has a value', () => {
    // THEME_XML has minor.ea = 'Yu Gothic'
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:style w:type="paragraph" w:styleId="S">
        <w:rPr><w:rFonts w:eastAsiaTheme="minorEastAsia"/></w:rPr>
      </w:style>
    </w:styles>`;
    const map = resolveStyleCascade(styles, null, THEME_XML);
    expect(map.get('S')?.rPr?.rFonts?.eastAsia).toBe('Yu Gothic');
  });

  it('minorBidi token resolves to minor.cs', () => {
    // THEME_XML has minor.cs = 'Arial'
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:style w:type="paragraph" w:styleId="S">
        <w:rPr><w:rFonts w:cstheme="minorBidi"/></w:rPr>
      </w:style>
    </w:styles>`;
    const map = resolveStyleCascade(styles, null, THEME_XML);
    expect(map.get('S')?.rPr?.rFonts?.cs).toBe('Arial');
    expect(map.get('S')?.rPr?.rFonts?.cstheme).toBe('minorBidi');
  });

  it('majorBidi token resolves to major.cs; empty typeface → slot absent', () => {
    // THEME_XML has major.cs = '' (empty) → treated as absent
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:style w:type="paragraph" w:styleId="S">
        <w:rPr><w:rFonts w:cstheme="majorBidi"/></w:rPr>
      </w:style>
    </w:styles>`;
    const map = resolveStyleCascade(styles, null, THEME_XML);
    expect(map.get('S')?.rPr?.rFonts?.cs).toBeUndefined();
    expect(map.get('S')?.rPr?.rFonts?.cstheme).toBe('majorBidi');
  });

  it('unknown theme token → no resolved concrete value, no error', () => {
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:style w:type="paragraph" w:styleId="S">
        <w:rPr><w:rFonts w:asciiTheme="unknownTokenXYZ"/></w:rPr>
      </w:style>
    </w:styles>`;
    const map = resolveStyleCascade(styles, null, THEME_XML);
    expect(map.get('S')?.rPr?.rFonts?.ascii).toBeUndefined();
    expect(map.get('S')?.rPr?.rFonts?.asciiTheme).toBe('unknownTokenXYZ');
  });

  it('cross-level: parent direct ascii cleared when child sets asciiTheme', () => {
    // Inverse of acceptance 3: parent has direct ascii, child sets theme
    const styles = `<?xml version="1.0"?><w:styles xmlns:w="x">
      <w:style w:type="paragraph" w:styleId="Parent">
        <w:rPr><w:rFonts w:ascii="Times New Roman"/></w:rPr>
      </w:style>
      <w:style w:type="paragraph" w:styleId="Child">
        <w:basedOn w:val="Parent"/>
        <w:rPr><w:rFonts w:asciiTheme="minorHAnsi"/></w:rPr>
      </w:style>
    </w:styles>`;
    const map = resolveStyleCascade(styles, null, THEME_XML);
    // Child's theme overrides; no inherited direct ascii should survive
    expect(map.get('Child')?.rPr?.rFonts?.ascii).toBe('Calibri');
    expect(map.get('Child')?.rPr?.rFonts?.asciiTheme).toBe('minorHAnsi');
  });
});
