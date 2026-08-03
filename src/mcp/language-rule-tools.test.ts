// src/mcp/language-rule-tools.test.ts
//
// Pins the MCP tool-registration boundary for the language-lint rule profile
// surface (#411, ADR-080): registerLanguageRuleTools must declare exactly the
// 6 get/set/clear x library/project tool names, wire each to the correct
// Shape export, and — deliberately, unlike conventions — never register a
// clone tool (ADR-080 D1: no default content exists to clone from).
import { describe, it, expect, vi } from 'vitest';

// vi.hoisted is required: vi.mock factories are hoisted above all imports and
// top-level consts, so the shape markers they close over must be hoisted too.
const {
  LibraryLanguageRulesShape,
  ProjectLanguageRulesShape,
  SetLibraryLanguageRulesShape,
  SetProjectLanguageRulesShape,
} = vi.hoisted(() => {
  const marker = (name: string): { readonly marker: string } => ({ marker: name });
  return {
    LibraryLanguageRulesShape: marker('LibraryLanguageRulesShape'),
    ProjectLanguageRulesShape: marker('ProjectLanguageRulesShape'),
    SetLibraryLanguageRulesShape: marker('SetLibraryLanguageRulesShape'),
    SetProjectLanguageRulesShape: marker('SetProjectLanguageRulesShape'),
  };
});

vi.mock('./language-rule-handlers.js', () => ({
  handleGetLibraryLanguageRules: vi.fn(),
  handleSetLibraryLanguageRules: vi.fn(),
  handleClearLibraryLanguageRules: vi.fn(),
  handleGetProjectLanguageRules: vi.fn(),
  handleSetProjectLanguageRules: vi.fn(),
  handleClearProjectLanguageRules: vi.fn(),
  LibraryLanguageRulesShape,
  ProjectLanguageRulesShape,
  SetLibraryLanguageRulesShape,
  SetProjectLanguageRulesShape,
}));

import { registerLanguageRuleTools } from './language-rule-tools.js';
import type { ToolRegistrar } from './tool-registry.js';

interface Recorded {
  readonly description: string;
  readonly inputSchema: unknown;
}

function fakeRegistrar(): { registrar: ToolRegistrar; recorded: Map<string, Recorded> } {
  const recorded = new Map<string, Recorded>();
  const registrar: ToolRegistrar = {
    declared: [],
    schemas: new Map(),
    register(name, config) {
      recorded.set(name, { description: config.description, inputSchema: config.inputSchema });
    },
  };
  return { registrar, recorded };
}

const EXPECTED_TOOL_NAMES = [
  'get_library_language_rules',
  'set_library_language_rules',
  'clear_library_language_rules',
  'get_project_language_rules',
  'set_project_language_rules',
  'clear_project_language_rules',
] as const;

describe('registerLanguageRuleTools', () => {
  it('declares exactly the 6 get/set/clear x library/project tool names, no more, no fewer', () => {
    const { registrar, recorded } = fakeRegistrar();
    registerLanguageRuleTools(registrar);
    const localeCompare = (a: string, b: string): number => a.localeCompare(b);
    expect([...recorded.keys()].sort(localeCompare)).toEqual(
      [...EXPECTED_TOOL_NAMES].sort(localeCompare)
    );
  });

  it('never registers a clone tool (ADR-080 D1 — no default content exists to clone)', () => {
    const { registrar, recorded } = fakeRegistrar();
    registerLanguageRuleTools(registrar);
    expect(recorded.has('clone_language_rules')).toBe(false);
  });

  it.each([
    ['get_library_language_rules', LibraryLanguageRulesShape],
    ['clear_library_language_rules', LibraryLanguageRulesShape],
    ['get_project_language_rules', ProjectLanguageRulesShape],
    ['clear_project_language_rules', ProjectLanguageRulesShape],
  ])('%s is wired to its scope id shape (not a re-derived shape)', (name, shape) => {
    const { registrar, recorded } = fakeRegistrar();
    registerLanguageRuleTools(registrar);
    expect(recorded.get(name)?.inputSchema).toBe(shape);
  });

  it.each([
    ['set_library_language_rules', SetLibraryLanguageRulesShape],
    ['set_project_language_rules', SetProjectLanguageRulesShape],
  ])('%s is wired to its Set shape (scope id + rules)', (name, shape) => {
    const { registrar, recorded } = fakeRegistrar();
    registerLanguageRuleTools(registrar);
    expect(recorded.get(name)?.inputSchema).toBe(shape);
  });

  it('get/set descriptions point readers at ADR-080', () => {
    // clear_* tools just delete a row and echo back an id, so — mirroring
    // header-footer-tools.test.ts's same carve-out — they carry no rule-shape
    // ambiguity worth pointing at the ADR for.
    const { registrar, recorded } = fakeRegistrar();
    registerLanguageRuleTools(registrar);
    const ruleBearingTools = EXPECTED_TOOL_NAMES.filter((name) => !name.startsWith('clear_'));
    for (const name of ruleBearingTools) {
      expect(recorded.get(name)?.description ?? '', `${name} description`).toMatch(/ADR-080/);
    }
  });
});
