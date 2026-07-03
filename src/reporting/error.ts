import { SpecrError } from '../lib/errors.js';

/** Module-boundary error for the reporting engine. Mapped to 422 by the API
 *  error middleware / handler. */
export class ReportingError extends SpecrError {}

/** A requested source spec id is not a live `specs` row (frozen package/revision
 *  ids and unknown ids both land here). Mapped to 404. */
export class SpecNotFoundError extends ReportingError {}
