import {
  handleGetLibraryLanguageRules,
  handleSetLibraryLanguageRules,
  handleClearLibraryLanguageRules,
  handleGetProjectLanguageRules,
  handleSetProjectLanguageRules,
  handleClearProjectLanguageRules,
  LibraryLanguageRulesShape,
  ProjectLanguageRulesShape,
  SetLibraryLanguageRulesShape,
  SetProjectLanguageRulesShape,
} from './language-rule-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

// #411 / ADR-080 — language-lint rule profile CRUD across the two scopes
// (library, project). No default content exists to clone — SpecR ships the
// mechanism only (ADR-080 D1) — so there is deliberately no clone tool
// alongside get/set/clear, unlike list_conventions/clone_conventions.

export function registerLanguageRuleTools(reg: ToolRegistrar): void {
  registerLanguageRuleGetTools(reg);
  registerLanguageRuleSetTools(reg);
  registerLanguageRuleClearTools(reg);
}

function registerLanguageRuleGetTools(reg: ToolRegistrar): void {
  reg.register(
    'get_library_language_rules',
    {
      description:
        "Return a library's own language-lint rule set (banned terms, reinforcing words, " +
        'party vocabulary, required phrases; ADR-080). Linting is opt-in — there is no built-in ' +
        'default — so isError when the library has no profile configured.',
      inputSchema: LibraryLanguageRulesShape,
    },
    handleGetLibraryLanguageRules
  );

  reg.register(
    'get_project_language_rules',
    {
      description:
        "Return a project's own language-lint rule set (ADR-080). This is the project's own " +
        'profile only, not the merged effective set — use get_language_findings to see findings ' +
        'from the fully resolved rules across every contributing layer. isError when the project ' +
        'has no profile configured.',
      inputSchema: ProjectLanguageRulesShape,
    },
    handleGetProjectLanguageRules
  );
}

function registerLanguageRuleSetTools(reg: ToolRegistrar): void {
  reg.register(
    'set_library_language_rules',
    {
      description:
        "Create or replace a library's language-lint rule set (ADR-080). Upsert — one profile " +
        'per library. An unsafe/catastrophic regex in an isRegex:true term is rejected. Returns ' +
        'the stored profile.',
      inputSchema: SetLibraryLanguageRulesShape,
    },
    handleSetLibraryLanguageRules
  );

  reg.register(
    'set_project_language_rules',
    {
      description:
        "Create or replace a project's language-lint rule set (ADR-080). Upsert — one profile " +
        'per project. An unsafe/catastrophic regex in an isRegex:true term is rejected. Returns ' +
        'the stored profile.',
      inputSchema: SetProjectLanguageRulesShape,
    },
    handleSetProjectLanguageRules
  );
}

function registerLanguageRuleClearTools(reg: ToolRegistrar): void {
  reg.register(
    'clear_library_language_rules',
    {
      description:
        "Clear a library's language-lint rule set (reversible), not destructive. Returns " +
        '{ libraryId, cleared: true }.',
      inputSchema: LibraryLanguageRulesShape,
    },
    handleClearLibraryLanguageRules
  );

  reg.register(
    'clear_project_language_rules',
    {
      description:
        "Clear a project's language-lint rule set (reversible), not destructive. Returns " +
        '{ projectId, cleared: true }.',
      inputSchema: ProjectLanguageRulesShape,
    },
    handleClearProjectLanguageRules
  );
}
