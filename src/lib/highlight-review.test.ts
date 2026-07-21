import { describe, expect, it } from 'vitest';
import type { SpecTree } from '../ast/index.js';
import { summarizeHighlightReview } from './highlight-review.js';

describe('summarizeHighlightReview', () => {
  it('surfaces first-class and legacy highlighted paragraphs without duplicating compatibility colors', () => {
    const tree: SpecTree = {
      id: 'spec',
      section: '09 91 23',
      title: 'Painting',
      parts: [
        {
          id: 'part',
          type: 'part',
          text: 'GENERAL',
          meta: {},
          children: [
            {
              id: 'direct',
              type: 'pr1',
              text: 'Select finish.',
              children: [],
              meta: {
                sourceFacts: {
                  highlights: [{ color: 'yellow', text: 'finish', span: [7, 13] }],
                  colors: [{ color: 'highlight:yellow', coverage: 6 / 14, spans: [[7, 13]] }],
                },
              },
            },
            {
              id: 'legacy',
              type: 'pr1',
              text: 'Verify product.',
              children: [],
              meta: {
                sourceFacts: {
                  colors: [{ color: 'highlight:yellow', coverage: 7 / 15, spans: [[7, 14]] }],
                },
              },
            },
          ],
        },
      ],
    };

    expect(summarizeHighlightReview(tree)).toEqual({
      total: 2,
      findings: [
        {
          nodeId: 'direct',
          nodeType: 'pr1',
          text: 'Select finish.',
          outlinePath: ['09 91 23', 'GENERAL', 'Select finish.'],
          highlights: [{ color: 'yellow', text: 'finish', span: [7, 13] }],
        },
        {
          nodeId: 'legacy',
          nodeType: 'pr1',
          text: 'Verify product.',
          outlinePath: ['09 91 23', 'GENERAL', 'Verify product.'],
          highlights: [{ color: 'yellow', text: 'product', span: [7, 14] }],
        },
      ],
    });
  });
});
