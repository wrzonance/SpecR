import type { Request, Response } from 'express';
import { z } from 'zod';
import { GenerateBodySchema } from '../ast/index.js';
import type { StyleRule, SpecTree } from '../ast/index.js';
import type { SectionNumberFormat } from '../lib/section-number.js';
import {
  getSpecTree,
  getTemplate,
  getTemplateByName,
  findProjectById,
  resolveSpecGenerationContext,
  resolveProjectManualHeaderFooterContext,
  resolveRevisionHeaderFooterContext,
  getPackageRevisionManualData,
  getPackageRevisionAddendumManualData,
  RevisionComparisonError,
  pool,
} from '../db/index.js';
import type {
  ProjectTocEntry,
  RevisionAddendumManualData,
  RevisionManualData,
  RevisionSpecEntry,
} from '../db/index.js';
import { generateDocx, generateManual } from '../generator/index.js';
import type { GenerateDocxOptions, ManualMeta, ManualSectionListing } from '../generator/index.js';
import { logger } from '../lib/logger.js';
import { buildHeaderFooterOptions } from './generate-header-footer.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const RevisionGenerateBodySchema = GenerateBodySchema.extend({
  baseRevisionId: z.uuid().exactOptional(),
});

type RevisionGenerateBody = z.infer<typeof RevisionGenerateBodySchema>;

// When no templateId is given the seeded default applies, so an explicit
// default-template request and a bare request produce identical output.
// Missing default (un-migrated DB) degrades to unstyled output, never an error.
const DEFAULT_TEMPLATE_NAME = 'UFGS-Default';

// Exported for unit testing.
export function safeFilename(section: string, title: string): string {
  // '.' is allowed in the section part so '26 00 13.10' stays distinguishable
  // from a hypothetical '26 00 1310' in the suggested filename.
  const s = section.replace(/[^a-zA-Z0-9.-]/g, '-').replace(/-+/g, '-');
  const t = title
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return `${s}-${t}.docx`;
}

type RulesResolution =
  | { readonly found: true; readonly rules: readonly StyleRule[] | undefined }
  | { readonly found: false };

async function resolveStyleRules(templateId: string | undefined): Promise<RulesResolution> {
  if (templateId !== undefined) {
    const template = await getTemplate(templateId);
    return template ? { found: true, rules: template.rules } : { found: false };
  }
  const fallback = await getTemplateByName(DEFAULT_TEMPLATE_NAME);
  return { found: true, rules: fallback?.rules };
}

function generateOptions(
  format: SectionNumberFormat | undefined
): { readonly sectionNumberFormat: SectionNumberFormat } | undefined {
  return format === undefined ? undefined : { sectionNumberFormat: format };
}

export async function generateHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid spec id' });
    return;
  }
  const bodyResult = GenerateBodySchema.safeParse(req.body ?? {});
  if (!bodyResult.success) {
    res.status(400).json({ success: false, error: 'invalid generate request body' });
    return;
  }
  try {
    const result = await getSpecTree(idResult.data);
    if (!result) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    const resolution = await resolveStyleRules(bodyResult.data.templateId);
    if (!resolution.found) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    // One ownership snapshot feeds BOTH the section-number-format fallback
    // (issue #267) and the header/footer context (issue #304), so a concurrent
    // project_specs membership change can never pair one project's numbering
    // with another's header/footer. Request body wins for the format; null
    // (orphan or multi-project) → canonical. Header/footer is omitted entirely
    // when nothing applies, keeping an orphan or unconfigured spec's output
    // byte-identical to the pre-#304 baseline (buildHeaderFooterOptions's
    // undefined gate).
    const specContext = await resolveSpecGenerationContext(idResult.data, pool);
    const format =
      bodyResult.data.sectionNumberFormat ?? specContext.sectionNumberFormat ?? undefined;
    const headerFooter = buildHeaderFooterOptions(specContext.headerFooter);
    const baseOptions = generateOptions(format);
    const options = headerFooter ? { ...baseOptions, headerFooter } : baseOptions;
    const buffer = await generateDocx(result.tree, resolution.rules, options);
    const filename = safeFilename(result.tree.section, result.tree.title);
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'generate failed');
    res.status(500).json({ success: false, error: 'generation failed' });
  }
}

