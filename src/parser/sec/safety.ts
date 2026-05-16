import { ParserError } from '../error.js';
import { decodeTextBuffer } from '../../lib/decode-text.js';

const MAX_LINE_LENGTH = 4096;
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/;

export function assertSecSafe(buf: Buffer): string {
  const text = decodeTextBuffer(buf);
  if (text.includes('\0')) throw new ParserError('null byte in .sec file');
  if (CONTROL_CHAR_RE.test(text)) throw new ParserError('control character in .sec file');
  if (text.split('\n').some((line) => line.replace(/\r$/, '').length > MAX_LINE_LENGTH))
    throw new ParserError('line too long in .sec file');
  return text;
}
