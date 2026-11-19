import test from 'node:test';
import assert from 'node:assert/strict';
import { publicContent, publicText, Redactor } from '../../../runner/credential-redaction.mjs';

test('only exact registered values and complete allowlisted formats are masked in public text', () => {
  const redactor = new Redactor(), value = 'deployed/+credential&';
  redactor.add(value);
  const forms = [value, encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')];
  const tokenShapes = [...'pousr'].map(c => 'gh'+c+'_'+'X'.repeat(30)).concat([
    'github_pat_'+'0'.repeat(22), 'sk-'+'a'.repeat(20), 'AKIA'+'X'.repeat(16), 'ASIA'+'0'.repeat(16), 'AIza'+'_'.repeat(35),
    ...[...'baprs'].map(c => 'xox'+c+'-'+'A'.repeat(10)), 'glpat-'+'Z'.repeat(20), 'rrt_'+'_'.repeat(16)]);
  const shapes = [...tokenShapes, '-----BEGIN RSA PRIVATE KEY-----\nfirst\nsecond\n-----END RSA PRIVATE KEY-----'];
  for (const token of tokenShapes) assert.equal(publicText('identifier_'+token, redactor), 'identifier_'+token);
  for (const item of [...forms, ...shapes]) assert.equal(publicText('before '+item+' after', redactor), 'before [REDACTED] after');
  for (const item of [...shapes,...forms.slice(1)]) assert.equal(redactor.text(item), item);
  assert.equal(redactor.text(value), '[REDACTED]');
  assert.deepEqual(publicContent({body: forms, max_tokens: 12}, redactor), {body: forms.map(() => '[REDACTED]'), max_tokens: 12});
});

test('identifiers, public certificates, incomplete PEM and arbitrary Base64 keep their surrounding bytes', () => {
  const redactor = new Redactor(), secret = 'the registered token'; redactor.add(secret);
  const pem = '-----BEGIN RSA PRIVATE KEY-----';
  const folded = Buffer.from('prefix '+secret+' suffix').toString('base64').match(/.{1,8}/g).join('\r\n> ');
  for (const text of [folded, 'token = "my_custom_identifier_12345"', 'password=hunter2', 'Authorization: Bearer fixture',
    'bot/task-'+'a'.repeat(40), 'cookie: documentation', 'ghp_'+'x'.repeat(29), 'sk-'+'a'.repeat(19), pem+'\nunclosed\n-----END PRIVATE KEY-----',
    '-----BEGIN CERTIFICATE-----\r\npublic\r\n-----END CERTIFICATE-----']) assert.equal(publicText(text, redactor), text);
  const block = pem+'\nvalid\n-----END RSA PRIVATE KEY-----';
  assert.equal(publicText(pem+'\nkeep\n'+block+'\nend', redactor), pem+'\nkeep\n[REDACTED]\nend');
  redactor.add('sk-abcdefghijk');
  assert.equal(publicText('x sk-abcdefghijklmnopqrstuvwxyz y', redactor), 'x [REDACTED] y');
});
