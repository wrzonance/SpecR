import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import { router } from './router.js'
import { errorHandler } from './middleware/error.js'

let server: Server
let baseUrl: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use(router)
  app.use(errorHandler)

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve())
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 3000
  baseUrl = `http://localhost:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
})

describe('GET /health (integration)', () => {
  it('returns 200 with db: connected when PostgreSQL is reachable', async () => {
    const res = await fetch(`${baseUrl}/health`)
    const body = (await res.json()) as Record<string, unknown>

    expect(res.status).toBe(200)
    expect(body['success']).toBe(true)
    expect((body['data'] as Record<string, unknown>)['db']).toBe('connected')
    expect(typeof (body['data'] as Record<string, unknown>)['uptime']).toBe('number')
  })

  it('response shape matches ApiResponse contract', async () => {
    const res = await fetch(`${baseUrl}/health`)
    const body = (await res.json()) as Record<string, unknown>

    expect(typeof body['success']).toBe('boolean')
    expect('data' in body || 'error' in body).toBe(true)
  })
})
