import {
  handleGetLanguageFindings,
  LanguageFindingsShape,
} from './language-rule-findings-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerLanguageRuleFindingsTools(reg: ToolRegistrar): void {
  reg.register(
    'get_language_findings',
    {
      description:
        'Scan every present spec in a project (or one of its packages) against its resolved ' +
        'language-lint rules (ADR-080) and report findings — banned terms, reinforcing words, ' +
        'flagged party vocabulary, and missing required phrases. `configured: false` (with an ' +
        'explanatory note, no findings) means linting is off for every present spec — it is ' +
        'opt-in, so this is a normal state, never an error.',
      inputSchema: LanguageFindingsShape,
    },
    handleGetLanguageFindings
  );
}
