import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

// Classic console scripts share one global scope. `const` and top-level listeners run in source
// order and are not hoisted across separate files, so a split page stays one URL: the entry file
// is only this manifest, and the bytes sent to the browser are the modules joined in that order.
const MANIFEST = /^\/\*\* @console-modules\n((?: \* [a-z0-9][a-z0-9./_-]*\.js\n)+) \*\/\n$/;

/** Module paths relative to the manifest's directory, or null when `source` is an ordinary script. */
export function consoleModulePaths(source: string): string[] | null {
  if (!source.startsWith('/** @console-modules\n')) return null;
  const match = MANIFEST.exec(source);
  const body = match?.[1];
  if (body === undefined) throw new Error('console module manifest is malformed');
  return body.trimEnd().split('\n').map(line => line.slice(3));
}

function moduleFile(root: string, relative: string): string {
  const full = normalize(join(root, relative));
  const base = normalize(root).endsWith(sep) ? normalize(root) : normalize(root) + sep;
  if (relative.includes('..') || !full.startsWith(base)) throw new Error('console module path escapes its directory: ' + relative);
  return full;
}

/** The script a test sandbox should run. A manifest expands to its modules; any other file is unchanged. */
export function readConsoleScriptSync(file: string): string {
  const source = readFileSync(file, 'utf8');
  const paths = consoleModulePaths(source);
  if (!paths) return source;
  const root = dirname(file);
  return paths.map(relative => readFileSync(moduleFile(root, relative), 'utf8')).join('');
}

/** The bytes for one static asset. JavaScript manifests expand; images and ordinary files do not. */
export async function readStaticAsset(directory: string, name: string): Promise<Buffer> {
  const file = join(directory, name);
  const bytes = await readFile(file);
  const paths = consoleModulePaths(bytes.toString('utf8'));
  if (!paths) return bytes;
  const root = dirname(file);
  const parts: Buffer[] = [];
  for (const relative of paths) parts.push(await readFile(moduleFile(root, relative)));
  return Buffer.concat(parts);
}
