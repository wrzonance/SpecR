import path from 'node:path';
import { z } from 'zod';
import type { Request, Response } from 'express';
import {
  listNumberingProfiles,
  getNumberingProfile,
  createNumberingProfile,
  updateNumberingProfile,
  deleteNumberingProfile,
  setSpecNumberingProfile,
  clearSpecNumberingProfile,
  findLibraryById,
  NumberingProfileInUseError,
} from '../db/index.js';
import type {
  CreateNumberingProfileBody,
  PatchNumberingProfileBody,
  SetSpecNumberingProfileBody,
} from '../ast/index.js';
import { assertDocxSafe, extractNumberingProfileFromDocx } from '../parser/index.js';
import { logger } from '../lib/logger.js';
import { getPgCode } from '../lib/pg-errors.js';

const UUID_SCHEMA = z.uuid();
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function parseUuid(req: Request, res: Response, label: string): string | null {
  const result = UUID_SCHEMA.safeParse(req.params['id']);
  if (!result.success) {
    res.status(400).json({ success: false, error: `invalid ${label} id` });
    return null;
  }
  return result.data;
}

// Guard the mutating endpoints (PATCH/DELETE). The built-in CSI Default
// (library_id IS NULL) is immutable: getEffectiveNumberingProfile falls back to
// it for every unassigned spec, so editing or deleting it would corrupt that
// global default. Returns true (and sends 404/409) when the request must stop.
async function rejectMissingOrBuiltIn(
  id: string,
  res: Response,
  action: 'modified' | 'deleted'
): Promise<boolean> {
  const existing = await getNumberingProfile(id);
  if (existing === null) {
    res.status(404).json({ success: false, error: 'numbering profile not found' });
    return true;
  }
  if (existing.libraryId === null) {
    res.status(409).json({
      success: false,
      error: `the built-in CSI Default numbering profile cannot be ${action}`,
    });
    return true;
  }
  return false;
}

