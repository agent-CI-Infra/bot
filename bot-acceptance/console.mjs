#!/usr/bin/env node
// The test AI's door to the console: one request as the project administrator bootstrap created, printed as JSON.
//
//   node bot-acceptance/console.mjs GET '/api/tasks?repository_id={repo}&limit=20'
//   node bot-acceptance/console.mjs PATCH /api/repositories/{repo}/policy '{"test_command":"sh scripts/test.sh"}'
//   echo '{"…":…}' | node bot-acceptance/console.mjs POST /api/repositories/{repo}/workflows -
//
// {repo} stands for the fixture's repository id from target.json. Only /api/ paths on the instance under test are accepted;
// the session is the project administrator's, so the bot itself enforces what this account may see and change.
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { signedIn } from './lib/console.mjs';
import { stateDir } from './lib/state.mjs';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export async function call(argv, dir = stateDir()) {
  const [method = '', rawPath = '', bodyArgument] = argv;
  if (!METHODS.includes(method.toUpperCase())) throw new Error(`usage: console.mjs <${METHODS.join('|')}> /api/... [json|-]`);
  const { client, target } = await signedIn(dir, 'operator');
  const path = rawPath.replaceAll('{repo}', encodeURIComponent(target.repository.id));
  if (!/^\/api\/[^\s]*$/.test(path)) throw new Error('the path must start with /api/');
  const text = bodyArgument === '-' ? readFileSync(0, 'utf8') : bodyArgument;
  let body; if (text !== undefined) { try { body = JSON.parse(text); } catch { throw new Error('the body must be JSON'); } }
  return client.request(method.toUpperCase(), path, body);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { console.log(JSON.stringify(await call(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exit(1); }
}
