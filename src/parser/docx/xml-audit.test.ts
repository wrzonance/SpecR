import { describe, it, expect } from 'vitest';
import { XMLParser } from 'fast-xml-parser';

describe('fast-xml-parser entity behaviour (issue #22 audit)', () => {
  it('decodes basic XML entities in text content', () => {
    const parser = new XMLParser({ processEntities: true });
    const result = parser.parse('<x>A &amp; B &lt; C &gt; D</x>') as Record<string, string>;
    expect(result['x']).toBe('A & B < C > D');
  });

  it('does not expand recursive custom entity declarations', () => {
    const parser = new XMLParser({ processEntities: true });
    const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "&b;"><!ENTITY b "&a;">]><x>&a;</x>';
    // fxp v5 silently drops entities whose values reference other entities.
    // &a; is left verbatim in output — no infinite expansion, no throw.
    const result = parser.parse(xml) as Record<string, unknown>;
    expect(result['x']).toBe('&a;');
  });
});
