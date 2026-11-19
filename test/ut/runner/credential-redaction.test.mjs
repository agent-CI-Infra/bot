import test from 'node:test';
import assert from 'node:assert/strict';
import { credentialShapeStream, githubTokens, hasCredentials, redactCredentials, redactCredentialShapes } from '../../../runner/credential-redaction.mjs';

// Constructed values only: a GitHub-shaped installation token whose JWT carries a fake header and payload.
const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = part({ alg: 'RS256', typ: 'JWT' }) + '.' + part({ iss: 'fixture-app', installation_id: 424242, exp: 1795000000 }) + '.fixture-signature_' + 'Sg9'.repeat(12);
const installation = 'ghs_424242_' + jwt;
// gh auth status keeps the token up to its last `_` and prints `*` for the rest.
const masked = installation.slice(0, installation.lastIndexOf('_') + 1) + '*'.repeat(installation.length - installation.lastIndexOf('_') - 1);
const classic = 'ghs_' + 'Fx7Q2wLm9ZpC4vRt8KsN1bYd6HjE3gUa0oXi';
const pat = 'github_pat_11FIXTURE0' + 'q'.repeat(12) + '_' + 'Pz4'.repeat(19) + 'W1';
const status = `github.com
  ✓ Logged in to github.com account fixture-app[bot] (GH_TOKEN)
  - Active account: true
  - Git operations protocol: https
  - Token: ${masked}
`;
const pieces = [installation.split('_')[1], part({ alg: 'RS256', typ: 'JWT' }), part({ iss: 'fixture-app', installation_id: 424242, exp: 1795000000 }), 'fixture-signature', classic.slice(4), pat.slice(11)];
const leaks = text => pieces.filter(piece => text.includes(piece));

test('GitHub tokens are redacted by their form: classic, <prefix><id>_<JWT>, the masked gh auth status output and github_pat_', () => {
  for (const [name, text, expected] of [
    ['classic ghs_', `token ${classic} here`, 'token [REDACTED] here'],
    ['installation token with a JWT', `value ${installation} end`, 'value [REDACTED] end'],
    ['gh auth status with a masked tail', status, status.replace(masked, '[REDACTED]')],
    ['github_pat_', `pat=${pat};`, 'pat=[REDACTED];'],
    ['a token ending a sentence', `The token was ${installation}. Next sentence.`, 'The token was [REDACTED]. Next sentence.'],
    ['terminal colours', `\x1b[1m${installation}\x1b[0m`, '\x1b[1m[REDACTED]\x1b[0m']
  ]) {
    for (const redact of [redactCredentials, redactCredentialShapes, value => value.replace(githubTokens(), '[REDACTED]')]) assert.equal(redact(text), expected, name);
    assert.equal(hasCredentials(text), true, name);
  }
  // Text that gh masked completely keeps nothing secret and stays readable.
  for (const text of ['  - Token: ghs_************************************', '  - Token: github_pat_*****************']) assert.equal(redactCredentials(text), text);
});

test('a token inside JSON-escaped text is redacted, parsed or not', () => {
  const event = JSON.stringify({ type: 'tool', result: { content: [{ type: 'text', text: status }] } });
  for (const redact of [redactCredentials, redactCredentialShapes]) {
    const cleaned = redact(event);
    assert.deepEqual(leaks(cleaned), []);
    assert.equal(JSON.parse(cleaned).result.content[0].text, status.replace(masked, '[REDACTED]'));
    // A clipped log is no longer JSON: an escaped newline, even escaped twice, still ends the text before the token.
    for (const clipped of [event.slice(0, -5), JSON.stringify(event).slice(0, -5)]) assert.deepEqual(leaks(redact(clipped)), [], clipped.slice(0, 40));
  }
});

test('ordinary words with gh or ghs and short names keep their exact bytes', () => {
  for (const text of ['ghost laughs ghs GHS sighs high_score', 'Installation tokens start with `ghs_`; a ghs_ prefix.', 'const ghs_prefix = readPrefix();',
    'num_highs_and_lows_for_this_reporting_period', 'export GH_TOKEN=ghp_xxx', 'see thoughts_on_github_pat_rotation_policy_document']) {
    assert.equal(redactCredentials(text), text); assert.equal(redactCredentialShapes(text), text); assert.equal(hasCredentials(text), false, text);
  }
});

test('the agent-facing form keeps ordinary code while the stored form also applies context rules', () => {
  const code = `const token = callOptions.token;\nconst header = 'x';\n// ${classic}\n`;
  assert.equal(redactCredentialShapes(code), code.replace(classic, '[REDACTED]'));
  assert.equal(redactCredentials(code), 'const token = [REDACTED];\nconst header = \'x\';\n// [REDACTED]\n');
  // Named fields are a context rule too.
  assert.deepEqual(redactCredentialShapes({ password: 'fixture-password', text: classic }), { password: 'fixture-password', text: '[REDACTED]' });
  assert.deepEqual(redactCredentials({ password: 'fixture-password', text: classic }), { password: '[REDACTED]', text: '[REDACTED]' });
});

test('streamed output gets the same result in any split, including a private key block across pieces', () => {
  const text = status + 'build log\n-----BEGIN RSA PRIVATE KEY-----\nMIIfixture\nmaterial\n-----END RSA PRIVATE KEY-----\nafter ' + classic + '.\n中😀 ' + installation + '\n';
  const whole = redactCredentialShapes(text);
  assert.deepEqual(leaks(whole), []); assert.ok(!whole.includes('MIIfixture') && whole.includes('build log\n[REDACTED]\nafter [REDACTED].\n中😀 [REDACTED]\n'));
  for (const size of [1, 7, 64, text.length]) {
    const out = [], stream = credentialShapeStream(value => out.push(value));
    for (let offset = 0; offset < text.length; offset += size) stream.data(text.slice(offset, offset + size));
    stream.end(); assert.equal(out.join(''), whole, String(size));
  }
  // A key block that never ends is dropped to the end, as in the whole text; a long line is cut where no shape can be.
  const open = 'a\n-----BEGIN PRIVATE KEY-----\nMIIfixture\n', out = [], stream = credentialShapeStream(value => out.push(value), 16);
  stream.data(open); stream.data('x'.repeat(40) + ' ' + classic); stream.end();
  assert.equal(out.join(''), redactCredentialShapes(open + 'x'.repeat(40) + ' ' + classic));
  const long = [], cut = credentialShapeStream(value => long.push(value), 16);
  cut.data('x'.repeat(20) + ' "' + classic.slice(0, 10)); cut.data(classic.slice(10) + '" done'); cut.end();
  assert.equal(long.join(''), 'x'.repeat(20) + ' "[REDACTED]" done');
});
