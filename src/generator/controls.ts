import { FileChild, XmlComponent, Paragraph, StringValueElement } from 'docx';

class SdtProperties extends XmlComponent {
  constructor(uuid: string) {
    super('w:sdtPr');
    this.root.push(new StringValueElement('w:tag', `specr-uuid-${uuid}`));
  }
}

class SdtContent extends XmlComponent {
  constructor(para: Paragraph) {
    super('w:sdtContent');
    this.root.push(para);
  }
}

export class SdtBlock extends FileChild {
  constructor(para: Paragraph, uuid: string) {
    super('w:sdt');
    this.root.push(new SdtProperties(uuid));
    this.root.push(new SdtContent(para));
  }
}

export function wrapWithControl(para: Paragraph, uuid: string): SdtBlock {
  return new SdtBlock(para, uuid);
}
