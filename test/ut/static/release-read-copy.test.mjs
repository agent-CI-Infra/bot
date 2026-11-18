import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConsole } from '../../fixtures/console-page.mjs';

// #691: the release page's read clock and empty tag/release facts should match the rest of the console.
const source = readFileSync(new URL('../../../static/release.js', import.meta.url), 'utf8');
const visible = node => [node.textContent, ...node.children.flatMap(visible)].filter(Boolean).join(' ');
const all = node => [node, ...node.children.flatMap(all)];
const statusLine = root => all(root).find(node => node.tagName === 'P' && node.getAttribute('role') === 'status');
const factValue = (root, label) => {
  const dt = all(root).find(node => node.tagName === 'DT' && node.textContent === label);
  assert.ok(dt, `missing fact ${label} in: ${visible(root)}`);
  const dd = dt.parentElement.children[dt.parentElement.children.indexOf(dt) + 1];
  assert.equal(dd?.tagName, 'DD', `${label} should be followed by a dd`);
  return visible(dd);
};
const waitFor = (read, message) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    try {
      const value = read();
      if (value) return resolve(value);
    } catch (error) { return reject(error); }
    if (Date.now() - started > 2000) return reject(new Error(message()));
    setTimeout(tick, 10);
  };
  tick();
});

test('release.js uses the shared timestamp() clock and 暂无 for empty tag and release facts', () => {
  assert.match(source, /readStatus\.textContent = `记录读取于 \$\{timestamp\(new Date\(\)\)\}`/);
  assert.doesNotMatch(source, /toLocaleTimeString|这是读取时间/);
  assert.match(source, /\['已有标签', p\.existing_tag \? p\.existing_tag\.commit : '暂无'\]/);
  assert.match(source, /p\.existing_release \? link\(p\.existing_release\.url, p\.existing_release\.draft \? '已有草稿' : '已由仓库工作流／外部操作发布'\) : '暂无'/);
  assert.doesNotMatch(source, /打开接入门禁|openGateOnboarding/);
});

function releasePage(respond) {
  const page = loadConsole(['static/app.js', 'static/views.js', 'static/project.js', 'static/release.js'], respond);
  page.run(`try { Object.defineProperty(Node.prototype, 'isConnected', { configurable: true, get() { return true; } }); } catch {}`);
  return page;
}

function mountRelease(page, current = "{id:'101', section:'release'}") {
  page.run(`me={id:'admin'}; current=${current}; document.getElementById('project-page').replaceChildren(...releaseSection());`);
}

const emptyPreview = {
  available: false, version_valid: false, checks: [{ ok: true, message: '还没有上一枚版本标签，不比较版本号' }],
  target_sha: 'a'.repeat(40), target_url: 'https://github.com/fixture/project-101/commit/' + 'a'.repeat(40),
  target_title: 'seed', default_branch: 'main', prerelease: false, previous_tag: null, commit_count: 1,
  skill: { source: 'builtin', path: null, version: 'release-notes-v1' }, existing_tag: null, existing_release: null,
};

test('the release section formats the read time as YYYY-MM-DD HH:mm:ss and shows 暂无 for empty tag and Release facts', async () => {
  const page = releasePage((method, path) => {
    if (path.includes('/releases/preflight')) return [200, emptyPreview];
    if (path.includes('/releases')) return [200, { releases: [] }];
    return [200, {}];
  });
  mountRelease(page);
  try {
    const root = page.$('project-page');
    await waitFor(() => statusLine(root)?.textContent && all(root).some(node => node.className?.split(/\s+/).includes('facts')),
      () => `release section did not render: ${visible(root)}`);
    assert.match(statusLine(root).textContent, /^记录读取于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(!visible(root).includes('这是读取时间'), visible(root));
    assert.equal(factValue(root, '已有标签'), '暂无');
    assert.equal(factValue(root, '已有 Release'), '暂无');
    assert.equal(all(root).filter(node => node.tagName === 'BUTTON' && (node.textContent === '打开接入门禁' || node.textContent === '创建任务')).length, 0);
  } finally {
    page.run('if (typeof projectTimer !== "undefined") clearTimeout(projectTimer);');
  }
});

test('filled tag and Release facts keep their values instead of 暂无', async () => {
  const preview = {
    ...emptyPreview, version_valid: true,
    existing_tag: { commit: 'b'.repeat(40) },
    existing_release: { url: 'https://github.com/fixture/project-101/releases/tag/v1.2.3', draft: false },
  };
  const page = releasePage((method, path) => {
    if (path.includes('/releases/preflight')) return [200, preview];
    if (path.includes('/releases')) return [200, { releases: [] }];
    return [200, {}];
  });
  mountRelease(page, "{id:'101', section:'release', releaseVersion:'v1.2.3'}");
  try {
    const root = page.$('project-page');
    await waitFor(() => all(root).some(node => node.tagName === 'DT' && node.textContent === '已有标签'),
      () => `facts did not render: ${visible(root)}`);
    assert.equal(factValue(root, '已有标签'), 'b'.repeat(40));
    assert.equal(factValue(root, '已有 Release'), '已由仓库工作流／外部操作发布');
    assert.ok(![factValue(root, '已有标签'), factValue(root, '已有 Release')].includes('暂无'));
  } finally {
    page.run('if (typeof projectTimer !== "undefined") clearTimeout(projectTimer);');
  }
});
