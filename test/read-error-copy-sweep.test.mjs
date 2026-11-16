import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// #800: one helper carries every failure the console shows, so the browser's own English text ("Failed to fetch" in
// Chrome, "NetworkError when attempting to fetch resource." in Firefox, "Load failed" in Safari) never reaches the page.
// This guard scans the shipped console sources rather than one page: a new read card, inline read row or action receipt
// that interpolates err.message directly fails here instead of waiting for a reviewer to find it.
const ROOT = new URL('../static', import.meta.url).pathname;

const DISPLAY = [
  // element.textContent = err.message / innerHTML = err.message
  /(?:textContent|innerHTML)\s*=\s*(?:err|error|e)\.message\b/,
  // notice('…', err.message …) / consoleState('…', err.message …) / note(… err.message) / showError(… err.message)
  /\b(?:notice|consoleState|note|showError)\([^()]*\b(?:err|error|e)\.message\b/,
  // '…' + err.message  and  err.message + '…'
  /\+\s*(?:err|error|e)\.message\b/,
  /\b(?:err|error|e)\.message\s*\+/,
  // || err.message fallbacks
  /\|\|\s*(?:err|error|e)\.message\b/,
  // : err.message inside a ternary or object literal
  /:\s*(?:err|error|e)\.message\s*[;,})]/,
  // `${err.message}`
  /\$\{\s*(?:err|error|e)\.message\s*\}/,
];

function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.js') ? [path] : [];
  });
}

test('no console failure text interpolates the raw error message', () => {
  const offenders = [];
  for (const file of sources(ROOT)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (!/\b(?:err|error|e)\.message\b/.test(line)) return;
      const hit = DISPLAY.find(pattern => pattern.test(line));
      if (hit) offenders.push(`${relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `every failure the console shows goes through readErrorText:\n${offenders.join('\n')}`);
});
