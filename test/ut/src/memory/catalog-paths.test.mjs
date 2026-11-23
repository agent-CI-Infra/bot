import test from 'node:test';
import assert from 'node:assert/strict';
import { knowledgePath } from '../../../../dist/memory/catalog.js';

// #533: the sensitive-path check refused any path whose component was named `credentials`, so ordinary code and
// documentation such as `src/auth/credentials.ts` or `docs/credentials.md` could not be referenced by a project
// memory. The check is fail-closed again: every `credentials.*` file stays refused except a positive allowlist of
// source and documentation extensions, so backups and renamed copies (`credentials.json.bak`,
// `credentials.json.orig`) and credential files with other extensions (`.txt`, `.csv`, `.xml`, `.p12`, `.secret`)
// do not slip through.
test('source and documentation files named credentials are allowed', () => {
  for (const path of ['src/auth/credentials.ts', 'docs/credentials.md', 'credentials.js', 'src/credentials.py', 'credentials.mjs', 'credentials.mdx', 'credentials.html', 'credentials.css', 'credentials.vue', 'credentials.svelte', 'credentials.rs', 'credentials.go', 'credentials.java', 'credentials.rb', 'credentials.sh'])
    assert.doesNotThrow(() => knowledgePath(path), `${path} is not a credential file`);
});

test('credential files, their backups and renamed copies stay refused', () => {
  for (const path of [
    // Credential files, including the ones a source allowlist must not open.
    'credentials', 'credentials.json', 'credentials.yml', 'credentials.yaml', 'src/credentials.ini', 'credentials.toml',
    'credentials.env', '.env', '.env.production', 'keys/private.pem', '.ssh/id_rsa',
    // Backups, renames and copies: any extension outside the source allowlist stays refused.
    'credentials.json.bak', 'credentials.yaml.bak', 'credentials.ini.bak', 'credentials.json.orig',
    'credentials.json.tmp', 'credentials.local.json', 'credentials.prod.json',
    // Credential-shaped extensions outside the allowlist.
    'credentials.p12', 'credentials.txt', 'credentials.csv', 'credentials.xml', 'credentials.secret',
    // A source extension followed by another suffix is a copy, not the source file.
    'credentials.ts.bak', 'credentials.md.orig',
  ])
    assert.throws(() => knowledgePath(path), /memory_sensitive_path/, `${path} must stay refused`);
});

// #533: a key is sensitive whatever container holds it. The previous check only looked for `name.pem`/`name.key`
// ending the component, so a PKCS#12 or JKS store, a GPG/ASCII-armored key and a backup copy of a key
// (`cert.pem.bak`, `vault.keystore.old`) were all referenced as ordinary repository files.
test('binary key containers and backups of key material stay refused', () => {
  for (const path of ['tls/server.p12', 'certs/app.jks', 'keys/mail.gpg', 'tls/server.p12.bak',
    'vault.keystore.old', 'cert.pem.bak', 'keys/tls.key.bak', 'vault.kdbx'])
    assert.throws(() => knowledgePath(path), /memory_sensitive_path/, `${path} must stay refused`);
  // Regression: the containers the old check already refused keep being refused.
  for (const path of ['certs/server.pem', 'keys/private.pem', 'id_ed25519'])
    assert.throws(() => knowledgePath(path), /memory_sensitive_path/, `${path} must stay refused`);
});

test('a longer name that merely starts like a key file is not refused', () => {
  for (const path of ['server.pemx', 'notes.md', 'tls/server.pemx', 'docs/keystore-notes.md'])
    assert.doesNotThrow(() => knowledgePath(path), `${path} is not a key file`);
});
