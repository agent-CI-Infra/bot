// Pixel comparison for #224-A. Not a test: Playwright only collects *.spec.mjs. Pair it with
// e2e/design.evidence.mjs — capture the same routes on the base SHA and on the tip, then run this:
//
//   node e2e/design.evidence.mjs .local/evidence/before
//   git switch <base-sha> && node e2e/design.evidence.mjs .local/evidence/before.base
//   node e2e/design.diff.mjs .local/evidence/before.base .local/evidence/before
//
// A capture pair with a different size is reported as SIZE and counted as structural: a route that does not
// exist on the base SHA (such as #/design) falls back to another page there, so its size cannot be compared.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PNG } = require('playwright-core/lib/utilsBundle');

const [a, b, tolArg] = process.argv.slice(2), tol = Number(tolArg || 8);
if (!a || !b) { console.error('usage: node e2e/design.diff.mjs <before-dir> <after-dir> [channel-tolerance=8]'); process.exit(2); }
let structuralTotal = 0, rawTotal = 0, pairs = 0;
for (const name of readdirSync(a).filter(n => n.endsWith('.png')).sort()) {
  const pa = PNG.sync.read(readFileSync(`${a}/${name}`)), pb = PNG.sync.read(readFileSync(`${b}/${name}`));
  pairs += 1;
  if (pa.width !== pb.width || pa.height !== pb.height) {
    console.log(`${name}: SIZE ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`);
    structuralTotal += 1;
    continue;
  }
  let raw = 0, structural = 0, worst = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(pa.data[i + k] - pb.data[i + k]));
    if (d) raw += 1;
    if (d > tol) structural += 1;
    if (d > worst) worst = d;
  }
  rawTotal += raw; structuralTotal += structural;
  if (structural || process.env.VERBOSE) console.log(`${name}: ${pa.width}x${pa.height} worst-channel=${worst} raw=${raw} structural=${structural}`);
}
console.log(`pairs=${pairs} raw=${rawTotal} structural(>${tol})=${structuralTotal} -> ${structuralTotal ? 'DIFFERS' : 'IDENTICAL'}`);
