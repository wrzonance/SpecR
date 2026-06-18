import { describe, it, expect } from 'vitest';
import { parseThemeFonts } from './theme.js';
import { ParserError } from '../error.js';

// DrawingML theme XML: a:theme/a:themeElements/a:fontScheme/a:majorFont + a:minorFont
// with a:latin/@_typeface, a:ea/@_typeface, a:cs/@_typeface children.

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

describe('parseThemeFonts', () => {
  it('extracts major and minor latin/ea/cs from a well-formed theme XML', () => {
    const fonts = parseThemeFonts(THEME_XML);
    expect(fonts.major.latin).toBe('Calibri Light');
    // empty typeface string → undefined
    expect(fonts.major.ea).toBeUndefined();
    expect(fonts.major.cs).toBeUndefined();
    expect(fonts.minor.latin).toBe('Calibri');
    expect(fonts.minor.ea).toBe('Yu Gothic');
    expect(fonts.minor.cs).toBe('Arial');
  });

  it('returns empty ThemeFonts when fontScheme is missing', () => {
    const xml = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:themeElements><a:clrScheme/></a:themeElements>
    </a:theme>`;
    const fonts = parseThemeFonts(xml);
    expect(fonts.major).toEqual({});
    expect(fonts.minor).toEqual({});
  });

  it('returns empty ThemeFonts when themeElements is missing', () => {
    const xml = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>`;
    const fonts = parseThemeFonts(xml);
    expect(fonts.major).toEqual({});
    expect(fonts.minor).toEqual({});
  });

  it('throws ParserError on completely broken XML', () => {
    expect(() => parseThemeFonts('<<< not xml >>>')).toThrow(ParserError);
  });

  it('chains parser validation cause when theme XML is malformed', () => {
    let caught: unknown;

    try {
      parseThemeFonts('<a:theme><a:themeElements></a:theme>');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ParserError);
    if (!(caught instanceof ParserError)) {
      throw new Error('expected ParserError');
    }
    expect(caught.cause).toBeInstanceOf(Error);
    if (!(caught.cause instanceof Error)) {
      throw new Error('expected chained Error cause');
    }
    expect(caught.cause.message).toContain("Expected closing tag 'a:themeElements'");
  });

  it('returns empty ThemeFonts when only majorFont is present', () => {
    const xml = `<?xml version="1.0"?>
    <a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:themeElements>
        <a:fontScheme name="Office">
          <a:majorFont><a:latin typeface="Times New Roman"/></a:majorFont>
        </a:fontScheme>
      </a:themeElements>
    </a:theme>`;
    const fonts = parseThemeFonts(xml);
    expect(fonts.major.latin).toBe('Times New Roman');
    expect(fonts.minor).toEqual({});
  });
});
