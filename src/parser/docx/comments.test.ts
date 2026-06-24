import { describe, expect, it } from 'vitest';
import { parseCommentsXml } from './comments.js';

const NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function commentsDoc(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<w:comments xmlns:w="${NS}">${body}</w:comments>`;
}

describe('parseCommentsXml — strike capture (#262)', () => {
  it('flags a comment whose only run is struck through as struck', () => {
    const xml = commentsDoc(
      `<w:comment w:id="0" w:author="Jane">
        <w:p><w:r><w:rPr><w:strike/></w:rPr><w:t>Resolved upstream.</w:t></w:r></w:p>
      </w:comment>`
    );
    const comment = parseCommentsXml(xml).get('0');
    expect(comment).toEqual({ author: 'Jane', text: 'Resolved upstream.', struck: true });
  });

  it('flags a comment as struck when only some of its runs are struck', () => {
    const xml = commentsDoc(
      `<w:comment w:id="0" w:author="Jane">
        <w:p><w:r><w:t>See </w:t></w:r><w:r><w:rPr><w:strike/></w:rPr><w:t>note.</w:t></w:r></w:p>
      </w:comment>`
    );
    const comment = parseCommentsXml(xml).get('0');
    expect(comment?.struck).toBe(true);
    expect(comment?.text).toBe('See note.');
  });

  it('does not flag a comment with no struck runs', () => {
    const xml = commentsDoc(
      `<w:comment w:id="0" w:author="Jane">
        <w:p><w:r><w:t>Coordinate with owner.</w:t></w:r></w:p>
      </w:comment>`
    );
    const comment = parseCommentsXml(xml).get('0');
    expect(comment).toEqual({ author: 'Jane', text: 'Coordinate with owner.', struck: false });
  });

  it('treats w:strike with val="0"/"false"/"off" as not struck (OOXML toggle off)', () => {
    for (const off of ['0', 'false', 'off']) {
      const xml = commentsDoc(
        `<w:comment w:id="0" w:author="Jane">
          <w:p><w:r><w:rPr><w:strike w:val="${off}"/></w:rPr><w:t>Open.</w:t></w:r></w:p>
        </w:comment>`
      );
      expect(parseCommentsXml(xml).get('0')?.struck).toBe(false);
    }
  });
});
