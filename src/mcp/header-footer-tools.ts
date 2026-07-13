// src/mcp/header-footer-tools.ts
//
// MCP tool registration for the header/footer CRUD + resolve surface (#476).
// Composes three sub-registrars (get / set-and-clear / resolve) that mirror
// the SCOPE_META dispatch in src/api/header-footer.ts and
// src/api/header-footer-resolve.ts — the four scope kinds (client/project/
// package/revision) only ever differ in which id shape and handler they use.
import {
  handleGetLibraryHeaderFooter,
  handleSetLibraryHeaderFooter,
  handleClearLibraryHeaderFooter,
  handleGetProjectHeaderFooter,
  handleSetProjectHeaderFooter,
  handleClearProjectHeaderFooter,
  handleGetPackageHeaderFooter,
  handleSetPackageHeaderFooter,
  handleClearPackageHeaderFooter,
  handleGetRevisionHeaderFooter,
  handleSetRevisionHeaderFooter,
  handleClearRevisionHeaderFooter,
  LibraryHeaderFooterShape,
  ProjectHeaderFooterShape,
  PackageHeaderFooterShape,
  RevisionHeaderFooterShape,
  SetLibraryHeaderFooterShape,
  SetProjectHeaderFooterShape,
  SetPackageHeaderFooterShape,
  SetRevisionHeaderFooterShape,
} from './header-footer-handlers.js';
import {
  handleResolveProjectHeaderFooter,
  handleResolvePackageHeaderFooter,
  handleResolveRevisionHeaderFooter,
  ResolveProjectHeaderFooterShape,
  ResolvePackageHeaderFooterShape,
  ResolveRevisionHeaderFooterShape,
} from './header-footer-resolve-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

// ADR-040: v2 adds `variants` (default/first/even), `pageNumbering`, and a
// `raw` OOXML sidecar on top of the v1 { header, footer, style } shape.
// defaultVariant(config) is the compat accessor — variants.default wins when
// present, otherwise the v1 top-level fields.
const ADR_NOTE =
  'See ADR-040 for the v1 { header, footer, style } vs v2 variants/pageNumbering/raw ' +
  'shape and the defaultVariant() compat accessor.';

export function registerHeaderFooterTools(reg: ToolRegistrar): void {
  registerHeaderFooterGetTools(reg);
  registerHeaderFooterSetTools(reg);
  registerHeaderFooterClearTools(reg);
  registerHeaderFooterResolveTools(reg);
}

function registerHeaderFooterGetTools(reg: ToolRegistrar): void {
  reg.register(
    'get_library_header_footer',
    {
      description:
        `Return a client library's own header/footer composition. ${ADR_NOTE} isError ` +
        'when the library has no config of its own — this scope has no fallback.',
      inputSchema: LibraryHeaderFooterShape,
    },
    handleGetLibraryHeaderFooter
  );

  reg.register(
    'get_project_header_footer',
    {
      description:
        `Return a project's own header/footer composition (not resolved through the scope ` +
        `chain — use resolve_project_header_footer for the effective config). ${ADR_NOTE} ` +
        'isError when the project has no config of its own.',
      inputSchema: ProjectHeaderFooterShape,
    },
    handleGetProjectHeaderFooter
  );

  reg.register(
    'get_package_header_footer',
    {
      description:
        `Return a design package's own header/footer composition (not resolved — use ` +
        `resolve_package_header_footer for the effective config). ${ADR_NOTE} isError when ` +
        'the package has no config of its own.',
      inputSchema: PackageHeaderFooterShape,
    },
    handleGetPackageHeaderFooter
  );

  reg.register(
    'get_revision_header_footer',
    {
      description:
        `Return a package revision's own header/footer composition (not resolved — use ` +
        `resolve_revision_header_footer for the effective config). ${ADR_NOTE} isError when ` +
        'the revision has no config of its own.',
      inputSchema: RevisionHeaderFooterShape,
    },
    handleGetRevisionHeaderFooter
  );
}

