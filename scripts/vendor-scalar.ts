import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCALAR_DIR, SCALAR_STANDALONE } from '../src/api/docs-assets.js'

// Pinned Scalar standalone bundle. To bump: change VERSION, run `pnpm vendor:scalar`
// (it will fail the integrity check and print the new sha256), paste that sha256 here,
// then verify the reference still renders at /docs.
const VERSION = '1.59.3'
const SHA256 = '3ad38e0813eec10c4a5ece08121d582836f59493bf21fbe9a1ba75ebd698582c'
const BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${VERSION}/dist/browser/standalone.js`

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function vendor(): Promise<void> {
  const out = join(SCALAR_DIR, SCALAR_STANDALONE)
  if (existsSync(out) && sha256(readFileSync(out)) === SHA256) {
    console.log(`Scalar ${VERSION} already vendored (sha256 ok) → ${out}`)
    return
  }
  const res = await fetch(BUNDLE_URL)
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText} (${BUNDLE_URL})`)
  const bytes = Buffer.from(await res.arrayBuffer())
  const actual = sha256(bytes)
  if (actual !== SHA256) {
    throw new Error(`Scalar ${VERSION} integrity check failed: expected ${SHA256}, got ${actual}`)
  }
  mkdirSync(SCALAR_DIR, { recursive: true })
  writeFileSync(out, bytes)
  console.log(`vendored Scalar ${VERSION} → ${out} (sha256 verified, ${bytes.length} bytes)`)
}

vendor().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
