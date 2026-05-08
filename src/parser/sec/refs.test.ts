import { describe, it, expect } from 'vitest';
import { parseSec } from './index.js';

const WITH_STANDARD_REFS = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 41 00</SCN>
  <STL>AUDIO-VISUAL SYSTEMS</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>REFERENCES</TTL>
      <REF>
        <ORG>TELECOMMUNICATIONS INDUSTRY ASSOCIATION (TIA)</ORG>
        <RID>ANSI/TIA-568.1</RID>
        <RTL>(2020e) Commercial Building Telecommunications Infrastructure Standard</RTL>
        <RID>ANSI/TIA-569</RID>
        <RTL>(2019e) Telecommunications Pathways and Spaces</RTL>
      </REF>
      <REF>
        <ORG>NATIONAL FIRE PROTECTION ASSOCIATION (NFPA)</ORG>
        <RID>NFPA 70</RID>
        <RTL>(2026) National Electrical Code</RTL>
      </REF>
      <TXT>The publications listed below form a part of this specification.</TXT>
    </SPT>
  </PRT>
</SEC>`;

const WITH_SECTION_REFS = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 41 00</SCN>
  <STL>AUDIO-VISUAL SYSTEMS</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>RELATED REQUIREMENTS</TTL>
      <TXT>Section <SRF>26 20 00</SRF> INTERIOR DISTRIBUTION SYSTEM applies.</TXT>
      <LST>See <SRF>27 05 13.43</SRF> TELEVISION DISTRIBUTION SYSTEM for CATV.</LST>
    </SPT>
  </PRT>
</SEC>`;

const NO_REFS = `<?xml version="1.0" encoding="windows-1252"?>
<SEC>
  <SCN>SECTION 27 10 00</SCN>
  <STL>CABLING SYSTEM</STL>
  <PRT>
    <TTL>PART 1   GENERAL</TTL>
    <SPT>
      <TTL>DEFINITIONS</TTL>
      <TXT>Plain text with no references at all.</TXT>
    </SPT>
  </PRT>
</SEC>`;

describe('reference extraction', () => {
  describe('standard refs (REF/RID)', () => {
    it('extracts standard codes from RID elements', () => {
      const { refs } = parseSec(WITH_STANDARD_REFS);
      const codes = refs.filter((r) => r.targetType === 'standard').map((r) => r.standardCode);
      expect(codes).toContain('ANSI/TIA-568.1');
      expect(codes).toContain('ANSI/TIA-569');
      expect(codes).toContain('NFPA 70');
    });

    it('links standard refs to the article node id', () => {
      const { refs, tree } = parseSec(WITH_STANDARD_REFS);
      const articleId = tree.parts[0]?.children[0]?.id;
      const standardRefs = refs.filter((r) => r.targetType === 'standard');
      expect(standardRefs.length).toBeGreaterThan(0);
      expect(standardRefs.every((r) => r.sourceNodeId === articleId)).toBe(true);
    });

    it('returns empty refs when no REF/SRF in spec', () => {
      const { refs } = parseSec(NO_REFS);
      expect(refs).toHaveLength(0);
    });
  });

  describe('section refs (SRF)', () => {
    it('extracts section numbers from SRF in TXT', () => {
      const { refs } = parseSec(WITH_SECTION_REFS);
      const sections = refs
        .filter((r) => r.targetType === 'section')
        .map((r) => r.targetSpecSection);
      expect(sections).toContain('26 20 00');
    });

    it('extracts section numbers from SRF in LST', () => {
      const { refs } = parseSec(WITH_SECTION_REFS);
      const sections = refs
        .filter((r) => r.targetType === 'section')
        .map((r) => r.targetSpecSection);
      expect(sections).toContain('27 05 13.43');
    });

    it('links section ref to the content node containing it', () => {
      const { refs, tree } = parseSec(WITH_SECTION_REFS);
      const article = tree.parts[0]?.children[0];
      const contId = article?.children.find((c) => c.type === 'continuation')?.id;
      const pr1Id = article?.children.find((c) => c.type === 'pr1')?.id;
      const sRef1 = refs.find((r) => r.targetSpecSection === '26 20 00');
      const sRef2 = refs.find((r) => r.targetSpecSection === '27 05 13.43');
      expect(sRef1?.sourceNodeId).toBe(contId);
      expect(sRef2?.sourceNodeId).toBe(pr1Id);
    });
  });
});
