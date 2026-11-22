#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Replace only the uv subprocess for the dependency-free fixture. Installation and version publication use the real CLI.
const [command, ...args] = process.argv.slice(2);
const python = args[args.indexOf('--python') + 1];
const venv = process.env.UV_PROJECT_ENVIRONMENT;
assert.equal(process.env.UV_OFFLINE, '1');
assert.match(readFileSync('pyproject.toml', 'utf8'), /^dependencies = \[\]$/m);
assert.match(readFileSync('uv.lock', 'utf8'), /^source = \{ virtual = "\." \}$/m);

if (command === 'venv') {
  assert.deepEqual(args, ['--no-managed-python', '--no-python-downloads', '--python', python, venv]);
  execFileSync(python, ['-m', 'venv', '--without-pip', venv], { stdio: 'inherit' });
} else {
  assert.equal(command, 'sync');
  assert.deepEqual(args, ['--locked', '--no-dev', '--no-editable', '--no-managed-python', '--no-python-downloads', '--python', python]);
}
