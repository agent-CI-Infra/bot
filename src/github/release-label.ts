import { parse } from 'yaml';
import type { GitHub } from './client.js';
import { stop } from '../agent/common.js';

// This is the target repository's contribution contract, not a global label policy.
export async function releaseCategory(github: GitHub, selected: unknown): Promise<string | null> {
  if (github.fullName?.toLowerCase() !== 'openjiuwen-ai/sciencediscovery') return null;
  const read = async (path: string) => {
    const value = await github.request('GET', github.path('/contents/' + path + '?ref=' + encodeURIComponent(github.defaultBranch)), undefined, true);
    if (!value || value.encoding !== 'base64' || typeof value.content !== 'string') return stop('pr_contributing_contract_missing', 'waiting_publication', `无法读取 ${path}，PR 的发布类别尚未完成。`);
    return Buffer.from(value.content, 'base64').toString('utf8');
  };
  const contributing = await read('CONTRIBUTING.md'), skill = await read('.agents/skills/create-github-pr/SKILL.md'), config = await read('.github/release.yml');
  if (!contributing.trim() || !skill.trim()) stop('pr_contributing_contract_missing', 'waiting_publication');
  let release: any; try { release = parse(config); } catch { stop('pr_release_config_invalid', 'waiting_publication'); }
  const labels = [...(release?.changelog?.categories || []).flatMap((c: any) => c.labels || []), ...(release?.changelog?.exclude?.labels || [])];
  if (typeof selected !== 'string' || !/^release:[a-z][a-z-]*$/.test(selected) || !labels.includes(selected))
    stop('pr_release_category_required', 'waiting_publication', '请按当前 CONTRIBUTING 和 create-github-pr skill 选择一个 release:* 类别；发行分组文件不会自动给 PR 加标签。');
  return String(selected);
}

export async function applyReleaseCategory(github: GitHub, number: number, selected: string | null) {
  if (!selected) return;
  const path = github.path(`/issues/${number}/labels`), releaseLabels = async () => (await github.pages(path)).map(l => String(l.name)).filter(n => n.startsWith('release:'));
  const before = await releaseLabels();
  if (before.some(name => name !== selected)) stop('pr_release_label_conflict', 'waiting_publication', `PR #${number} 有其他 release:* 标签，类别未完成，需要维护者核对。`);
  if (!before.includes(selected)) {
    try { await github.request('POST', path, { labels: [selected] }); }
    catch { stop('pr_release_label_incomplete', 'waiting_publication', `PR #${number} 已存在，但未能确认 ${selected} 标签；发布未完成，需要维护者处理。`); }
  }
  const actual = await releaseLabels();
  if (actual.length !== 1 || actual[0] !== selected) stop('pr_release_label_incomplete', 'waiting_publication', `PR #${number} 的 release:* 标签读回不满足唯一类别；发布未完成。`);
}
