import { z } from 'zod';

// ── Hierarchy-inference provenance & confidence (ADR-055) ────────────────────

export const SignalNumberSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

// Persisted provenance wire shape (ADR-055). CLOSED (.strict()): this is our own
// engine output — a malformed row is drift and must fail loud at the boundary.
export const SignalProvenanceSchema = z
  .object({
    signalUsed: SignalNumberSchema,
    agreed: z.array(SignalNumberSchema),
  })
  .strict();

export const SpecNodeInferenceSchema = z.object({
  confidence: z.number().min(0).max(1),
  signalUsed: SignalNumberSchema,
  agreed: z.array(SignalNumberSchema),
  evidence: z.array(z.string()),
});
