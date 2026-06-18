import { z } from 'zod';
import { pool, DatabaseError } from '../index.js';
import { EditabilitySchema, ClassificationEvidenceSchema } from '../../ast/index.js';
import type { Editability } from '../../ast/index.js';
import type { ClassifyResult } from '../../conventions/index.js';

/**
 * Closed (`.strict()`) Zod schemas for the per-paragraph editability columns
 * (#134 / O-7). These payloads are our OWN engine output (#133), fully known —
 * not captured external data. So they REJECT malformed input, catching engine
 * drift at the DB boundary. This is a deliberate deviation from the parent
 * design's "all JSONB open/catchall" rule, which exists to preserve *unknown
 * external clues* (source_facts, convention rules) — a rationale that does not
 * apply to our own first-party output.
 */

/** `paragraphs.classification` — the machine verdict. Mirrors ParagraphClassification minus nodeId (the row id IS the nodeId). */
export const ClassificationSchema = z
  .object({
    editability: EditabilitySchema,
    confidence: z.number().min(0).max(1),
    evidence: z.array(ClassificationEvidenceSchema).check(z.minLength(1)),
  })
  .strict();

export type StoredClassification = z.infer<typeof ClassificationSchema>;

/** `paragraphs.editability_override` — the human override. */
export const OverrideSchema = z
  .object({
    editability: EditabilitySchema,
  })
  .strict();

export type StoredOverride = z.infer<typeof OverrideSchema>;

/**
 * Persist a whole-spec classification pass (ADR-022 D2). For each result,
 * `UPDATE paragraphs SET classification = $1 WHERE id = nodeId AND spec_id`.
 * NEVER touches `editability_override` → reclassify-safe by construction: the
 * machine cannot silently undo a human. Scoped by spec_id so a stray nodeId
 * can never write a sibling spec's paragraph. One transaction.
 */
export async function storeClassifications(specId: string, result: ClassifyResult): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const c of result) {
      const payload: StoredClassification = ClassificationSchema.parse({
        editability: c.editability,
        confidence: c.confidence,
        evidence: c.evidence,
      });
      await client.query(
        `UPDATE paragraphs SET classification = $1::jsonb WHERE id = $2 AND spec_id = $3`,
        [JSON.stringify(payload), c.nodeId, specId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* best-effort */
    }
    throw new DatabaseError('failed to store classifications', { cause: err });
  } finally {
    client.release();
  }
}

/** Set the human override on one paragraph — touches only `editability_override`. */
export async function setEditabilityOverride(
  paragraphId: string,
  editability: Editability
): Promise<void> {
  try {
    const payload: StoredOverride = OverrideSchema.parse({ editability });
    await pool.query(`UPDATE paragraphs SET editability_override = $1::jsonb WHERE id = $2`, [
      JSON.stringify(payload),
      paragraphId,
    ]);
  } catch (err) {
    throw new DatabaseError('failed to set editability override', { cause: err });
  }
}

/** Clear the human override → effective value falls back to the machine classification. */
export async function clearEditabilityOverride(paragraphId: string): Promise<void> {
  try {
    await pool.query(`UPDATE paragraphs SET editability_override = NULL WHERE id = $1`, [
      paragraphId,
    ]);
  } catch (err) {
    throw new DatabaseError('failed to clear editability override', { cause: err });
  }
}
