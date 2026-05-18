import { describe, it, expect } from 'vitest';
import { parsePool } from './parse-pool.js';

describe('parsePool', () => {
  it('maxThreads is at least 1', () => {
    expect(parsePool.options.maxThreads).toBeGreaterThanOrEqual(1);
  });
});
