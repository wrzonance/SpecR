import { describe, expect, it } from 'vitest';
import type { SpecTree } from '../ast/index.js';
import { summarizeManualEmphasis } from './manual-emphasis-report.js';

describe('summarizeManualEmphasis', () => {
  it('returns paragraph locators and captured run deviations as advisory findings', () => {
    const tree: SpecTree = {
      id: 'spec',
      section: '09 91 23',
      title: 'Painting',
      parts: [
        {
          id: 'node',
          type: 'pr1',
          text: 'Use coating.',
          children: [],
          meta: {
            sourceFacts: {
              emphasis: [
                {
                  property: 'bold',
                  value: true,
                  expected: false,
                  text: 'coating',
                  span: [4, 11],
                },
              ],
            },
          },
        },
      ],
    };

    expect(summarizeManualEmphasis(tree)).toEqual({
      total: 1,
      findings: [
        {
          nodeId: 'node',
          nodeType: 'pr1',
          text: 'Use coating.',
          emphasis: [
            {
              property: 'bold',
              value: true,
              expected: false,
              text: 'coating',
              span: [4, 11],
            },
          ],
        },
      ],
    });
  });
});
