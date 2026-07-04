import type { Request, Response } from 'express';
import { z } from 'zod';
import { findProjectById, getProjectKeynotes, pool } from '../db/index.js';
import type { ProjectKeynote } from '../db/index.js';
import { logger } from '../lib/logger.js';

// The Revit keynote table is a flat, tab-delimited text file consumed by BIM
// authoring tools (ADR-016 D3). Only three columns render: code, description,
// parent code — the rest of ProjectKeynote carries the master's identity for
// other consumers (the MCP tool returns the whole structured row).
type KeynoteTableRow = Pick<ProjectKeynote, 'code' | 'description' | 'parentCode'>;

const KEYNOTE_MIME = 'text/plain; charset=utf-8';
const FIELD_SEP = '\t';

// A tab or newline inside a field is the table's own row/column grammar, so any
// that leak in from free-text content are collapsed to a single space — one
// keynote must stay one line of fixed columns for Revit to parse it.
function sanitizeField(value: string): string {
  return value.replace(/[\t\r\n]+/g, ' ');
}

function renderRow(keynote: KeynoteTableRow): string {
  const code = sanitizeField(keynote.code);
  const description = sanitizeField(keynote.description);
  // parent_code carries no non-empty DB constraint, so a stored '' (or whitespace)
  // is treated as top-level — a dangling third column would read as a zero-length
  // parent key in Revit. Top-level rows are two columns; children carry the parent.
  const parent = keynote.parentCode === null ? '' : sanitizeField(keynote.parentCode).trim();
  const fields = parent === '' ? [code, description] : [code, description, parent];
  return `${fields.join(FIELD_SEP)}\n`;
}

/**
 * Pure rendering of the project-filtered keynote query into the Revit keynote
 * table format. Order-preserving: getProjectKeynotes already sorts by code, so
 * the same project yields byte-identical output every run. An empty set renders
 * an empty body (a valid keynote file with zero entries).
 */
export function renderKeynoteTable(keynotes: readonly KeynoteTableRow[]): string {
  return keynotes.map(renderRow).join('');
}

// Suggested download filename, mirroring generate.ts's DOCX filename hygiene.
export function keynotesFilename(projectName: string): string {
  const base =
    projectName
      .replace(/[^a-zA-Z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80)
      .replace(/^-|-$/g, '') || 'project';
  return `${base}-keynotes.txt`;
}

/** GET /projects/:id/keynotes — tab-delimited Revit keynote table (ADR-016 D3). */
export async function getProjectKeynotesHandler(req: Request, res: Response): Promise<void> {
  const idResult = z.uuid().safeParse(req.params['id']);
  if (!idResult.success) {
    res.status(400).json({ success: false, error: 'invalid project id' });
    return;
  }
  try {
    const project = await findProjectById(idResult.data, pool);
    if (!project) {
      res.status(404).json({ success: false, error: 'project not found' });
      return;
    }
    const keynotes = await getProjectKeynotes(idResult.data);
    res.setHeader('Content-Type', KEYNOTE_MIME);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${keynotesFilename(project.name)}"`
    );
    res.send(renderKeynoteTable(keynotes));
  } catch (err) {
    logger.error({ err }, 'project keynote export failed');
    res.status(500).json({ success: false, error: 'keynote export failed' });
  }
}
