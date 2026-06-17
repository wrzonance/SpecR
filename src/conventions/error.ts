import { SpecrError } from '../lib/errors.js';

/**
 * Module-boundary error for the conventions/classification engine. Extends the
 * shared SpecrError so the API error middleware can map it (ADR-022 §6 →
 * `ConventionError` → 422). The classification engine itself is pure and does
 * not throw in normal operation; this exists for the boundary contract and for
 * callers that wrap genuinely exceptional input.
 */
export class ConventionError extends SpecrError {}
