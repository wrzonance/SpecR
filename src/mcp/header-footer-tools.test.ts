// src/mcp/header-footer-tools.test.ts
//
// Pins the MCP tool-registration boundary for the header/footer surface (#476,
// ADR-040): registerHeaderFooterTools must declare exactly the 15 CRUD +
// resolve tool names, wire each to the correct Shape export (never a re-derived
// or re-flattened shape — see the spike finding #1 nested-`config` fix in
// header-footer-handlers.ts), and never expose a resolve tool for client scope
// (resolveHeaderFooterConfig has no client-scope resolution context). A
// registrar fake records name -> {description, inputSchema} without touching
// capabilities.ts tiers or the DB.
import { describe, it, expect, vi } from 'vitest';

// Mock both handler modules so this stays a pure no-DB unit test — importing
// the real handlers pulls in ../db/index.js -> src/lib/env.ts (mirrors the
// vi.mock isolation package-revision-tools.test.ts already uses). Shapes are
// distinct marker objects so a mis-wired registration (wrong shape passed to
// the wrong tool) fails on object identity, not just on "some shape or other".
// vi.hoisted is required: vi.mock factories are hoisted above all imports and
// top-level consts, so the markers they close over must be hoisted too.
const {
  LibraryHeaderFooterShape,
  ProjectHeaderFooterShape,
  PackageHeaderFooterShape,
  RevisionHeaderFooterShape,
  SetLibraryHeaderFooterShape,
  SetProjectHeaderFooterShape,
  SetPackageHeaderFooterShape,
  SetRevisionHeaderFooterShape,
} = vi.hoisted(() => {
  const marker = (name: string): { readonly marker: string } => ({ marker: name });
  return {
    LibraryHeaderFooterShape: marker('LibraryHeaderFooterShape'),
    ProjectHeaderFooterShape: marker('ProjectHeaderFooterShape'),
    PackageHeaderFooterShape: marker('PackageHeaderFooterShape'),
    RevisionHeaderFooterShape: marker('RevisionHeaderFooterShape'),
    SetLibraryHeaderFooterShape: marker('SetLibraryHeaderFooterShape'),
    SetProjectHeaderFooterShape: marker('SetProjectHeaderFooterShape'),
    SetPackageHeaderFooterShape: marker('SetPackageHeaderFooterShape'),
    SetRevisionHeaderFooterShape: marker('SetRevisionHeaderFooterShape'),
  };
});

vi.mock('./header-footer-handlers.js', () => ({
  handleGetLibraryHeaderFooter: vi.fn(),
  handleSetLibraryHeaderFooter: vi.fn(),
  handleClearLibraryHeaderFooter: vi.fn(),
  handleGetProjectHeaderFooter: vi.fn(),
  handleSetProjectHeaderFooter: vi.fn(),
  handleClearProjectHeaderFooter: vi.fn(),
  handleGetPackageHeaderFooter: vi.fn(),
  handleSetPackageHeaderFooter: vi.fn(),
  handleClearPackageHeaderFooter: vi.fn(),
  handleGetRevisionHeaderFooter: vi.fn(),
  handleSetRevisionHeaderFooter: vi.fn(),
  handleClearRevisionHeaderFooter: vi.fn(),
  LibraryHeaderFooterShape,
  ProjectHeaderFooterShape,
  PackageHeaderFooterShape,
  RevisionHeaderFooterShape,
  SetLibraryHeaderFooterShape,
  SetProjectHeaderFooterShape,
  SetPackageHeaderFooterShape,
  SetRevisionHeaderFooterShape,
}));

vi.mock('./header-footer-resolve-handlers.js', () => ({
  handleResolveProjectHeaderFooter: vi.fn(),
  handleResolvePackageHeaderFooter: vi.fn(),
  handleResolveRevisionHeaderFooter: vi.fn(),
  ResolveProjectHeaderFooterShape: ProjectHeaderFooterShape,
  ResolvePackageHeaderFooterShape: PackageHeaderFooterShape,
  ResolveRevisionHeaderFooterShape: RevisionHeaderFooterShape,
}));

