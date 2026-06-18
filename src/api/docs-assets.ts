import { join } from 'node:path';

/** Directory where the vendored Scalar bundle is written (gitignored; produced by scripts/vendor-scalar.ts). */
export const SCALAR_DIR = join(process.cwd(), 'public', 'scalar');

/** Filename of the vendored Scalar standalone browser bundle. */
export const SCALAR_STANDALONE = 'standalone.js';
