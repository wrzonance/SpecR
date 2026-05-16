import * as chardet from 'chardet';
import * as iconv from 'iconv-lite';

export function decodeTextBuffer(buf: Buffer): string {
  const encoding = chardet.detect(buf) ?? 'utf-8';
  return iconv.decode(buf, encoding);
}