export async function listProfilesHandler(req: Request, res: Response): Promise<void> {
  const libraryId = parseUuid(req, res, 'library');
  if (!libraryId) return;
  try {
    // Verify the parent library exists first — listNumberingProfiles matches the
    // built-in CSI Default (library_id IS NULL) regardless, so a typo/deleted
    // library UUID would otherwise return 200 with just the built-in. (#320)
    const library = await findLibraryById(libraryId);
    if (!library) {
      res.status(404).json({ success: false, error: 'library not found' });
      return;
    }
    const profiles = await listNumberingProfiles(libraryId);
    res.status(200).json({ success: true, data: profiles });
  } catch (err) {
    logger.error({ err }, 'list numbering profiles failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function createProfileHandler(req: Request, res: Response): Promise<void> {
  const libraryId = parseUuid(req, res, 'library');
  if (!libraryId) return;
  const { name, rules } = req.body as CreateNumberingProfileBody;
  try {
    const profile = await createNumberingProfile(libraryId, name, rules);
    res.status(201).json({ success: true, data: profile });
  } catch (err) {
    if (getPgCode(err) === '23503') {
      res.status(404).json({ success: false, error: 'library not found' });
      return;
    }
    logger.error({ err }, 'create numbering profile failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function getProfileHandler(req: Request, res: Response): Promise<void> {
  const id = parseUuid(req, res, 'numbering profile');
  if (!id) return;
  try {
    const profile = await getNumberingProfile(id);
    if (!profile) {
      res.status(404).json({ success: false, error: 'numbering profile not found' });
      return;
    }
    res.status(200).json({ success: true, data: profile });
  } catch (err) {
    logger.error({ err }, 'get numbering profile failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function patchProfileHandler(req: Request, res: Response): Promise<void> {
  const id = parseUuid(req, res, 'numbering profile');
  if (!id) return;
  const patch = req.body as PatchNumberingProfileBody;
  try {
    if (await rejectMissingOrBuiltIn(id, res, 'modified')) return;
    const profile = await updateNumberingProfile(id, patch);
    if (!profile) {
      res.status(404).json({ success: false, error: 'numbering profile not found' });
      return;
    }
    res.status(200).json({ success: true, data: profile });
  } catch (err) {
    logger.error({ err }, 'patch numbering profile failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function deleteProfileHandler(req: Request, res: Response): Promise<void> {
  const id = parseUuid(req, res, 'numbering profile');
  if (!id) return;
  try {
    if (await rejectMissingOrBuiltIn(id, res, 'deleted')) return;
    const deleted = await deleteNumberingProfile(id);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'numbering profile not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    if (err instanceof NumberingProfileInUseError) {
      res
        .status(409)
        .json({ success: false, error: 'numbering profile is in use by one or more specs' });
      return;
    }
    logger.error({ err }, 'delete numbering profile failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function setSpecProfileHandler(req: Request, res: Response): Promise<void> {
  const specId = parseUuid(req, res, 'spec');
  if (!specId) return;
  const { profileId } = req.body as SetSpecNumberingProfileBody;
  try {
    const profile = await getNumberingProfile(profileId);
    if (!profile) {
      res.status(404).json({ success: false, error: 'numbering profile not found' });
      return;
    }
    const outcome = await setSpecNumberingProfile(specId, profileId);
    if (outcome === 'spec-not-found') {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    if (outcome === 'profile-not-found') {
      // Race: the profile was deleted between the pre-check above and the UPDATE
      // (#366). Report the same clean 404 as the pre-check, not a 409 scope error.
      res.status(404).json({ success: false, error: 'numbering profile not found' });
      return;
    }
    if (outcome === 'library-mismatch') {
      res.status(409).json({
        success: false,
        error: 'numbering profile belongs to a different library than the spec',
      });
      return;
    }
    res.status(200).json({ success: true, data: { profileId, name: profile.name } });
  } catch (err) {
    // Backstop for the same delete race in its ultra-narrow window: the EXISTS
    // subquery (statement snapshot) still sees the profile but the RI FK trigger's
    // up-to-date check finds it concurrently deleted → 23503. Map that to the same
    // 404 rather than leaking a 500. The common race is handled by
    // 'profile-not-found' above (#366) — mirrors the style-source assign backstop.
    if (getPgCode(err) === '23503') {
      res.status(404).json({ success: false, error: 'numbering profile not found' });
      return;
    }
    logger.error({ err }, 'set spec numbering profile failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function clearSpecProfileHandler(req: Request, res: Response): Promise<void> {
  const specId = parseUuid(req, res, 'spec');
  if (!specId) return;
  try {
    const cleared = await clearSpecNumberingProfile(specId);
    if (!cleared) {
      res.status(404).json({ success: false, error: 'spec not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    logger.error({ err }, 'clear spec numbering profile failed');
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

export async function snapshotHandler(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ success: false, error: 'file required' });
    return;
  }
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (ext !== '.docx') {
    res.status(400).json({ success: false, error: 'only .docx files are accepted' });
    return;
  }
  // Accept the canonical DOCX type, an empty type, or the generic
  // application/octet-stream many clients send for file parts. The extension check
  // above and assertDocxSafe(buffer) below are the real validation; a strict
  // equality only adds false negatives for legitimate .docx uploads.
  const mimetype = req.file.mimetype;
  if (mimetype && mimetype !== DOCX_MIME && mimetype !== 'application/octet-stream') {
    res.status(400).json({ success: false, error: 'MIME type mismatch for .docx' });
    return;
  }
  const { buffer } = req.file;
  try {
    await assertDocxSafe(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid DOCX file';
    res.status(400).json({ success: false, error: msg });
    return;
  }
  try {
    const profile = await extractNumberingProfileFromDocx(buffer);
    res.status(200).json({ success: true, data: profile });
  } catch (err) {
    logger.error({ err }, 'snapshot numbering profile failed');
    res
      .status(422)
      .json({ success: false, error: 'failed to extract numbering profile from DOCX' });
  }
}
