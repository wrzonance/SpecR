import { describe, it, expect } from 'vitest';
import {
  TOOL_TIER_VALUES,
  isToolTier,
  parseAllowedTiers,
  tierAnnotations,
  TOOL_TIERS,
} from './capabilities.js';
import { McpError } from './error.js';

describe('capabilities', () => {
  it('TOOL_TIER_VALUES is exactly read/write/destructive', () => {
    expect([...TOOL_TIER_VALUES]).toEqual(['read', 'write', 'destructive']);
  });

  it('isToolTier narrows valid tiers and rejects junk', () => {
    expect(isToolTier('read')).toBe(true);
    expect(isToolTier('admin')).toBe(false);
  });

  it('parseAllowedTiers parses and trims a comma list', () => {
    expect([...parseAllowedTiers('read, write')]).toEqual(['read', 'write']);
  });

  it('parseAllowedTiers throws McpError on an invalid token', () => {
    expect(() => parseAllowedTiers('read,nope')).toThrow(McpError);
  });

  it('tierAnnotations marks read read-only and destructive destructive', () => {
    expect(tierAnnotations('read')).toMatchObject({ readOnlyHint: true });
    expect(tierAnnotations('destructive')).toMatchObject({ destructiveHint: true });
    expect(tierAnnotations('write')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it('every currently-registered tool has a declared tier', () => {
    // Guards against a seed typo; the contract test (Task 6) enforces this against the live server.
    expect(TOOL_TIERS.get('get_spec')).toBe('read');
    expect(TOOL_TIERS.get('parse_document')).toBe('write');
    expect(TOOL_TIERS.size).toBeGreaterThanOrEqual(20);
  });
});
