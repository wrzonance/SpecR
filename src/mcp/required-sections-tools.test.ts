// src/mcp/required-sections-tools.test.ts
//
// #569: set_required_sections' description previously advertised "baseline"
// and { packageId } as accepted `seedFrom` values, but validateSeedForScope
// (src/db/queries/required-sections.ts) rejects anything but "toc" for a
// project baseline — the tool description was actively lying to the model.
// Pins that the two registered descriptions now diverge correctly: the
// baseline/project tool advertises only "toc", and the package tool
// advertises the full set the validator actually permits for package scope.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/index.js', () => ({
  listRequiredSections: vi.fn(),
  setRequiredSections: vi.fn(),
  seedRequiredSections: vi.fn(),
  RequiredSectionsProjectNotFoundError: class RequiredSectionsProjectNotFoundError extends Error {},
  RequiredSectionsPackageNotFoundError: class RequiredSectionsPackageNotFoundError extends Error {},
  RequiredSectionsSeedConflictError: class RequiredSectionsSeedConflictError extends Error {},
  RequiredSectionsInvalidSeedError: class RequiredSectionsInvalidSeedError extends Error {},
  pool: {},
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

interface CapturedTool {
  readonly description: string;
}

// Minimal ToolRegistrar stand-in that just records each config it's handed,
// so the test can assert on the description text without standing up a real
// McpServer or touching capability-tier gating.
function fakeRegistrar(): {
  registrar: import('./tool-registry.js').ToolRegistrar;
  captured: Map<string, CapturedTool>;
} {
  const captured = new Map<string, CapturedTool>();
  return {
    captured,
    registrar: {
      declared: [],
      register(name, config) {
        captured.set(name, { description: config.description });
      },
    },
  };
}

describe('required-sections tool descriptions — seed advertisement matches the validator (#569)', () => {
  it('set_required_sections (baseline/project scope) advertises only "toc", never "baseline" or packageId', async () => {
    const { registerRequiredSectionsTools } = await import('./required-sections-tools.js');
    const { registrar, captured } = fakeRegistrar();

    registerRequiredSectionsTools(registrar);

    const tool = captured.get('set_required_sections');
    expect(tool).toBeDefined();
    expect(tool?.description).toContain('"toc"');
    expect(tool?.description).not.toContain('"baseline"');
    expect(tool?.description).not.toContain('packageId');
  });

  it('set_package_required_sections advertises the full seed set the validator permits for package scope', async () => {
    const { registerRequiredSectionsTools } = await import('./required-sections-tools.js');
    const { registrar, captured } = fakeRegistrar();

    registerRequiredSectionsTools(registrar);

    const tool = captured.get('set_package_required_sections');
    expect(tool).toBeDefined();
    expect(tool?.description).toContain('"baseline"');
    expect(tool?.description).toContain('"toc"');
    expect(tool?.description).toContain('packageId');
  });
});
