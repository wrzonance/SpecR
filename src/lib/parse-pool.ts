import { Piscina } from 'piscina';
import os from 'node:os';

const isTs = import.meta.url.endsWith('.ts');

export const parsePool = new Piscina({
  filename: new URL(isTs ? './parse-worker.ts' : './parse-worker.js', import.meta.url).href,
  execArgv: isTs ? ['--import', 'tsx'] : [],
  maxThreads: Math.max(1, os.cpus().length - 1),
});
