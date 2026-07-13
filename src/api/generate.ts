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
  findSoleProjectSectionNumberFormat,
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
import type { ManualMeta, ManualSectionListing } from '../generator/index.js';
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
    // Request body wins; otherwise fall back to the format of the spec's sole
    // owning project (issue #267). Null (orphan or multi-project) → canonical.
    const format =
      bodyResult.data.sectionNumberFormat ??
      (await findSoleProjectSectionNumberFormat(idResult.data, pool)) ??
      undefined;
    // Same sole-owning-project scope resolves the header/footer to render
    // (issue #304); omitted entirely when nothing applies, so an orphan or
    // unconfigured spec's output stays byte-identical to the pre-#304
    // baseline (buildHeaderFooterOptions's undefined gate).
    const headerFooter = await buildHeaderFooterOptions(idResult.data, pool);
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

async function renderIssuedRevision(
  revisionId: string,
  body: RevisionGenerateBody,
  rules: readonly StyleRule[] | undefined
): Promise<RevisionDocx | null> {
  const data = await getPackageRevisionManualData(revisionId, pool);
  if (data === null) return null;
  const trees = data.revision.specs.map((entry) => entry.tree);
  const options = generateOptions(body.sectionNumberFormat);
  const buffer = await generateManual(trees, revisionManualMeta(data), rules, options);
  return {
    buffer,
    filename: revisionManualFilename(data.project.name, data.revision.displayName),
  };
}

async function renderAddendumRevision(
  revisionId: string,
  body: RevisionGenerateBody,
  rules: readonly StyleRule[] | undefined
): Promise<RevisionDocx | null | 'empty-addendum'> {
  if (body.baseRevisionId === undefined) return null;
  const data = await getPackageRevisionAddendumManualData(revisionId, body.baseRevisionId, pool);
  if (data === null) return null;
  if (data.changedSpecs.length === 0) return 'empty-addendum';
  const trees = data.changedSpecs.map((entry) => entry.tree);
  const options = generateOptions(body.sectionNumberFormat);
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
    const options = generateOptions(format);
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
        ? await renderIssuedRevision(idResult.data, bodyResult.data, resolution.rules)
        : await renderAddendumRevision(idResult.data, bodyResult.data, resolution.rules);
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
