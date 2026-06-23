import { describe, it, expect } from 'vitest';
import { CreateAssociationBodySchema } from './index.js';

describe('CreateAssociationBodySchema', () => {
  it('accepts a DMS connector identity (provider + id)', () => {
    const r = CreateAssociationBodySchema.safeParse({
      label: 'Acme 4500 datasheet',
      externalProvider: 'projectwise',
      externalId: 'doc-123',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a url-only identity', () => {
    const r = CreateAssociationBodySchema.safeParse({
      label: 'Public cut sheet',
      url: 'https://example.com/sheet.pdf',
      contentHash: 'a'.repeat(64),
    });
    expect(r.success).toBe(true);
  });

  it('rejects when neither a url nor a complete provider pair is present', () => {
    const r = CreateAssociationBodySchema.safeParse({
      label: 'no identity',
      externalProvider: 'projectwise', // missing externalId
    });
    expect(r.success).toBe(false);
  });

  it('rejects a blank label', () => {
    const r = CreateAssociationBodySchema.safeParse({
      label: '   ',
      url: 'https://example.com/x.pdf',
    });
    expect(r.success).toBe(false);
  });
});