// Exported for unit testing.
export function manualFilename(projectName: string): string {
  return `${filenameBase(projectName)}-manual.docx`;
}

function filenameBase(value: string): string {
  const base =
    value
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80)
      .replace(/^-|-$/g, '') || 'project';
  return base;
}

export function revisionManualFilename(projectName: string, revisionName: string): string {
  return `${filenameBase(projectName)}-${filenameBase(revisionName)}-manual.docx`;
}

/** Fetch each TOC section's tree in position order; drop any that vanished
 *  (FK makes this unreachable in practice, handled defensively). */
async function collectSectionTrees(toc: readonly ProjectTocEntry[]): Promise<SpecTree[]> {
  const results = await Promise.all(toc.map((entry) => getSpecTree(entry.specId)));
  return results.flatMap((result) => (result ? [result.tree] : []));
}

function revisionSectionListing(entry: RevisionSpecEntry): ManualSectionListing {
  return { section: entry.tree.section, title: entry.tree.title };
}

function revisionManualMeta(data: RevisionManualData): ManualMeta {
  return {
    name: data.project.name,
    description: data.project.description,
    revision: {
      displayName: data.revision.displayName,
      date: data.revision.date,
      packageName: data.designPackage.name,
    },
  };
}

function addendumManualMeta(data: RevisionAddendumManualData): ManualMeta {
  return {
    ...revisionManualMeta(data),
    addendum: { affectedSections: data.changedSpecs.map(revisionSectionListing) },
  };
}

interface RevisionDocx {
  readonly buffer: Buffer;
  readonly filename: string;
}

/**
 * Resolve and layer the revision-scoped header/footer (#481) onto an already-
 * computed base options object. Keyed on `data.revision.revisionId` — the
 * revision actually being rendered — never `body.baseRevisionId`: an addendum
 * renders the CHANGED revision's own trees, so its header/footer must resolve
 * from that same revision's chain, not its comparison base. Field values are
 * threaded straight from the caller's already-fetched `RevisionManualData`
 * snapshot (no second DB read, no TOCTOU). Omits `headerFooter` entirely when
 * the resolved context is null (zero configured layers), keeping `options`
 * byte-identical to the pre-#481 baseline for an unconfigured chain.
 */
async function withRevisionHeaderFooter(
  data: RevisionManualData,
  baseOptions: ReturnType<typeof generateOptions>
): Promise<GenerateDocxOptions | undefined> {
  const context = await resolveRevisionHeaderFooterContext(
    data.revision.revisionId,
    {
      projectName: data.project.name,
      packageName: data.designPackage.name,
      revisionName: data.revision.displayName,
      revisionLabel: data.revision.label,
    },
    pool
  );
  const headerFooter = buildHeaderFooterOptions(context);
  return headerFooter ? { ...baseOptions, headerFooter } : baseOptions;
}

async function renderIssuedRevision(
  data: RevisionManualData,
  body: RevisionGenerateBody,
  rules: readonly StyleRule[] | undefined
): Promise<RevisionDocx> {
  const trees = data.revision.specs.map((entry) => entry.tree);
  const baseOptions = generateOptions(body.sectionNumberFormat);
  const options = await withRevisionHeaderFooter(data, baseOptions);
  const buffer = await generateManual(trees, revisionManualMeta(data), rules, options);
  return {
    buffer,
    filename: revisionManualFilename(data.project.name, data.revision.displayName),
  };
}

async function renderDefaultRevision(
  revisionId: string,
  body: RevisionGenerateBody,
  rules: readonly StyleRule[] | undefined
): Promise<RevisionDocx | null | 'empty-addendum'> {
  const data = await getPackageRevisionManualData(revisionId, pool);
  if (data === null) return null;
  if (data.revision.baseRevisionId !== null) {
    return renderAddendumRevision(revisionId, data.revision.baseRevisionId, body, rules);
  }
  return renderIssuedRevision(data, body, rules);
}

