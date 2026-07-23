import { z } from 'zod';
import { pool, DatabaseError } from '../index.js';
import { EditabilitySchema, ClassificationEvidenceSchema } from '../../ast/index.js';
import type { Editability, SpecNodeEditability } from '../../ast/index.js';
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
 * Derive the effective `meta.editability` from the two raw JSONB columns,
 * validating both via the closed schemas (a corrupt row is a loud DatabaseError,
 * never a silent drop). Returns undefined when the paragraph is unclassified, so
 * the field is omitted entirely (mirrors the conflicts/sourceFacts omit-when-empty
 * pattern). Effective `value` = override ?? machine; the machine's verdict stays
 * readable so a UI can show what was overridden (#134 §5).
 */
export function deriveEditability(
  classification: unknown,
  override: unknown
): SpecNodeEditability | undefined {
  // Validate the override first so a malformed payload fails loud at the DB
  // boundary even on an unclassified row — the early return must not let a
  // corrupt override slip through silently (#205 review).
  const overrideValue =
    override === null || override === undefined
      ? undefined
      : OverrideSchema.parse(override).editability;
  if (classification === null || classification === undefined) return undefined;
  const machine = ClassificationSchema.parse(classification);
  return {
    value: overrideValue ?? machine.editability,
    confidence: machine.confidence,
    evidence: machine.evidence,
    ...(overrideValue !== undefined ? { override: overrideValue } : {}),
  };
}

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
