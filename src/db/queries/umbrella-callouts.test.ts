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
    expect(result.notes).toEqual(['umbrella call-out check covers all divisions in scope: 26']);
  });

  it('coordination: Div 27 subordinate citing 27 00 00 -> no umbrella_not_called_out', () => {
    const result = buildUmbrellaCalloutFindings(
      [{ specId: 'subordinate', section: '27 10 00' }],
      [{ sourceSpecId: 'subordinate', value: '27 00 00' }]
    );

    expect(result.findings).toEqual([]);
    expect(result.notes).toEqual(['umbrella call-out check covers all divisions in scope: 27']);
  });

  // X1 regression (ADR-042 supersedes ADR-037): divisions outside 26/27/28 were
  // silently skipped and merely reported. They are now checked like any other.
  it('coordination: Div 08 / 09 subordinates without umbrella citation -> flagged, not skipped', () => {
    const result = buildUmbrellaCalloutFindings(
      [
        { specId: 'doors', section: '08 11 13' },
        { specId: 'painting', section: '09 91 00' },
      ],
      []
    );

    expect(result.findings).toEqual([
      {
        type: 'umbrella_not_called_out',
        sourceSpecId: 'doors',
        sourceSpecSection: '08 11 13',
        umbrellaSpecSection: '08 00 00',
      },
      {
        type: 'umbrella_not_called_out',
        sourceSpecId: 'painting',
        sourceSpecSection: '09 91 00',
        umbrellaSpecSection: '09 00 00',
      },
    ]);
    expect(result.notes).toEqual(['umbrella call-out check covers all divisions in scope: 08, 09']);
  });

  it('coordination: the division umbrella section itself is never self-flagged', () => {
    const result = buildUmbrellaCalloutFindings([{ specId: 'umbrella', section: '08 00 00' }], []);

    expect(result.findings).toEqual([]);
    expect(result.notes).toEqual(['umbrella call-out check covers all divisions in scope: 08']);
  });

  it('coordination: empty scope -> no findings and no coverage note', () => {
    const result = buildUmbrellaCalloutFindings([], []);

    expect(result.findings).toEqual([]);
    expect(result.notes).toEqual([]);
  });
});
