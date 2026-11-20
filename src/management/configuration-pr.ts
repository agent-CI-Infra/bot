import { GitHub, revokeInstallationToken } from '../github/client.js';
import { Redactor } from '../agent/common.js';
import { fail, HttpError, type Json } from '../core/security.js';
import { type ManagementCommand, type ManagementExtension, ManagementService } from './service.js';
import type { ActorContext } from '../identity/authorization.js';

export const configurationPrRemoved =
  '快捷配置 PR 通道（configuration.pr）已退役（#1171）：新增或修改仓库 .agents/skills/ 及协作文件统一走正常 PR 开发流程（在项目能力上限开启为 develop 后通过 task.create 创建可检视 PR 开发任务，不设特殊快捷通道）。';

/**
 * Legacy reconciliation adapter for pre-upgrade `configuration.pr` command receipts (#935, #1171).
 * New `configuration.pr` submissions answer 410 `configuration_pr_removed` and route repository file changes
 * through the normal PR development flow (`task.create` with `reviewable_pull_request`).
 */
export class ConfigurationPR implements ManagementExtension {
  constructor(readonly service: ManagementService, readonly githubUrl?: string) {}
  private async client(actor: ActorContext, command: ManagementCommand): Promise<GitHub> {
    const repo = this.service.scope(actor, command.target.project_id, 'config.write');
    if (this.service.store.get('SELECT type FROM accounts WHERE id=?', repo.account_id)?.type !== 'github_app') fail(409, 'configuration_pr_requires_app');
    const github = new GitHub(this.service.store, repo, new Redactor(), async () => this.service.check(actor, command), this.githubUrl);
    await github.connect(true, { contents: 'write', pull_requests: 'write' }, undefined, false);
    return github;
  }
  private branch(key: string) { return 'bot/configuration-' + key; }
  private marker(key: string) { return '<!-- bot-management:' + key + ' -->'; }
  private async find(github: GitHub, key: string): Promise<Json | null> {
    const prs = await github.pages(github.path('/pulls?state=all&head=' + encodeURIComponent(github.fullName.split('/')[0] + ':' + this.branch(key))));
    const pr = prs.find(p => p.head?.ref === this.branch(key) && String(p.body ?? '').includes(this.marker(key)) && Number.isSafeInteger(p.number) && p.number > 0 && typeof p.html_url === 'string');
    return pr ? { pr_url: pr.html_url, pr_number: pr.number, state: pr.merged_at ? 'merged' : 'pending_merge', effective: false, notice: '配置 PR 已创建；未合入默认分支并刷新来源前，不能声称已生效。' } : null;
  }
  async reconcile(actor: ActorContext, command: ManagementCommand, key: string): Promise<Json | null> {
    const gh = await this.client(actor, command);
    try { return await this.find(gh, key); }
    finally { await revokeInstallationToken(gh.apiUrl, gh.token).catch(() => {}); }
  }
  async execute(): Promise<Json> {
    throw Object.assign(new HttpError(410, 'configuration_pr_removed'), { detail: configurationPrRemoved });
  }
}
