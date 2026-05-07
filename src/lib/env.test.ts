import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('env validation', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetModules()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('returns typed config with correct values when env is valid', async () => {
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test'
    process.env['NODE_ENV'] = 'test'
    process.env['PORT'] = '4000'
    process.env['LOG_LEVEL'] = 'debug'

    const { config } = await import('./env.js')

    expect(config.DATABASE_URL).toBe('postgres://test:test@localhost:5432/test')
    expect(config.NODE_ENV).toBe('test')
    expect(config.PORT).toBe(4000)
    expect(typeof config.PORT).toBe('number')
    expect(config.LOG_LEVEL).toBe('debug')
  })

  it('defaults PORT to 3000 when not set', async () => {
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test'
    process.env['NODE_ENV'] = 'test'
    delete process.env['PORT']

    const { config } = await import('./env.js')

    expect(config.PORT).toBe(3000)
  })

  it('defaults LOG_LEVEL to info when not set', async () => {
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test'
    process.env['NODE_ENV'] = 'test'
    delete process.env['LOG_LEVEL']

    const { config } = await import('./env.js')

    expect(config.LOG_LEVEL).toBe('info')
  })

  it('coerces PORT string "4000" to number 4000', async () => {
    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test'
    process.env['NODE_ENV'] = 'test'
    process.env['PORT'] = '4000'

    const { config } = await import('./env.js')

    expect(config.PORT).toBe(4000)
    expect(typeof config.PORT).toBe('number')
  })

  it('exits with code 1 when DATABASE_URL is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)

    process.env['DATABASE_URL'] = ''
    process.env['NODE_ENV'] = 'test'

    await expect(import('./env.js')).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  it('exits with code 1 when NODE_ENV is missing', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)

    process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test'
    delete process.env['NODE_ENV']

    await expect(import('./env.js')).rejects.toThrow()
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })
})