import { registerHeaderFooterTools } from './header-footer-tools.js';
import type { ToolRegistrar } from './tool-registry.js';

interface Recorded {
  readonly description: string;
  readonly inputSchema: unknown;
}

function fakeRegistrar(): { registrar: ToolRegistrar; recorded: Map<string, Recorded> } {
  const recorded = new Map<string, Recorded>();
  const registrar: ToolRegistrar = {
    declared: [],
    register(name, config) {
      recorded.set(name, { description: config.description, inputSchema: config.inputSchema });
    },
  };
  return { registrar, recorded };
}

const EXPECTED_TOOL_NAMES = [
  'get_library_header_footer',
  'set_library_header_footer',
  'clear_library_header_footer',
  'get_project_header_footer',
  'set_project_header_footer',
  'clear_project_header_footer',
  'get_package_header_footer',
  'set_package_header_footer',
  'clear_package_header_footer',
  'get_revision_header_footer',
  'set_revision_header_footer',
  'clear_revision_header_footer',
  'resolve_project_header_footer',
  'resolve_package_header_footer',
  'resolve_revision_header_footer',
] as const;

describe('registerHeaderFooterTools', () => {
  it('declares exactly the 15 CRUD + resolve tool names, no more, no fewer', () => {
    const { registrar, recorded } = fakeRegistrar();
    registerHeaderFooterTools(registrar);
    const localeCompare = (a: string, b: string): number => a.localeCompare(b);
    expect([...recorded.keys()].sort(localeCompare)).toEqual(
      [...EXPECTED_TOOL_NAMES].sort(localeCompare)
    );
  });

  it('never registers a resolve tool for client (library) scope', () => {
    const { registrar, recorded } = fakeRegistrar();
    registerHeaderFooterTools(registrar);
    expect(recorded.has('resolve_library_header_footer')).toBe(false);
  });

  it.each([
    ['get_library_header_footer', LibraryHeaderFooterShape],
    ['clear_library_header_footer', LibraryHeaderFooterShape],
    ['get_project_header_footer', ProjectHeaderFooterShape],
    ['clear_project_header_footer', ProjectHeaderFooterShape],
    ['get_package_header_footer', PackageHeaderFooterShape],
    ['clear_package_header_footer', PackageHeaderFooterShape],
    ['get_revision_header_footer', RevisionHeaderFooterShape],
    ['clear_revision_header_footer', RevisionHeaderFooterShape],
    ['resolve_project_header_footer', ProjectHeaderFooterShape],
    ['resolve_package_header_footer', PackageHeaderFooterShape],
    ['resolve_revision_header_footer', RevisionHeaderFooterShape],
  ])('%s is wired to its scope id shape (not a re-derived shape)', (name, shape) => {
    const { registrar, recorded } = fakeRegistrar();
    registerHeaderFooterTools(registrar);
    expect(recorded.get(name)?.inputSchema).toBe(shape);
  });

  it.each([
    ['set_library_header_footer', SetLibraryHeaderFooterShape],
    ['set_project_header_footer', SetProjectHeaderFooterShape],
    ['set_package_header_footer', SetPackageHeaderFooterShape],
    ['set_revision_header_footer', SetRevisionHeaderFooterShape],
  ])(
    '%s is wired to its nested-config Set shape (spike finding #1 — never a flattened spread)',
    (name, shape) => {
      const { registrar, recorded } = fakeRegistrar();
      registerHeaderFooterTools(registrar);
      expect(recorded.get(name)?.inputSchema).toBe(shape);
    }
  );

  it('descriptions point readers at ADR-040 for v1-vs-v2 (defaultVariant) semantics', () => {
    // Only the tools that actually return/accept a composition body need the
    // pointer — clear_* tools just delete a row and echo back an id, so they
    // carry no composition-shape ambiguity to document.
    const { registrar, recorded } = fakeRegistrar();
    registerHeaderFooterTools(registrar);
    const compositionBearingTools = EXPECTED_TOOL_NAMES.filter(
      (name) => !name.startsWith('clear_')
    );
    for (const name of compositionBearingTools) {
      expect(recorded.get(name)?.description ?? '', `${name} description`).toMatch(/ADR-040/);
    }
  });
});
