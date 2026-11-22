import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const files = {
  project: readFileSync('docker/project-computer.Dockerfile', 'utf8'),
  control: readFileSync('docker/control-plane.Dockerfile', 'utf8'),
  manager: readFileSync('docker/manager.Dockerfile', 'utf8'),
  tunnel: readFileSync('docker/tunnel.Dockerfile', 'utf8'),
  chromium: readFileSync('docker/bot-chromium.sh', 'utf8'),
  desktop: readFileSync('docker/bot-desktop.sh', 'utf8'),
};

test('project/assistant computer image preinstalls Chromium and X11 virtual desktop tools while control-plane, manager and tunnel do not', () => {
  assert.match(files.project, /chromium fonts-liberation/, 'project/assistant image must apt-install chromium');
  assert.match(files.project, /fonts-noto-cjk/, 'project/assistant image must include CJK fonts');
  for (const pkg of ['xvfb', 'openbox', 'xdotool', 'wmctrl', 'xclip', 'scrot', 'ffmpeg', 'x11-utils']) {
    assert.match(files.project, new RegExp(`\\b${pkg}\\b`), `project/assistant image must install ${pkg}`);
  }
  assert.match(files.project, /COPY docker\/bot-chromium\.sh \/usr\/local\/bin\/bot-chromium/);
  assert.match(files.project, /COPY docker\/bot-desktop\.sh \/usr\/local\/bin\/bot-desktop/);
  assert.match(files.project, /ENV BOT_BROWSER_EXECUTABLE=\/usr\/local\/bin\/bot-chromium/);

  assert.match(files.chromium, /HOME="\$\{BOT_BROWSER_HOME:-\/tmp\/bot-chromium-home\}"/);
  assert.match(files.chromium, /XDG_CONFIG_HOME=/);
  assert.match(files.chromium, /exec \/usr\/bin\/chromium/);
  assert.match(files.chromium, /--no-sandbox/);

  assert.match(files.desktop, /Xvfb/);
  assert.match(files.desktop, /openbox/);
  assert.match(files.desktop, /-nolisten tcp/);

  for (const [name, text] of [['control', files.control], ['manager', files.manager], ['tunnel', files.tunnel]]) {
    assert.equal(text.includes('bot-chromium'), false, `${name} image must not include bot-chromium`);
    assert.equal(text.includes('bot-desktop'), false, `${name} image must not include bot-desktop`);
    assert.equal(text.includes('BOT_BROWSER_EXECUTABLE'), false, `${name} image must not export BOT_BROWSER_EXECUTABLE`);
    assert.equal(/\bchromium\b/.test(text), false, `${name} image must not install chromium`);
  }
});
