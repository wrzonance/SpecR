// src/mcp/onboarding-tools.ts
// Registration for the onboarding/editability MCP tools (#140). Split out of
// tools.ts to keep that file under the 400-line cap; the handlers live in
// onboarding-handlers.ts. registerOnboardingTools is called from registerTools.
import { z } from 'zod';
import type { ToolRegistrar } from './tool-registry.js';
import { EditabilitySchema, ConventionRulesSchema } from '../ast/index.js';
import {
  handleReviewEditability,
  handleGetOnboardingReport,
  handleSetEditabilityOverride,
  handleClearEditabilityOverride,
  handleReclassifySpec,
} from './onboarding-handlers.js';

const specIdArg = z.uuid().describe('Spec UUID (from search_library or list_sections)');
const nodeIdArg = z.uuid().describe('Paragraph (node) UUID (from review_editability or get_spec)');

function registerReviewTools(reg: ToolRegistrar): void {
  reg.register(
    'review_editability',
    {
      description:
        'List per-paragraph effective editability for a spec: value (locked|editable|choice|note), ' +
        'machine confidence, evidence, and a human override when one is set. Evidence and confidence ' +
        'are the same the REST tree surfaces (shared getSpecTree query). Pass maxConfidence to return ' +
        'only nodes at or below that confidence — the human review queue for an onboarded master.',
      inputSchema: {
        specId: specIdArg,
        maxConfidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            'Return only nodes with confidence ≤ this value (0–1); omitted = all classified'
          ),
      },
    },
    handleReviewEditability
  );

  reg.register(
    'get_onboarding_report',
    {
      description:
        'Onboarding review report for a spec: editability summary (counts + low-confidence nodes), ' +
        'hierarchy-inference confidence summary (scored/unscored/belowThreshold counts + worst-first ' +
        'low-confidence nodes; unscored carries its reason), assigned style source, ' +
        'manual-emphasis findings (paragraph locator + run spans), styleSourceNeeded, and ' +
        'onboardingStatus. Reuses the same editability ' +
        'summarizer the #135 import-job report uses. Note: styleDerivation and parseWarnings are ' +
        'import-time-only (raw uploaded bytes are not persisted) and are not reproduced here.',
      inputSchema: { specId: specIdArg },
    },
    handleGetOnboardingReport
  );
}

function registerOverrideTools(reg: ToolRegistrar): void {
  reg.register(
    'set_editability_override',
    {
      description:
        'Apply a human editability override on one paragraph (the #136 PATCH as a tool). ' +
        'The override takes effect over the machine verdict and survives reclassification.',
      inputSchema: {
        specId: specIdArg,
        nodeId: nodeIdArg,
        editability: EditabilitySchema.describe(
          'Override value: locked | editable | choice | note'
        ),
      },
    },
    handleSetEditabilityOverride
  );

  reg.register(
    'clear_editability_override',
    {
      description:
        'Remove a human editability override on one paragraph, reverting to the machine verdict.',
      inputSchema: { specId: specIdArg, nodeId: nodeIdArg },
    },
    handleClearEditabilityOverride
  );

  reg.register(
    'reclassify_spec',
    {
      description:
        'Re-run editability classification over a spec and return the before/after diff ' +
        '({ specId, persisted, total, changed, entries }). Without rules, resolves the stored ' +
        'convention profile (or the built-in default). preview=true computes the diff without ' +
        'persisting. Human overrides are never clobbered (overrideDisagrees flags disagreement).',
      inputSchema: {
        specId: specIdArg,
        rules: ConventionRulesSchema.optional().describe(
          'Optional convention rules to classify against; omitted = resolve the stored profile'
        ),
        preview: z
          .boolean()
          .optional()
          .describe('If true, compute the diff but do not persist the new classification'),
      },
    },
    handleReclassifySpec
  );
}

export function registerOnboardingTools(reg: ToolRegistrar): void {
  registerReviewTools(reg);
  registerOverrideTools(reg);
}
