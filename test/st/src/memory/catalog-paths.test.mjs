import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgePath } from '../../../../dist/memory/catalog.js';

// #533: the sensitive-path check refused any path whose component was named `credentials`, so ordinary code and
// documentation such as `src/auth/credentials.ts` or `docs/credentials.md` could not be referenced by a project
// memory. Only credential-shaped files stay refused: the bare name and credential file extensions.
test('ordinary code and documentation files named credentials are allowed', () => {
  for (const path of ['src/auth/credentials.ts', 'docs/credentials.md', 'credentials.js', 'src/credentials.py', 'credentials.html'])
    assert.doesNotThrow(() => knowledgePath(path), `${path} is not a credential file`);
});

test('credential files and private keys stay refused', () => {
  for (const path of ['credentials', 'credentials.json', 'credentials.yml', 'credentials.yaml', 'src/credentials.ini', 'credentials.toml', 'credentials.env', '.env', '.env.production', 'keys/private.pem', '.ssh/id_rsa'])
    assert.throws(() => knowledgePath(path), /memory_sensitive_path/, `${path} must stay refused`);
});