async function renderAddendumRevision(
  revisionId: string,
  baseRevisionId: string,
  body: RevisionGenerateBody,
  rules: readonly StyleRule[] | undefined
): Promise<RevisionDocx | null | 'empty-addendum'> {
  const data = await getPackageRevisionAddendumManualData(revisionId, baseRevisionId, pool);
  if (data === null) return null;
  if (data.changedSpecs.length === 0) return 'empty-addendum';
  const trees = data.changedSpecs.map((entry) => entry.tree);
  const baseOptions = generateOptions(body.sectionNumberFormat);
  const options = await withRevisionHeaderFooter(data, baseOptions);
  const buffer = await generateManual(trees, addendumManualMeta(data), rules, options);
  return {
    buffer,
    filename: revisionManualFilename(data.project.name, data.revision.displayName),
  };
}

export async function generateManualHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  const bodyResult = GenerateBodySchema.safeParse(req.body ?? {});
  if (!bodyResult.success) {
    res.status(400).json({ success: false, error: 'invalid generate request body' });
    return;
  }
  try {
    const project = await findProjectById(idResult.data, pool);
    if (!project) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    if (project.toc.length === 0) {
      res.status(422).json({ success: false, error: 'project has no sections to assemble' });
      return;
    }
    const resolution = await resolveStyleRules(bodyResult.data.templateId);
    if (!resolution.found) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    const trees = await collectSectionTrees(project.toc);
    // Request body wins; otherwise fall back to the project's stored default
    // (issue #267). findProjectById already carries section_number_format.
    const format = bodyResult.data.sectionNumberFormat ?? project.sectionNumberFormat;
    const baseOptions = generateOptions(format);
    // #481: whole-manual counterpart to generateHandler's #304 wiring — the
    // project is already resolved above (findProjectById), so there is no
    // second ownership lookup to race; headerFooter stays omitted entirely
    // when the project's client→project chain has zero configured layers.
    const headerFooterContext = await resolveProjectManualHeaderFooterContext(
      project.projectId,
      project.name,
      pool
    );
    const headerFooter = buildHeaderFooterOptions(headerFooterContext);
    const options = headerFooter ? { ...baseOptions, headerFooter } : baseOptions;
    const meta = { name: project.name, description: project.description };
    const buffer = await generateManual(trees, meta, resolution.rules, options);
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${manualFilename(project.name)}"`);
    res.send(buffer);
  } catch (err) {
    logger.error({ err }, 'manual generation failed');
    res.status(500).json({ success: false, error: 'generation failed' });
  }
}

export async function generateRevisionHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid revision id' });
    return;
  }
  const bodyResult = RevisionGenerateBodySchema.safeParse(req.body ?? {});
  if (!bodyResult.success) {
    res.status(400).json({ success: false, error: 'invalid generate request body' });
    return;
  }
  try {
    const resolution = await resolveStyleRules(bodyResult.data.templateId);
    if (!resolution.found) {
      res.status(404).json({ success: false, error: 'template not found' });
      return;
    }
    const docx =
      bodyResult.data.baseRevisionId === undefined
        ? await renderDefaultRevision(idResult.data, bodyResult.data, resolution.rules)
        : await renderAddendumRevision(
            idResult.data,
            bodyResult.data.baseRevisionId,
            bodyResult.data,
            resolution.rules
          );
    if (docx === null) {
      res.status(404).json({ success: false, error: 'revision not found' });
      return;
    }
    if (docx === 'empty-addendum') {
      res.status(422).json({ success: false, error: 'addendum has no changed sections' });
      return;
    }
    res.setHeader('Content-Type', DOCX_MIME);
    res.setHeader('Content-Disposition', `attachment; filename="${docx.filename}"`);
    res.send(docx.buffer);
  } catch (err) {
    if (err instanceof RevisionComparisonError) {
      res.status(422).json({ success: false, error: err.message });
      return;
    }
    logger.error({ err }, 'revision manual generation failed');
    res.status(500).json({ success: false, error: 'generation failed' });
  }
}
