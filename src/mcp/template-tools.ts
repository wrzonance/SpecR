import {
  handleListTemplates,
  handleGetTemplate,
  handleCreateTemplate,
  handleUpdateTemplate,
  handleUpsertTemplateRules,
  handleDeleteTemplate,
  handleImportTemplate,
  TemplateIdShape,
  CreateTemplateShape,
  UpdateTemplateShape,
  UpsertTemplateRulesShape,
  ImportTemplateShape,
} from './template-handlers.js';
import type { ToolRegistrar } from './tool-registry.js';

export function registerTemplateTools(reg: ToolRegistrar): void {
  registerTemplateReadTools(reg);
  registerTemplateWriteTools(reg);
  registerTemplateDestructiveTools(reg);
}

function registerTemplateReadTools(reg: ToolRegistrar): void {
  reg.register(
    'list_templates',
    {
      description:
        'List all style templates (id, name, owner, rule count) — the house styles the ' +
        'generator can render a spec with (#138). Use to obtain the templateId that ' +
        'assign_style_source needs.',
      inputSchema: {},
    },
    handleListTemplates
  );

  reg.register(
    'get_template',
    {
      description:
        'Return one style template with its full style-rule set (per-nodeType properties). ' +
        'Returns isError when the template UUID is not found.',
      inputSchema: TemplateIdShape,
    },
    handleGetTemplate
  );
}

function registerTemplateWriteTools(reg: ToolRegistrar): void {
  reg.register(
    'create_template',
    {
      description:
        'Create a new, empty style template (name unique, optional owner). Add rules with ' +
        'upsert_template_rules, or use import_template to derive them from a .docx. Returns ' +
        'the new template meta { id, name, owner }.',
      inputSchema: CreateTemplateShape,
    },
    handleCreateTemplate
  );

  reg.register(
    'update_template',
    {
      description:
        'Rename a style template or change its owner (owner: null clears it). At least one ' +
        'of name or owner must be present. Returns the updated meta.',
      inputSchema: UpdateTemplateShape,
    },
    handleUpdateTemplate
  );

  reg.register(
    'upsert_template_rules',
    {
      description:
        'Replace/insert the style rules for a template in bulk (one rule per nodeType with ' +
        'its properties). Returns the template with its full rule set.',
      inputSchema: UpsertTemplateRulesShape,
    },
    handleUpsertTemplateRules
  );

  reg.register(
    'import_template',
    {
      description:
        'Derive a style template from a .docx: analyze its styles, extract per-nodeType ' +
        'formatting, and persist as a new named template. Pass the file as base64. The ' +
        'document is analysis-only and never stored (ADR-021). Returns { template, report }.',
      inputSchema: ImportTemplateShape,
    },
    handleImportTemplate
  );
}

function registerTemplateDestructiveTools(reg: ToolRegistrar): void {
  reg.register(
    'delete_template',
    {
      description:
        'Permanently delete a style template. Rejected (isError) if any spec still references ' +
        'it — reassign or clear those specs first (RESTRICT, #138). Off by default: destructive ' +
        'tier, gated by MCP_ALLOWED_TIERS.',
      inputSchema: TemplateIdShape,
    },
    handleDeleteTemplate
  );
}
