import { SpecrError } from '../lib/errors.js';
import type { SpecrErrorOptions } from '../lib/errors.js';

export type ParserErrorCode =
  | 'DOCX_ARCHIVE_UNREADABLE'
  | 'DOCX_MISSING_DOCUMENT'
  | 'DOCX_NO_PARAGRAPHS'
  | 'NUMBERING_XML_INVALID'
  | 'STYLES_XML_INVALID'
  | 'SEC_XML_INVALID'
  | 'PDF_TEXT_LAYER_UNEXTRACTABLE'
  | 'UNSUPPORTED_FORMAT';

export interface ParserErrorOptions extends SpecrErrorOptions {
  readonly code?: ParserErrorCode;
}

export class ParserError extends SpecrError {
  override readonly code?: ParserErrorCode = undefined;
  constructor(message: string, options?: ParserErrorOptions) {
    super(message, options);
    if (options?.code !== undefined) this.code = options.code;
  }
}
