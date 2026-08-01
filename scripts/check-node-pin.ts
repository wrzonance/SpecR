/**
 * Node-pin drift gate.
 *
 * The repo pins a single Node LTS major (ADR-081). That target is declared in
 * several places which have no automatic relationship to each other, so they
 * silently drift apart — before this check existed, CI ran Node 22 while a
 * developer machine ran Node 26 and nothing complained, because `engines.node`
 * was the open-ended `>=22.17.0`.
 *
 * This asserts every declaration names the same major, that the range is
 * bounded (an open-ended `>=N` admits the next major and defeats the pin), and
 * that the interpreter actually executing is that major.
 *
 * Run by `pnpm check:node-pin`, in CI and locally.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/** One declaration of the Node target, and where a human can go fix it. */
interface Declaration {
  readonly source: string
  readonly major: number
}

class NodePinError extends Error {}

const readJson = (relativePath: string): Record<string, unknown> => {
  const absolute = join(ROOT, relativePath)
  try {
    return JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>
  } catch (err) {
    throw new NodePinError(`could not read ${relativePath}`, { cause: err })
  }
}

/**
 * Pull the major out of an `engines.node` range, requiring it to be bounded.
 *
 * `>=24 <25` and `^24` pin major 24. A bare `>=24` does not — Node 26 satisfies
 * it — so it is rejected outright rather than parsed.
 */
const majorFromEngineRange = (range: string, source: string): number => {
  const caret = /^\^(\d+)/.exec(range)
  if (caret?.[1] !== undefined) return Number(caret[1])

  const lower = /^>=\s*(\d+)/.exec(range)
  const upper = /<\s*(\d+)/.exec(range)
  if (lower?.[1] === undefined) {
    throw new NodePinError(`${source}: cannot parse engines.node range "${range}"`)
  }
  if (upper?.[1] === undefined) {
    throw new NodePinError(
      `${source}: engines.node "${range}" is open-ended — it admits the next major and does not pin. ` +
        `Use a bounded range such as ">=${lower[1]} <${Number(lower[1]) + 1}".`,
    )
  }
  if (Number(upper[1]) !== Number(lower[1]) + 1) {
    throw new NodePinError(
      `${source}: engines.node "${range}" spans more than one major; pin exactly one.`,
    )
  }
  return Number(lower[1])
}

const enginesDeclaration = (manifestPath: string): Declaration => {
  const manifest = readJson(manifestPath)
  const engines = manifest['engines']
  if (typeof engines !== 'object' || engines === null) {
    throw new NodePinError(`${manifestPath}: no "engines" block`)
  }
  const node = (engines as Record<string, unknown>)['node']
  if (typeof node !== 'string') {
    throw new NodePinError(`${manifestPath}: no "engines.node" string`)
  }
  return { source: `${manifestPath} engines.node`, major: majorFromEngineRange(node, manifestPath) }
}

/** `@types/node` must track the runtime major, or tsc validates against the wrong API surface. */
const typesNodeDeclaration = (manifestPath: string): Declaration => {
  const manifest = readJson(manifestPath)
  const devDeps = manifest['devDependencies']
  const spec =
    typeof devDeps === 'object' && devDeps !== null
      ? (devDeps as Record<string, unknown>)['@types/node']
      : undefined
  if (typeof spec !== 'string') {
    throw new NodePinError(`${manifestPath}: no "@types/node" devDependency`)
  }
  const major = /(\d+)/.exec(spec)?.[1]
  if (major === undefined) {
    throw new NodePinError(`${manifestPath}: cannot parse @types/node "${spec}"`)
  }
  return { source: `${manifestPath} @types/node`, major: Number(major) }
}

const nvmrcDeclaration = (): Declaration => {
  let raw: string
  try {
    raw = readFileSync(join(ROOT, '.nvmrc'), 'utf8')
  } catch (err) {
    throw new NodePinError('could not read .nvmrc', { cause: err })
  }
  const major = /^v?(\d+)/.exec(raw.trim())?.[1]
  if (major === undefined) {
    throw new NodePinError(`.nvmrc: cannot parse "${raw.trim()}"`)
  }
  return { source: '.nvmrc', major: Number(major) }
}

const collect = (): readonly Declaration[] => [
  nvmrcDeclaration(),
  enginesDeclaration('package.json'),
  enginesDeclaration('tools/verify/package.json'),
  typesNodeDeclaration('package.json'),
  typesNodeDeclaration('tools/verify/package.json'),
]

const main = (): void => {
  let declarations: readonly Declaration[]
  try {
    declarations = collect()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`✗ Node pin check failed: ${message}`)
    process.exit(1)
  }

  const target = declarations[0]?.major
  if (target === undefined) {
    console.error('✗ Node pin check failed: no declarations found')
    process.exit(1)
  }

  const mismatched = declarations.filter((d) => d.major !== target)
  const runtimeMajor = Number(process.versions.node.split('.')[0])

  if (mismatched.length > 0) {
    console.error(`✗ Node pin drift — .nvmrc says ${target}, but:`)
    for (const d of mismatched) console.error(`    ${d.source} says ${d.major}`)
    console.error('  Every declaration must name the same Node major.')
    process.exit(1)
  }

  if (runtimeMajor !== target) {
    console.error(
      `✗ Node pin drift — the repo targets Node ${target}, but this process is Node ${process.versions.node}.\n` +
        `  Install Node ${target} (a version manager will read .nvmrc: \`nvm use\`, \`fnm use\`, \`mise install\`).`,
    )
    process.exit(1)
  }

  console.log(
    `✓ Node pin consistent: Node ${target} across ${declarations.length} declarations and the running runtime (${process.versions.node}).`,
  )
}

main()
