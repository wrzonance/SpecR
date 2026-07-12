// src/mcp/package-revision-tools.test.ts
//
// ADR-066 (#389) — pins that the package-revision MCP tool descriptions never
// drift from the parentRevisionId contract the query layer already enforces
// (src/db/queries/revision-parent.ts): issue_package_revision must document
// the optional field, the same-package/depth<=1 custody rule, and the
// isError failure mode; get_revision/list_package_revisions must document
// that they echo it. A registrar fake records descriptions without touching
// capabilities.ts tiers or the DB — registerPackageRevisionTools() itself
// only calls ToolRegistrar.register().
import { describe, it, expect } from 'vitest';
import { registerPackageRevisionTools } from './package-revision-tools.js';
import type { ToolRegistrar } from './tool-registry.js';

function fakeRegistrar(): { registrar: ToolRegistrar; descriptions: Map<string, string> } {
  const descriptions = new Map<string, string>();
  const registrar: ToolRegistrar = {
    declared: [],
    register(name, config) {
      descriptions.set(name, config.description);
    },
  };
  return { registrar, descriptions };
}

describe('registerPackageRevisionTools — parentRevisionId doc parity (ADR-066 #389)', () => {
  it('issue_package_revision documents the optional field, its custody rule, and the failure mode', () => {
    const { registrar, descriptions } = fakeRegistrar();
    registerPackageRevisionTools(registrar);
    const description = descriptions.get('issue_package_revision') ?? '';
    expect(description).toContain('parentRevisionId');
    expect(description).toMatch(/same package/i);
    expect(description).toMatch(/nesting|depth/i);
    expect(description).toMatch(/isError/);
  });

  it('get_revision documents that the response echoes parentRevisionId', () => {
    const { registrar, descriptions } = fakeRegistrar();
    registerPackageRevisionTools(registrar);
    expect(descriptions.get('get_revision') ?? '').toContain('parentRevisionId');
  });

  it('list_package_revisions documents that each summary echoes parentRevisionId', () => {
    const { registrar, descriptions } = fakeRegistrar();
    registerPackageRevisionTools(registrar);
    expect(descriptions.get('list_package_revisions') ?? '').toContain('parentRevisionId');
  });
});
