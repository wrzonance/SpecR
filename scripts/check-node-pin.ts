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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');

/** One declaration of the Node target, and where a human can go fix it. */
interface Declaration {
  readonly source: string;
  readonly major: number;
}

export class NodePinError extends Error {}

const readJson = (relativePath: string): Record<string, unknown> => {
  const absolute = join(ROOT, relativePath);
  try {
    return JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new NodePinError(`could not read ${relativePath}`, { cause: err });
  }
};

/**
 * Pull the major out of an `engines.node` range, requiring it to pin exactly one.
 *
 * Only two canonical spellings are accepted — `^N` and `>=N <N+1` (either side
 * may carry minor/patch, and the upper bound may be written `<N+1.0`/`<N+1.0.0`).
 * Anything else is rejected with a message naming the actual problem.
 *
 * The strictness is deliberate. This gate exists because an under-constrained
 * range silently admits the next major, so it fails closed: a range it cannot
 * prove pins one major is an error, never a pass. Notably rejected:
 *
 *  - `>=24`            open-ended; Node 26 satisfies it
 *  - `^24 || ^27`      union; the caret prefix looks fine but Node 27 satisfies it
 *  - `>=24 <25.5`      upper bound reaches into major 25
 */
export const majorFromEngineRange = (range: string, source: string): number => {
  const trimmed = range.trim();

  // Check unions first: "^24 || ^27" starts with a valid-looking caret but is
  // satisfied by Node 27, so prefix-matching alone would pass it.
  if (trimmed.includes('||')) {
    throw new NodePinError(
      `${source}: engines.node "${range}" is a union range — it admits majors outside the pin. ` +
        `Pin exactly one major.`
    );
  }

  const caret = /^\^(\d+)(?:\.\d+){0,2}$/.exec(trimmed);
  if (caret?.[1] !== undefined) return Number(caret[1]);

  const bounded = /^>=\s*(\d+)(?:\.\d+){0,2}\s+<\s*(\d+)(?:\.0(?:\.0)?)?$/.exec(trimmed);
  if (bounded?.[1] !== undefined && bounded[2] !== undefined) {
    const lower = Number(bounded[1]);
    const upper = Number(bounded[2]);
    if (upper !== lower + 1) {
      throw new NodePinError(
        `${source}: engines.node "${range}" bounds ${lower} with <${upper}; ` +
          `a single-major pin ends at <${lower + 1}.`
      );
    }
    return lower;
  }

  // Not canonical — say specifically why rather than "cannot parse".
  if (!/<|\^/.test(trimmed)) {
    throw new NodePinError(
      `${source}: engines.node "${range}" is open-ended — it admits the next major and does not pin. ` +
        `Use a bounded range such as ">=24 <25".`
    );
  }
  throw new NodePinError(
    `${source}: engines.node "${range}" is not a recognized single-major pin. ` +
      `Use "^N" or ">=N <N+1" (the upper bound must be the bare next major).`
  );
};

const enginesDeclaration = (manifestPath: string): Declaration => {
  const manifest = readJson(manifestPath);
  const engines = manifest['engines'];
  if (typeof engines !== 'object' || engines === null) {
    throw new NodePinError(`${manifestPath}: no "engines" block`);
  }
  const node = (engines as Record<string, unknown>)['node'];
  if (typeof node !== 'string') {
    throw new NodePinError(`${manifestPath}: no "engines.node" string`);
  }
  return {
    source: `${manifestPath} engines.node`,
    major: majorFromEngineRange(node, manifestPath),
  };
};

/** `@types/node` must track the runtime major, or tsc validates against the wrong API surface. */
const typesNodeDeclaration = (manifestPath: string): Declaration => {
  const manifest = readJson(manifestPath);
  const devDeps = manifest['devDependencies'];
  const spec =
    typeof devDeps === 'object' && devDeps !== null
      ? (devDeps as Record<string, unknown>)['@types/node']
      : undefined;
  if (typeof spec !== 'string') {
    throw new NodePinError(`${manifestPath}: no "@types/node" devDependency`);
  }
  const major = /(\d+)/.exec(spec)?.[1];
  if (major === undefined) {
    throw new NodePinError(`${manifestPath}: cannot parse @types/node "${spec}"`);
  }
  return { source: `${manifestPath} @types/node`, major: Number(major) };
};

const nvmrcDeclaration = (): Declaration => {
  let raw: string;
  try {
    raw = readFileSync(join(ROOT, '.nvmrc'), 'utf8');
  } catch (err) {
    throw new NodePinError('could not read .nvmrc', { cause: err });
  }
  const major = /^v?(\d+)/.exec(raw.trim())?.[1];
  if (major === undefined) {
    throw new NodePinError(`.nvmrc: cannot parse "${raw.trim()}"`);
  }
  return { source: '.nvmrc', major: Number(major) };
};

const collect = (): readonly Declaration[] => [
  nvmrcDeclaration(),
  enginesDeclaration('package.json'),
  enginesDeclaration('tools/verify/package.json'),
  typesNodeDeclaration('package.json'),
  typesNodeDeclaration('tools/verify/package.json'),
];

const main = (): void => {
  let declarations: readonly Declaration[];
  try {
    declarations = collect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`✗ Node pin check failed: ${message}`);
    process.exit(1);
  }

  const target = declarations[0]?.major;
  if (target === undefined) {
    console.error('✗ Node pin check failed: no declarations found');
    process.exit(1);
  }

  const mismatched = declarations.filter((d) => d.major !== target);
  const runtimeMajor = Number(process.versions.node.split('.')[0]);

  if (mismatched.length > 0) {
    console.error(`✗ Node pin drift — .nvmrc says ${target}, but:`);
    for (const d of mismatched) console.error(`    ${d.source} says ${d.major}`);
    console.error('  Every declaration must name the same Node major.');
    process.exit(1);
  }

  if (runtimeMajor !== target) {
    console.error(
      `✗ Node pin drift — the repo targets Node ${target}, but this process is Node ${process.versions.node}.\n` +
        `  Install Node ${target} (a version manager will read .nvmrc: \`nvm use\`, \`fnm use\`, \`mise install\`).`
    );
    process.exit(1);
  }

  console.log(
    `✓ Node pin consistent: Node ${target} across ${declarations.length} declarations and the running runtime (${process.versions.node}).`
  );
};

// Only run when invoked directly (`pnpm check:node-pin`), so the parser above
// can be imported by its test without the process exiting.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
