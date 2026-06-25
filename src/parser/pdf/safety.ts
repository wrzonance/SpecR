import { ParserError } from '../error.js';

const PDF_MAGIC = Buffer.from('%PDF-', 'utf-8');
const MAX_PDF_BYTES = 10 * 1024 * 1024;

export function assertPdfSafe(buffer: Buffer): void {
  if (buffer.length > MAX_PDF_BYTES) {
    throw new ParserError('PDF exceeds 10 MB safety limit');
  }
  if (!buffer.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new ParserError('invalid PDF: missing %PDF- signature');
  }
}
