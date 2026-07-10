import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildUnauthenticatedExposureWarning,
  logStartupSecurityWarning,
} from './security-posture.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('buildUnauthenticatedExposureWarning', () => {
  it('warns about both write-capable REST and MCP under the default tiers', () => {
    const warning = buildUnauthenticatedExposureWarning({
      authConfigured: false,
      mcpTiers: 'read,write',
    });

    expect(warning).not.toBeNull();
    expect(warning).toContain('WITHOUT authentication');
    expect(warning).toContain('REST and MCP');
    expect(warning).toContain('read,write');
    expect(warning).toContain('trusted network');
    expect(warning).toContain('#43');
  });

  it('flags MCP as write-capable when destructive tools are exposed', () => {
    const warning = buildUnauthenticatedExposureWarning({
      authConfigured: false,
      mcpTiers: 'read, write, destructive',
    });

    expect(warning).toContain('REST and MCP');
    // echoes the operator's raw tier string verbatim
    expect(warning).toContain('read, write, destructive');
  });

  it('still warns about unauthenticated REST writes when MCP is read-only', () => {
    const warning = buildUnauthenticatedExposureWarning({
      authConfigured: false,
      mcpTiers: 'read',
    });

    expect(warning).not.toBeNull();
    expect(warning).toContain('WITHOUT authentication');
    expect(warning).toContain('REST');
    expect(warning).toContain('read-only');
    expect(warning).toContain('#43');
  });

  it('returns null once authentication is configured (post-#43)', () => {
    const warning = buildUnauthenticatedExposureWarning({
      authConfigured: true,
      mcpTiers: 'read,write',
    });

    expect(warning).toBeNull();
  });
});

describe('logStartupSecurityWarning', () => {
  it('emits the warning exactly once via the logger when unauthenticated', () => {
    const warn = vi.fn();

    logStartupSecurityWarning({ warn }, { authConfigured: false, mcpTiers: 'read,write' });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WITHOUT authentication'));
  });

  it('stays silent when authentication is configured', () => {
    const warn = vi.fn();

    logStartupSecurityWarning({ warn }, { authConfigured: true, mcpTiers: 'read,write' });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('isAuthConfigured', () => {
  it('reports auth as disabled for the shipping default config (pre-#43)', async () => {
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test';
    process.env['NODE_ENV'] = 'test';

    const { config } = await import('./env.js');
    const { isAuthConfigured } = await import('./security-posture.js');

    expect(isAuthConfigured(config)).toBe(false);
  });
});
