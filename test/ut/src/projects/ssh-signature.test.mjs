import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import ssh2 from 'ssh2';
import { sshPublicKey, sshSignature } from '../../../../dist/projects/ssh-access.js';

// ssh2's generator drops a leading zero byte of some ed25519 keys (about 1 in 250) and then cannot parse them itself;
// ssh-keygen keys are not affected. Draw again until both halves parse.
function generated(type, options) {
  for (;;) {
    const pair = ssh2.utils.generateKeyPairSync(type, options);
    if (!(ssh2.utils.parseKey(pair.private) instanceof Error) && !(ssh2.utils.parseKey(pair.public) instanceof Error)) return pair;
  }
}

// What an OpenSSH agent returns for SIGN_REQUEST: string(algorithm) string(signature), with ECDSA as mpint r, mpint s.
function decode(blob) {
  const read = offset => { const length = blob.readUInt32BE(offset); return [blob.subarray(offset + 4, offset + 4 + length), offset + 4 + length]; };
  const [algorithm, next] = read(0), [signature, end] = read(next);
  assert.equal(end, blob.length);
  return { algorithm: algorithm.toString(), signature };
}
const mpints = (data, size) => {
  const out = []; let offset = 0;
  while (offset < data.length) { const length = data.readUInt32BE(offset); out.push(data.subarray(offset + 4, offset + 4 + length)); offset += 4 + length; }
  return Buffer.concat(out.map(value => { const trimmed = value[0] === 0 ? value.subarray(1) : value; return Buffer.concat([Buffer.alloc(size - trimmed.length), trimmed]); }));
};

test('targets sign with their own ed25519, RSA and ECDSA keys in the agent format OpenSSH verifies', () => {
  const data = Buffer.from('session-id and userauth request');
  const cases = [
    ['ed25519', {}, 0, 'ssh-ed25519', null],
    ['rsa', { bits: 2048 }, 0, 'ssh-rsa', 'sha1'],
    ['rsa', { bits: 2048 }, 2, 'rsa-sha2-256', 'sha256'],
    ['rsa', { bits: 2048 }, 4, 'rsa-sha2-512', 'sha512'],
    ['ecdsa', { bits: 256 }, 0, 'ecdsa-sha2-nistp256', 'sha256'],
    ['ecdsa', { bits: 384 }, 0, 'ecdsa-sha2-nistp384', 'sha384'],
    ['ecdsa', { bits: 521 }, 0, 'ecdsa-sha2-nistp521', 'sha512'],
  ];
  for (const [type, options, flags, algorithm, hash] of cases) {
    const pair = generated(type, options), parsed = ssh2.utils.parseKey(pair.public);
    assert.equal(sshPublicKey(pair.private), parsed.getPublicSSH().toString('base64'));
    const decoded = decode(sshSignature(pair.private, data, flags)), key = createPublicKey(parsed.getPublicPEM());
    assert.equal(decoded.algorithm, algorithm);
    const ok = type === 'ecdsa'
      ? verify(hash, data, { key, dsaEncoding: 'ieee-p1363' }, mpints(decoded.signature, Math.ceil(options.bits / 8)))
      : verify(hash, data, key, decoded.signature);
    assert.equal(ok, true, algorithm);
  }
  // Encrypted keys and unsupported formats are refused when registered, never prompted for.
  const encrypted = ssh2.utils.generateKeyPairSync('ed25519', { passphrase: 'secret', cipher: 'aes256-ctr' }).private;
  assert.equal(sshPublicKey(encrypted), null);
  assert.equal(sshPublicKey('-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n'), null);
  assert.throws(() => sshSignature(encrypted, data, 0), /ssh_credential_invalid/);
});
