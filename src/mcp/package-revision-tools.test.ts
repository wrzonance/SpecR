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
import { describe, it, expect, vi } from 'vitest';

// The tool descriptions under test are literals inside registerPackageRevisionTools
// (package-revision-tools.ts); the handlers module only supplies the handler fns +
// input Shapes that get passed straight through to register(). Mock it so this stays
// a pure no-DB unit test: importing the real handlers pulls in ../db/index.js →
// src/lib/env.ts, whose import-time env validation calls process.exit(1) when
// DATABASE_URL is unset, aborting the documented no-DB `pnpm test` suite. This
// mirrors the vi.mock('../db/index.js') isolation the other MCP handler unit tests use.
vi.mock('./package-revision-handlers.js', () => ({
  handleIssuePackageRevision: vi.fn(),
  handleGetRevision: vi.fn(),
  handleListPackageRevisions: vi.fn(),
  IssuePackageRevisionShape: {},
  GetRevisionShape: {},
  ListPackageRevisionsShape: {},
}));

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
    expect(description).toMatch(/isError/);
    // Pin the custody rule's actual direction, not just its keywords — a
    // negated rewrite ("must NOT belong to the same package") or a flipped
    // bound ("nesting depth must exceed 1") would still contain "same
    // package" / "depth" and slip past a keyword-only check.
    expect(description).toMatch(/must belong to the same package/i);
    expect(description).not.toMatch(/must (?:not|never) belong to the same package/i);
    expect(description).toMatch(/nesting depth cannot exceed 1/i);
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
