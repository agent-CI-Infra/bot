import type { GitHub } from '../github/client.js';
import { stop } from '../agent/common.js';
import { filter } from './workflow.js';

export async function actionPages(github: GitHub, path: string, key: string): Promise<any[]> {
  const result: any[] = [];
  for (let page = 1; page <= 100; page++) {
    const value = await github.request('GET', path + (path.includes('?') ? '&' : '?') + `per_page=100&page=${page}`), items = value[key];
    if (!Array.isArray(items)) return stop('release_actions_incomplete', 'failed', `Actions ${key} 分页没有返回完整列表。`);
    result.push(...items);
    if (items.length < 100) {
      if (typeof value.total_count !== 'number' || result.length < value.total_count) return stop('release_actions_incomplete', 'failed', `Actions ${key} 分页尚未取全，不能推进草稿。`);
      return result;
    }
  }
  return stop('release_actions_incomplete', 'failed', `Actions ${key} 超过分页上限，不能确认全部成功。`);
}
export function matchesRun(row: any, run: any): boolean {
  const data = JSON.parse(row.data);
  return String(run.repository?.id) === row.repository_id && run.workflow_id === data.workflow_id
    && run.path === '.github/workflows/release.yml' && run.event === 'push' && run.head_sha === row.target_sha && run.head_branch === row.version;
}
export function ambiguousBranch(data: any, version: string): boolean {
  const workflow = data.workflow;
  if (!workflow?.branch_trigger) return false;
  if (workflow.branches) return !Array.isArray(workflow.branches) || filter(workflow.branches, version).matched;
  if (workflow.branches_ignore) return !Array.isArray(workflow.branches_ignore) || !filter(workflow.branches_ignore, version).matched;
  return true;
}
export async function runSnapshot(github: GitHub, row: any) {
  const data = JSON.parse(row.data), run = await github.request('GET', github.path('/actions/runs/' + data.run_id));
  if (run.id !== data.run_id || !matchesRun(row, run)) return stop('release_run_changed', 'failed', '已绑定 Actions 的仓库、工作流、事件、标签或提交不匹配。');
  const jobs = await actionPages(github, github.path(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`), 'jobs');
  if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < (data.run_attempt || 1) || jobs.some(j => j.run_id !== run.id || (j.run_attempt && j.run_attempt !== run.run_attempt)))
    return stop('release_attempt_changed', 'failed', 'Actions jobs 与当前 run／attempt 不一致。');
  const snapshot = { id: run.id, attempt: run.run_attempt, number: run.run_number, name: run.name, status: run.status, conclusion: run.conclusion,
    url: run.html_url, started_at: run.run_started_at || run.created_at, ended_at: run.status === 'completed' ? run.updated_at : null,
    jobs: jobs.map(j => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, url: j.html_url, started_at: j.started_at, ended_at: j.completed_at,
      steps: (j.steps || []).map((s: any) => ({ name: s.name, number: s.number, status: s.status, conclusion: s.conclusion })) })) };
  const success = run.status === 'completed' && run.conclusion === 'success' && jobs.length > 0 && jobs.every(j => j.status === 'completed' && j.conclusion === 'success');
  return { run, snapshot, success };
}
