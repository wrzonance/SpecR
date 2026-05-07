import { describe, it, expect, beforeAll } from 'vitest'

describe('logger', () => {
  beforeAll(() => {
    process.env['NODE_ENV'] = 'test'
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test'
    process.env['LOG_LEVEL'] = 'debug'
  })

  it('has info, error, debug, and warn methods', async () => {
    const { logger } = await import('./logger.js')

    expect(typeof logger.info).toBe('function')
    expect(typeof logger.error).toBe('function')
    expect(typeof logger.debug).toBe('function')
    expect(typeof logger.warn).toBe('function')
  })

  it('logger.level equals config.LOG_LEVEL', async () => {
    const { logger } = await import('./logger.js')
    const { config } = await import('./env.js')

    expect(logger.level).toBe(config.LOG_LEVEL)
  })
})