function registerHeaderFooterSetTools(reg: ToolRegistrar): void {
  reg.register(
    'set_library_header_footer',
    {
      description:
        `Create or replace a client library's header/footer composition. ${ADR_NOTE} ` +
        'Upsert — one per library. Returns the stored config.',
      inputSchema: SetLibraryHeaderFooterShape,
    },
    handleSetLibraryHeaderFooter
  );

  reg.register(
    'set_project_header_footer',
    {
      description:
        `Create or replace a project's header/footer composition, overriding its inherited ` +
        `client-library config for this project and below. ${ADR_NOTE} Upsert — one per ` +
        'project. Returns the stored config.',
      inputSchema: SetProjectHeaderFooterShape,
    },
    handleSetProjectHeaderFooter
  );

  reg.register(
    'set_package_header_footer',
    {
      description:
        `Create or replace a design package's header/footer composition, overriding its ` +
        `inherited project config for this package and below. ${ADR_NOTE} Upsert — one per ` +
        'package. Returns the stored config.',
      inputSchema: SetPackageHeaderFooterShape,
    },
    handleSetPackageHeaderFooter
  );

  reg.register(
    'set_revision_header_footer',
    {
      description:
        `Create or replace a package revision's header/footer composition, overriding every ` +
        `inherited layer above it. ${ADR_NOTE} Upsert — one per revision. Returns the stored ` +
        'config.',
      inputSchema: SetRevisionHeaderFooterShape,
    },
    handleSetRevisionHeaderFooter
  );
}

function registerHeaderFooterClearTools(reg: ToolRegistrar): void {
  reg.register(
    'clear_library_header_footer',
    {
      description:
        "Clear a client library's own header/footer configuration (reversible), not destructive. " +
        'Returns { libraryId, cleared: true }.',
      inputSchema: LibraryHeaderFooterShape,
    },
    handleClearLibraryHeaderFooter
  );

  reg.register(
    'clear_project_header_footer',
    {
      description:
        "Clear a project's header/footer override so it falls back to its client library's " +
        'config (reversible), not destructive. Returns { projectId, cleared: true }.',
      inputSchema: ProjectHeaderFooterShape,
    },
    handleClearProjectHeaderFooter
  );

  reg.register(
    'clear_package_header_footer',
    {
      description:
        "Clear a design package's header/footer override so it falls back to its project's " +
        'config (reversible), not destructive. Returns { packageId, cleared: true }.',
      inputSchema: PackageHeaderFooterShape,
    },
    handleClearPackageHeaderFooter
  );

  reg.register(
    'clear_revision_header_footer',
    {
      description:
        "Clear a package revision's header/footer override so it falls back to its " +
        "package's config (reversible), not destructive. Returns { revisionId, cleared: true }.",
      inputSchema: RevisionHeaderFooterShape,
    },
    handleClearRevisionHeaderFooter
  );
}

function registerHeaderFooterResolveTools(reg: ToolRegistrar): void {
  reg.register(
    'resolve_project_header_footer',
    {
      description:
        'Return the effective header/footer composition for a project, resolved across the ' +
        'client -> project scope chain. `layers` lists every contributing config in ' +
        'resolution order — the last entry is the winning (most-specific) layer. ' +
        `${ADR_NOTE} isError when the project is not found.`,
      inputSchema: ResolveProjectHeaderFooterShape,
    },
    handleResolveProjectHeaderFooter
  );

  reg.register(
    'resolve_package_header_footer',
    {
      description:
        'Return the effective header/footer composition for a design package, resolved ' +
        'across the client -> project -> package scope chain. `layers` lists every ' +
        'contributing config in resolution order — the last entry is the winning ' +
        `(most-specific) layer. ${ADR_NOTE} isError when the package is not found.`,
      inputSchema: ResolvePackageHeaderFooterShape,
    },
    handleResolvePackageHeaderFooter
  );

  reg.register(
    'resolve_revision_header_footer',
    {
      description:
        'Return the effective header/footer composition for a package revision, resolved ' +
        'across the full client -> project -> package -> revision scope chain. `layers` lists ' +
        'every contributing config in resolution order — the last entry is the winning ' +
        `(most-specific) layer. ${ADR_NOTE} isError when the revision is not found.`,
      inputSchema: ResolveRevisionHeaderFooterShape,
    },
    handleResolveRevisionHeaderFooter
  );
}
