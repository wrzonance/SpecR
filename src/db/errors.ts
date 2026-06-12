import { SpecrError } from '../lib/errors.js';

/** Database-layer error base class. Wrap raw pg errors exactly once with
 *  `{ cause: err }` so `getPgCode` (which walks one cause level) can find the
 *  pg error code. Sub-classes may be thrown for domain-specific conditions. */
export class DatabaseError extends SpecrError {}
