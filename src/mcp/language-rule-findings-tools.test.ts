// src/mcp/language-rule-findings-tools.test.ts
//
// Pins the MCP tool-registration boundary for the language-lint findings
// report (#411, ADR-080): registerLanguageRuleFindingsTools declares exactly
// one tool, wired to the findings input shape, describing the opt-in
// configured:false behavior.
import { describe, it, expect, vi } from 'vitest';

const { LanguageFindingsShape } = vi.hoisted(() => ({
  LanguageFindingsShape: { marker: 'LanguageFindingsShape' },
}));

vi.mock('./language-rule-findings-handlers.js', () => ({
  handleGetLanguageFindings: vi.fn(),
  LanguageFindingsShape,
}));

import { registerLanguageRuleFindingsTools } from './language-rule-findings-tools.js';
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

describe('registerLanguageRuleFindingsTools', () => {
  it('declares exactly one tool: get_language_findings', () => {
    const { registrar, recorded } = fakeRegistrar();
    registerLanguageRuleFindingsTools(registrar);
    expect([...recorded.keys()]).toEqual(['get_language_findings']);
  });

  it('is wired to the LanguageFindingsShape (not a re-derived shape)', () => {
    const { registrar, recorded } = fakeRegistrar();
    registerLanguageRuleFindingsTools(registrar);
    expect(recorded.get('get_language_findings')?.inputSchema).toBe(LanguageFindingsShape);
  });

  it('describes configured:false as a normal state, never an error', () => {
    const { registrar, recorded } = fakeRegistrar();
    registerLanguageRuleFindingsTools(registrar);
    const description = recorded.get('get_language_findings')?.description ?? '';
    expect(description).toMatch(/configured: false/);
    expect(description.toLowerCase()).toMatch(/opt-in/);
  });
});
