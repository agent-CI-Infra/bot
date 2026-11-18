import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = {
  project: readFileSync('docker/project-computer.Dockerfile', 'utf8'),
  control: readFileSync('docker/control-plane.Dockerfile', 'utf8'),
  manager: readFileSync('docker/manager.Dockerfile', 'utf8'),
  tunnel: readFileSync('docker/tunnel.Dockerfile', 'utf8'),
  wrapper: readFileSync('docker/bot-chromium.sh', 'utf8')
};

test('project and control-plane images preinstall Chromium at the documented path', () => {
  for (const [name, text] of [['project', files.project], ['control', files.control]]) {
    assert.match(text, /chromium fonts-liberation/, `${name} image must apt-install the chromium package`);
    assert.match(text, /fonts-noto-cjk/, `${name} image must include a CJK font for evidence screenshots`);
    assert.match(text, /COPY docker\/bot-chromium\.sh \/usr\/local\/bin\/bot-chromium/);
    assert.match(text, /ENV BOT_BROWSER_EXECUTABLE=\/usr\/local\/bin\/bot-chromium/);
  }
  assert.match(files.wrapper, /HOME="\$\{BOT_BROWSER_HOME:-\/tmp\/bot-chromium-home\}"/);
  assert.match(files.wrapper, /export HOME/);
  assert.match(files.wrapper, /mkdir -p "\$HOME"/);
  assert.match(files.wrapper, /exec \/usr\/bin\/chromium/);
  assert.match(files.wrapper, /--no-sandbox/);
  assert.equal(files.manager.includes('bot-chromium'), false, 'manager image must not gain a browser runtime');
  assert.equal(files.tunnel.includes('bot-chromium'), false, 'tunnel image must not gain a browser runtime');
  assert.equal(files.manager.includes('BOT_BROWSER_EXECUTABLE'), false);
  assert.equal(files.tunnel.includes('BOT_BROWSER_EXECUTABLE'), false);
});
