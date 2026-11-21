import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('project computer image preinstalls Pillow (python3-pil) and ImageMagick for offline image processing', () => {
  const project = readFileSync('docker/project-computer.Dockerfile', 'utf8');
  assert.match(project, /\bpython3-pil\b/);
  assert.match(project, /\bimagemagick\b/);
});
