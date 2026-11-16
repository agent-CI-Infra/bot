import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = {
  project: readFileSync('images/project/Dockerfile', 'utf8'),
  control: readFileSync('Dockerfile', 'utf8'),
  manager: readFileSync('manager/Dockerfile', 'utf8'),
  tunnel: readFileSync('tunnel/Dockerfile', 'utf8'),
  wrapper: readFileSync('scripts/bot-chromium.sh', 'utf8')
};

test('project and control-plane images preinstall Chromium at the documented path', () => {
  for (const [name, text] of [['project', files.project], ['control', files.control]]) {
    assert.match(text, /\bchromium\b/, `${name} image must install the chromium package`);
    assert.match(text, /fonts-noto-cjk/, `${name} image must include a CJK font for evidence screenshots`);
    assert.match(text, /COPY scripts\/bot-chromium\.sh \/usr\/local\/bin\/bot-chromium/);
    assert.match(text, /ENV BOT_BROWSER_EXECUTABLE=\/usr\/local\/bin\/bot-chromium/);
  }
  assert.match(files.wrapper, /exec \/usr\/bin\/chromium/);
  assert.match(files.wrapper, /--no-sandbox/);
  assert.equal(files.manager.includes('bot-chromium'), false, 'manager image must not gain a browser runtime');
  assert.equal(files.tunnel.includes('bot-chromium'), false, 'tunnel image must not gain a browser runtime');
  assert.equal(files.manager.includes('BOT_BROWSER_EXECUTABLE'), false);
  assert.equal(files.tunnel.includes('BOT_BROWSER_EXECUTABLE'), false);
});
