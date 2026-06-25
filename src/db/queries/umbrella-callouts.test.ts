import { describe, expect, it } from 'vitest';
import { buildUmbrellaCalloutFindings } from './umbrella-callouts.js';

describe('buildUmbrellaCalloutFindings', () => {
  it('coordination: Div 26 subordinate without 26 00 00 citation -> umbrella_not_called_out', () => {
    const result = buildUmbrellaCalloutFindings(
      [{ specId: 'subordinate', section: '26 05 33' }],
      []
    );

    expect(result.findings).toEqual([
      {
        type: 'umbrella_not_called_out',
        sourceSpecId: 'subordinate',
        sourceSpecSection: '26 05 33',
        umbrellaSpecSection: '26 00 00',
      },
    ]);
    expect(result.notes).toEqual([]);
  });

  it('coordination: Div 27 subordinate citing 27 00 00 -> no umbrella_not_called_out', () => {
    const result = buildUmbrellaCalloutFindings(
      [{ specId: 'subordinate', section: '27 10 00' }],
      [{ sourceSpecId: 'subordinate', value: '27 00 00' }]
    );

    expect(result.findings).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it('coordination: unsupported divisions are skipped and reported, not flagged', () => {
    const result = buildUmbrellaCalloutFindings(
      [
        { specId: 'doors', section: '08 11 13' },
        { specId: 'painting', section: '09 91 00' },
      ],
      []
    );

    expect(result.findings).toEqual([]);
    expect(result.notes).toEqual([
      'umbrella call-out check covers only divisions 26, 27, 28; skipped divisions: 08, 09',
    ]);
  });
});
