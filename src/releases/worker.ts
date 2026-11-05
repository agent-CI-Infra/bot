import type { ReleaseService } from './service.js';
import type { GitHub } from '../github/client.js';
import { digest, fail } from '../core/security.js';
import { stop, type Redactor } from '../agent/common.js';
import { tag, releases, releaseRedactor, withGitHub } from './github.js';
import { actionPages, ambiguousBranch, matchesRun, runSnapshot } from './actions.js';
import { sources } from './range.js';
import { builtinGroups, checkGroups, notesUseModel, renderNotes, requestNotes } from './notes.js';
import { eventTaskActive } from '../workflows/events.js';
import { prerelease } from './version.js';

export class ReleaseWorker {
  constructor(readonly service: ReleaseService) {}
  async effect(row: any, kind: string, request: any, send: () => Promise<any>, probe: () => Promise<any | null>, redactor: Redactor) {
    const store = this.service.store, id = row.id + ':' + kind, hash = digest(JSON.stringify(request));
    let saved = store.get('SELECT * FROM release_effects WHERE id=?', id);
    if (saved && saved.request_hash !== hash) return stop('release_operation_changed', 'failed', '已登记的发布写入内容发生变化。');
    if (saved?.state === 'sent') return JSON.parse(saved.response);
    const known = await probe();
    if (known) {
      const now = new Date().toISOString();
      store.run(`INSERT INTO release_effects VALUES(?,?,?,?,'sent',?,?,?) ON CONFLICT(id) DO UPDATE SET state='sent',response=excluded.response,updated_at=excluded.updated_at`,
        id, row.id, kind, hash, JSON.stringify(redactor.clean(known)), now, now);
      return known;
    }
    if (saved && ['inflight', 'unknown'].includes(saved.state)) return stop('release_write_unknown', 'write_unknown', `${kind} 写入结果尚未查明，未重复发送。请在 GitHub 查证后刷新或继续查询。`);
    const now = new Date().toISOString();
    store.run(`INSERT INTO release_effects VALUES(?,?,?,?,'pending',NULL,?,?) ON CONFLICT(id) DO NOTHING`, id, row.id, kind, hash, now, now);
    await this.service.guard(row);
    store.run("UPDATE release_effects SET state='inflight',updated_at=? WHERE id=?", now, id);
    try {
      const response = await send();
      store.run("UPDATE release_effects SET state='sent',response=?,updated_at=? WHERE id=?", JSON.stringify(redactor.clean(response)), new Date().toISOString(), id);
      return response;
    } catch (error) {
      const code = (error as any).code || '';
      const uncertain = code === 'github_response_unknown' || code === 'github_invalid_response';
      store.run('UPDATE release_effects SET state=?,updated_at=? WHERE id=?', uncertain ? 'unknown' : 'pending', new Date().toISOString(), id);
      // A timeout or ref conflict can still have succeeded. Read the remote result before deciding anything else.
      if (uncertain || code === 'github_http_422') {
        const found = await probe();
        if (found) { store.run("UPDATE release_effects SET state='sent',response=? WHERE id=?", JSON.stringify(redactor.clean(found)), id); return found; }
      }
      if (uncertain) return stop('release_write_unknown', 'write_unknown', `${kind} 写入结果尚未确认，未重复发送。`);
      throw error;
    }
  }
  async checkedTag(github: GitHub, row: any) {
    const value = await tag(github, row.version);
    if (value && value.commit !== row.target_sha) return stop('release_tag_conflict', 'failed', `标签 ${row.version} 指向 ${value.commit}，确认的提交是 ${row.target_sha}；不会移动或删除标签。`);
    return value;
  }
  // The release.notes task this release waits for, while it still runs: nothing is asked of GitHub meanwhile.
  private notesRunning(row: any) {
    const data = JSON.parse(row.data), task = data.notes_task ? this.service.store.get('SELECT * FROM tasks WHERE id=?', data.notes_task) : undefined;
    // Provider downtime fails the step at once instead of keeping the release waiting: the release has explicit retry controls.
    if (task && ['retry_wait', 'waiting_configuration'].includes(task.status) && /^model_/.test(String(task.error_code || ''))) return false;
    return row.stage === 'preparing_notes' && eventTaskActive(task);
  }
  async process(id: string) {
    let row: any; try { row = this.service.claim(id); } catch { return; }
    const redactor = releaseRedactor(this.service.store, row.repository_id);
    if (this.notesRunning(row)) { this.service.store.run('UPDATE project_releases SET next_poll=? WHERE id=? AND lease=?', Date.now() + 5000, row.id, row.lease); this.service.unlock(row); return; }
    try {
      await withGitHub(this.service.store, row.repository_id, this.service.apiUrl, ['tagging', 'creating_draft'].includes(row.stage) ? { contents: 'write' } : { pull_requests: 'read' }, redactor,
        async github => {
          if (row.stage === 'tagging') await this.tagging(github, row, redactor);
          else if (['waiting_run', 'running'].includes(row.stage)) await this.observeRun(github, row, redactor);
          else if (row.stage === 'preparing_notes') await this.prepareNotes(github, row, redactor);
          else if (row.stage === 'creating_draft') await this.createDraft(github, row, redactor);
          else if (row.stage === 'publishing') await this.reconcilePublish(github, row, redactor);
        }, () => this.service.guard(row));
    } catch (error) {
      // Another worker may have recovered an expired lease. Its record must never be overwritten by this worker.
      if (this.service.store.get('SELECT lease FROM project_releases WHERE id=?', row.id)?.lease === row.lease) this.failed(row, error, redactor);
    }
    finally { this.service.unlock(row); }
  }
  failed(row: any, error: any, redactor: Redactor, failureStep = row.stage) {
    const retryRead = error.state === 'retry_wait' && !['tagging', 'creating_draft', 'publishing'].includes(row.stage);
    const stage = retryRead ? row.stage : error.state === 'waiting_permission' ? 'waiting_permission' : error.state === 'write_unknown' ? 'write_unknown' : 'failed';
    // A failed notes step asks for a new release.notes task when it is resumed.
    this.service.save(row, { failure_step: failureStep, error: error.code || 'release_failed', detail: redactor.text(error.detail || '发布步骤失败，请检查接入和 GitHub 状态。'),
      ...(row.stage === 'preparing_notes' && !retryRead ? { notes_task: null } : {}) }, stage);
    if (retryRead) this.pollLater(row, error.retryAfterMs);
  }
  async tagging(github: GitHub, row: any, redactor: Redactor) {
    let existing = await this.checkedTag(github, row);
    if (existing) {
      const data = JSON.parse(row.data);
      this.service.save(row, { tag_object_sha: existing.object_sha, reused_tag: !data.tagged_at, tagged_at: data.tagged_at || null, wait_started_at: data.wait_started_at || Date.now() }, 'waiting_run'); return;
    }
    const object = await this.effect(row, 'tag_object', { tag: row.version, message: row.version, object: row.target_sha, type: 'commit' },
      () => github.request('POST', github.path('/git/tags'), { tag: row.version, message: row.version, object: row.target_sha, type: 'commit' }),
      async () => { const found = await this.checkedTag(github, row); return found ? { sha: found.object_sha } : null; }, redactor);
    const data = JSON.parse(row.data), taggedAt = data.tagged_at || new Date().toISOString();
    this.service.save(row, { tag_object_sha: object.sha, tagged_at: taggedAt });
    await this.effect(row, 'tag_ref', { ref: 'refs/tags/' + row.version, sha: object.sha },
      () => github.request('POST', github.path('/git/refs'), { ref: 'refs/tags/' + row.version, sha: object.sha }),
      async () => { const found = await this.checkedTag(github, row); return found ? { object: { sha: found.object_sha } } : null; }, redactor);
    existing = await this.checkedTag(github, row);
    if (!existing) return stop('release_write_unknown', 'write_unknown', '标签引用写入后仍不可见，请先查证。');
    this.service.save(row, { tag_object_sha: existing.object_sha, reused_tag: false, wait_started_at: Date.now() }, 'waiting_run');
  }
  pollLater(row: any, minimum = 0) {
    const data = JSON.parse(row.data), count = (data.poll_count || 0) + 1;
    this.service.save(row, { poll_count: count });
    this.service.store.run('UPDATE project_releases SET next_poll=? WHERE id=? AND lease=?', Date.now() + Math.max(minimum, Math.min(900_000, 15000 * 2 ** Math.min(count, 6))), row.id, row.lease);
  }
  async observeRun(github: GitHub, row: any, redactor: Redactor) {
    let data = JSON.parse(row.data);
    if (!data.run_id) {
      const candidates = (await actionPages(github, github.path(`/actions/workflows/${data.workflow_id}/runs?event=push&head_sha=${row.target_sha}`), 'workflow_runs'))
        .filter(run => matchesRun(row, run) && (data.reused_tag || Date.parse(run.created_at) >= Date.parse(data.tagged_at) - 5000));
      const unique = [...new Map(candidates.map(run => [run.id, run])).values()];
      if (unique.length > 1 || (unique.length && ambiguousBranch(data, row.version))) {
        this.service.save(row, { candidates: unique.map(r => ({ id: r.id, url: r.html_url })) });
        return stop('release_run_ambiguous', 'failed', 'Release 工作流关联不明确：存在多个候选，或同名分支也可触发。请检查候选 Actions 链接，不能自动推进草稿。');
      }
      if (!unique.length) {
        if (Date.now() - (data.wait_started_at || Date.parse(row.created_at)) > 30 * 60_000)
          return stop('release_run_missing', 'failed', '标签已存在，但没有找到该标签触发的 Release 工作流');
        this.service.save(row, { detail: '已打标签，等待 Release 工作流出现', actions_url: `https://github.com/${github.fullName}/actions/workflows/release.yml`, tag_url: `https://github.com/${github.fullName}/tree/${row.version}` }, 'waiting_run');
        this.pollLater(row); return;
      }
      const run = unique[0];
      this.service.save(row, { run_id: run.id, run_attempt: run.run_attempt, actions_url: run.html_url, poll_count: 0 }, 'running'); data = JSON.parse(row.data);
    }
    const { run, snapshot, success } = await runSnapshot(github, row);
    this.service.store.run('INSERT INTO release_attempts VALUES(?,?,?,?) ON CONFLICT(release_id,run_id,attempt) DO UPDATE SET data=excluded.data',
      row.id, run.id, run.run_attempt, JSON.stringify(redactor.clean(snapshot)));
    if (data.expected_attempt && run.run_attempt < data.expected_attempt) {
      this.service.save(row, { detail: `等待 Actions attempt 增加到 ${data.expected_attempt}，旧 attempt 不用于发布。` }, 'running'); this.pollLater(row); return;
    }
    this.service.save(row, redactor.clean({ run_attempt: run.run_attempt, run: snapshot, detail: '', error: null, failure_step: null }));
    if (success) {
      this.service.save(row, { ci_success: { run_id: run.id, attempt: run.run_attempt }, expected_attempt: null }, 'preparing_notes'); return;
    }
    if (run.status === 'completed') return stop('release_ci_unsuccessful', 'failed', `Release 工作流结论：${run.conclusion || 'unknown'}。${snapshot.jobs.length ? '只有当前 attempt 全部 job 成功才能生成草稿。' : '本次没有可读取的 job。'}不会自动重跑。`);
    this.pollLater(row);
  }
  async rerun(github: GitHub, row: any, redactor: Redactor) {
    const data = JSON.parse(row.data);
    if (!data.run_id || !data.run || data.run.status !== 'completed' || data.ci_success) return stop('release_rerun_unavailable', 'failed', '只有已绑定且未成功的 Actions run 可以人工重跑。');
    if (!await this.checkedTag(github, row)) return stop('release_tag_missing', 'failed', '标签已不存在，不能重跑。');
    const current = await runSnapshot(github, row);
    const from = data.run_attempt;
    if (current.run.run_attempt > from) {
      this.service.save(row, { expected_attempt: from + 1, ci_success: null, failure_step: null, error: null }, 'running'); return;
    }
    if (current.run.status !== 'completed') return stop('release_rerun_unavailable', 'failed', 'Actions 仍在运行，请先刷新。');
    // Persist the lower bound before sending. A lost response must never reuse the previous successful attempt.
    this.service.save(row, { expected_attempt: from + 1, ci_success: null, failure_step: 'rerun' });
    await this.effect(row, 'rerun:' + from, { run_id: data.run_id, from_attempt: from },
      () => github.request('POST', github.path(`/actions/runs/${data.run_id}/rerun`)),
      async () => { const run = await github.request('GET', github.path(`/actions/runs/${data.run_id}`)); if (!matchesRun(row, run)) return stop('release_run_changed', 'failed', '重跑的 Actions 身份已变化。'); return run.run_attempt > from ? { attempt: run.run_attempt } : null; }, redactor);
    this.service.save(row, { detail: '已请求人工重跑，等待新的 attempt。', error: null, failure_step: null }, 'running');
    this.service.store.run('UPDATE project_releases SET next_poll=0 WHERE id=?', row.id);
  }
  async ensureCI(github: GitHub, row: any) {
    const data = JSON.parse(row.data), current = await runSnapshot(github, row);
    if (!current.success || current.run.id !== data.ci_success?.run_id || current.run.run_attempt !== data.ci_success?.attempt || (data.expected_attempt && current.run.run_attempt < data.expected_attempt)) {
      this.service.save(row, { run: github.redactor.clean(current.snapshot), run_attempt: current.run.run_attempt, ci_success: null }, 'running');
      return stop('release_ci_evidence_changed', 'failed', 'Actions 当前 attempt 与成功证据不一致，已停止 Release 写入；请刷新本次运行。');
    }
  }
  async reconcileRerun(github: GitHub, row: any) {
    const data = JSON.parse(row.data), current = await runSnapshot(github, row), expected = data.expected_attempt;
    if (!expected) return fail(409, 'release_rerun_unavailable');
    if (current.run.run_attempt >= expected) {
      this.service.save(row, { error: null, failure_step: null, detail: '已查证新的 Actions attempt，继续读取本次运行。' }, 'running'); return;
    }
    const effect = this.service.store.get('SELECT state FROM release_effects WHERE id=?', row.id + ':rerun:' + (expected - 1));
    if (effect && ['inflight', 'unknown'].includes(effect.state)) return stop('release_write_unknown', 'write_unknown', '重跑请求结果尚未查明，未重复发送。请继续查询 attempt。');
    if (effect?.state === 'sent') { this.service.save(row, { error: null, failure_step: null, detail: '重跑请求已接受，等待新的 attempt。' }, 'running'); return; }
    this.service.save(row, { error: 'release_rerun_not_started', failure_step: 'rerun', detail: '已查证重跑请求未被接受；需要再次点击「重跑」，继续查询不会重跑 CI。' }, 'failed');
  }
  adopt(row: any, release: any, redactor: Redactor) {
    const data = JSON.parse(row.data), body = String(release.body || ''), hash = digest(body);
    this.service.save(row, { release_id: release.id, release_url: release.html_url, body: redactor.text(body), body_hash: hash,
      body_revision: hash === data.body_hash ? data.body_revision : (data.body_revision || 0) + 1, github_updated_at: release.updated_at,
      error: null, detail: release.draft ? '' : '已由仓库工作流／外部操作发布', failure_step: null }, release.draft ? 'draft' : 'externally_published');
  }
  async requireTag(github: GitHub, row: any) {
    if (!await this.checkedTag(github, row)) return stop('release_tag_missing', 'failed', '标签已不存在，不能创建或修改 Release。');
  }
  async prepareNotes(github: GitHub, row: any, redactor: Redactor) {
    await this.ensureCI(github, row); await this.requireTag(github, row);
    const data = JSON.parse(row.data), existing = await releases(github, row.version, data.release_id);
    if (existing) { this.adopt(row, existing, redactor); return; }
    const input = data.sources || await sources(github, row.target_sha, data.previous_tag);
    // Persist the fixed inputs even if model generation fails; retries use this exact source range.
    const sensitive = data.input_sensitive || redactor.contains(Buffer.from(JSON.stringify(input)));
    this.service.save(row, { sources: redactor.clean(input), input_sensitive: !!sensitive });
    if (sensitive) return stop('release_sensitive_body', 'failed', '发行说明来源包含已登记的密钥，已拒绝写入。');
    // The release.notes workflow groups the sources in the project computer; the release waits for its task.
    let groups = builtinGroups(input);
    if (notesUseModel(this.service.store, row, input)) {
      const store = this.service.store, task = data.notes_task ? store.get('SELECT * FROM tasks WHERE id=?', data.notes_task) : undefined;
      if (!task) {
        const queued = requestNotes(store, row, input, (data.notes_attempts || 0) + 1);
        this.service.save(row, { notes_task: queued.id, notes_attempts: (data.notes_attempts || 0) + 1 });
        store.run('UPDATE project_releases SET next_poll=? WHERE id=? AND lease=?', Date.now() + 5000, row.id, row.lease); return;
      }
      if (eventTaskActive(task) && /^model_/.test(String(task.error_code || ''))) {
        store.run("UPDATE tasks SET status='cancelled',error_code='release_notes_model_failed' WHERE id=?", task.id);
        return stop('release_notes_model_failed', 'failed', '发行说明模型请求失败，可人工重试发行说明步骤。');
      }
      if (task.status !== 'succeeded') return stop(task.error_code === 'release_notes_invalid' ? 'release_notes_invalid' : 'release_notes_model_failed', 'failed',
        task.error_code === 'release_notes_invalid' ? '发行说明分组无法核验。' : `发行说明整理没有完成（${task.error_code || task.status}），可人工重试发行说明步骤。`);
      groups = checkGroups(JSON.parse(task.result).groups, input);
    }
    const generated = renderNotes(row, input, groups, redactor);
    this.service.save(row, { body: generated.body, notes_input_hash: generated.input_hash, note_groups: generated.groups }, 'creating_draft');
  }
  async createDraft(github: GitHub, row: any, redactor: Redactor) {
    await this.ensureCI(github, row); await this.requireTag(github, row);
    const data = JSON.parse(row.data);
    if (redactor.contains(Buffer.from(data.body))) return stop('release_sensitive_body', 'failed', '发行说明包含已登记的密钥，已拒绝写入。');
    const request = { tag_name: row.version, name: row.version, body: data.body, draft: true, prerelease: prerelease(row.version) };
    const release = await this.effect(row, 'draft', request, () => github.request('POST', github.path('/releases'), request), () => releases(github, row.version, data.release_id), redactor);
    this.adopt(row, release, redactor);
  }
  async currentDraft(github: GitHub, row: any, redactor: Redactor, bodyRevision: unknown) {
    const data = JSON.parse(row.data);
    if (!data.release_id) return fail(409, 'release_draft_missing');
    const remote = await releases(github, row.version, data.release_id);
    if (!remote || remote.id !== data.release_id) return fail(409, 'release_draft_changed');
    if (!remote.draft) { this.adopt(row, remote, redactor); return null; }
    if (digest(String(remote.body || '')) !== data.body_hash || bodyRevision !== data.body_revision) {
      this.adopt(row, remote, redactor); return fail(409, 'release_body_conflict');
    }
    return remote;
  }
  async saveDraft(github: GitHub, row: any, body: string, bodyRevision: unknown, redactor: Redactor) {
    if (row.stage !== 'draft') return fail(409, 'release_not_draft');
    if (redactor.contains(Buffer.from(body))) return fail(400, 'release_sensitive_body');
    await this.requireTag(github, row);
    const remote = await this.currentDraft(github, row, redactor, bodyRevision); if (!remote) return;
    const data = JSON.parse(row.data);
    const key = 'save:' + data.body_revision + ':' + digest(body);
    this.service.save(row, { pending_save: { key, body_hash: digest(body) } });
    const saved = await this.effect(row, key, { release_id: remote.id, body_hash: digest(body) },
      () => github.request('PATCH', github.path('/releases/' + remote.id), { body }),
      async () => {
        const current = await releases(github, row.version, remote.id);
        if (!current || current.id !== remote.id) return fail(409, 'release_draft_changed');
        if (!current.draft) { this.adopt(row, current, redactor); return fail(409, 'release_not_draft'); }
        if (current.body === body) return current;
        if (digest(String(current.body || '')) !== data.body_hash) { this.adopt(row, current, redactor); return fail(409, 'release_body_conflict'); }
        return null;
      }, redactor);
    this.adopt(row, saved, redactor);
  }
  async reconcileSave(github: GitHub, row: any, redactor: Redactor) {
    await this.requireTag(github, row);
    const data = JSON.parse(row.data), remote = await releases(github, row.version, data.release_id);
    if (!remote || remote.id !== data.release_id) return fail(409, 'release_draft_changed');
    if (!remote.draft) { this.adopt(row, remote, redactor); return; }
    const effect = data.pending_save && this.service.store.get('SELECT * FROM release_effects WHERE id=?', row.id + ':' + data.pending_save.key);
    if (effect && ['inflight', 'unknown'].includes(effect.state)) {
      if (digest(String(remote.body || '')) !== data.pending_save.body_hash) return stop('release_write_unknown', 'write_unknown', '保存正文的结果尚未确认，未重复发送或覆盖外部正文。');
      this.service.store.run("UPDATE release_effects SET state='sent',response=? WHERE id=?", JSON.stringify(redactor.clean(remote)), effect.id);
    }
    this.adopt(row, remote, redactor);
  }
  async publish(github: GitHub, row: any, actorId: string, bodyRevision: unknown, redactor: Redactor) {
    const data = JSON.parse(row.data);
    if (row.stage !== 'draft' && !(data.failure_step === 'publishing' && ['write_unknown', 'waiting_permission', 'failed', 'publishing'].includes(row.stage))) return fail(409, 'release_not_draft');
    await this.requireTag(github, row); await this.ensureCI(github, row);
    const remote = await this.currentDraft(github, row, redactor, bodyRevision); if (!remote) return;
    if (redactor.contains(Buffer.from(String(remote.body || '')))) return fail(400, 'release_sensitive_body');
    this.service.save(row, { publish_actor: actorId, publish_requested_at: new Date().toISOString(), failure_step: 'publishing' }, 'publishing');
    const request = { draft: false, prerelease: prerelease(row.version) };
    const result = await this.effect(row, 'publish', { release_id: remote.id, ...request },
      async () => ({ ...await github.request('PATCH', github.path('/releases/' + remote.id), request), control_response: true }),
      async () => {
        const current = await releases(github, row.version, remote.id);
        if (!current || current.id !== remote.id) return fail(409, 'release_draft_changed');
        if (current.draft) {
          if (digest(String(current.body || '')) !== data.body_hash) { this.adopt(row, current, redactor); return fail(409, 'release_body_conflict'); }
          return null;
        }
        const effect = this.service.store.get('SELECT state FROM release_effects WHERE id=?', row.id + ':publish');
        return { ...current, external: !effect || effect.state === 'pending' };
      }, redactor);
    if (result.id !== remote.id || result.tag_name !== row.version || result.draft !== false || result.prerelease !== prerelease(row.version))
      return stop('release_write_unknown', 'write_unknown', '正式发布响应与本次 Release 或预发布标记不一致，请先查证。');
    this.adopt(row, result, redactor);
    if (!result.external) this.service.save(row, { detail: '已人工确认正式发布', published_at: new Date().toISOString(), publication_confirmation: result.control_response ? 'response' : 'remote_after_request' }, 'published');
  }
  async reconcilePublish(github: GitHub, row: any, redactor: Redactor) {
    // Recovery is read-only. Persisted intent can justify checking the result, never another draft=false request.
    const data = JSON.parse(row.data), remote = await releases(github, row.version, data.release_id);
    if (!remote || remote.id !== data.release_id) return stop('release_write_unknown', 'write_unknown', '无法查证正式发布结果，请检查原 Release。');
    const effect = this.service.store.get('SELECT state FROM release_effects WHERE id=?', row.id + ':publish');
    if (!remote.draft) {
      this.adopt(row, remote, redactor);
      if (effect && ['inflight', 'unknown', 'sent'].includes(effect.state)) {
        this.service.store.run("UPDATE release_effects SET state='sent',response=? WHERE id=?", JSON.stringify(redactor.clean(remote)), row.id + ':publish');
        this.service.save(row, { detail: '已核实人工发布请求后的正式 Release', published_at: new Date().toISOString(), publication_confirmation: 'remote_after_request' }, 'published');
      }
      return;
    }
    if (effect && ['inflight', 'unknown'].includes(effect.state)) return stop('release_write_unknown', 'write_unknown', '正式发布请求结果尚未确认，未再次发送；可以继续查询。');
    this.adopt(row, remote, redactor);
    this.service.save(row, { detail: '上一次正式发布未确认成功，请重新点击正式发布。' }, 'draft');
  }
}
