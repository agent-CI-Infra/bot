import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store, Row } from '../storage/database.js';
import type { GitCache } from '../agent/git-cache.js';
import type { Workspace } from '../agent/workspace.js';
import { GitHub } from '../github/client.js';
import {
  HEX40,
  MAX_BLOB_SCAN_BYTES,
  ZERO40,
  checkedGit,
  hasCommit,
  inspectBlobSizes,
  isAncestor,
  listTreeFiles,
  makeGitHttpEnv,
  parseRawDiffZ,
  resolveTaskBotBranch,
  runGit,
  scanBlobStreaming,
  validateCloneUrl,
  type DiffRawEntry,
} from '../github/git-push.js';
import { Redactor, safePath, stop, TaskError } from '../agent/common.js';
import { registeredRedactor } from '../core/redaction.js';
import { randomId } from '../core/security.js';
import { RUNNER_TRANSFER_CHUNK_BYTES } from '../agent/command.js';
import { blobValue } from '../storage/payloads.js';
import { isWorkflowPath, workflowsPermissionMissingDetail } from '../github/workflow-changes.js';
import { evaluateDelivery, isTestFixturePath } from './acceptance.js';
import { assertRequestPullRequest, genericTask, pullRequestRefusal, requestPolicyHash } from './pull-request.js';
import { pullRequestQaRequired } from './grants.js';
import { resolveExpectedWorkspaceHead } from './delivery-context.js';
import { withTaskSsh } from './ssh-context.js';
import { publicationFact } from './publication.js';
import { TaskRecords, type Verdict } from './service.js';
import { syncBotPullRequestState } from '../review/bot-pr-wake.js';

const MAX_COMMITS_PER_PUSH = 500;
const MAX_TEXT_SCAN_BYTES = 2 * 1024 * 1024;
const dirtyPathPattern = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]+)?|\.DS_Store|node_modules|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key))(?:\/|$)/i;

export interface PushGateQaReceipt {
  head_sha: string;
  tree_sha: string;
  policy_hash: string;
  verdict: Verdict;
  candidate_id: string;
}

export interface PushBranchParams {
  store: Store;
  task: Row;
  input: any;
  workspace: Workspace;
  redactor: Redactor;
  guard: () => Promise<void>;
  log: (value: any) => void;
  apiUrl?: string;
  gitCache?: GitCache;
  budgetRole: string;
  args: any;
  execution: string;
  previousQaPass?: PushGateQaReceipt | null;
  skipGates?: boolean;
}

export async function pushBranchFromWorkspace(params: PushBranchParams): Promise<Record<string, any>> {
  const { store, task, input, workspace, redactor, guard, log, apiUrl, gitCache, budgetRole, args, execution, previousQaPass, skipGates } = params;
  await guard();

  // 1. Validate arguments
  if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args))) {
    return { error: 'invalid_arguments', detail: 'push_bot_branch expects an object argument.' };
  }
  const argObj = (args ?? {}) as Record<string, unknown>;
  const allowedKeys = new Set(['branch', 'head_ref', 'force_with_lease', 'expected_remote_sha', 'test_command', 'summary']);
  if (Object.keys(argObj).some(k => !allowedKeys.has(k))) {
    return { error: 'invalid_arguments', detail: 'push_bot_branch received unknown arguments.' };
  }
  const requestedBranch = argObj.branch === undefined ? undefined : String(argObj.branch);
  const headRef = argObj.head_ref === undefined ? undefined : String(argObj.head_ref).trim();
  const forceWithLease = argObj.force_with_lease === true;
  const expectedRemoteShaArg = argObj.expected_remote_sha === undefined ? undefined : String(argObj.expected_remote_sha).trim().toLowerCase();
  const agentTestCommand = typeof argObj.test_command === 'string' && argObj.test_command.trim() ? argObj.test_command.trim().slice(0, 500) : null;
  const pushSummary = typeof argObj.summary === 'string' && argObj.summary.trim() ? argObj.summary.trim().slice(0, 4000) : null;

  if (headRef !== undefined && (!headRef || headRef.length > 200 || headRef.startsWith('-') || /[\0\r\n\s]/.test(headRef))) {
    return { error: 'invalid_arguments', detail: 'head_ref must be a valid local Git ref or commit SHA.' };
  }
  if (expectedRemoteShaArg !== undefined && expectedRemoteShaArg !== '' && !HEX40.test(expectedRemoteShaArg)) {
    return { error: 'invalid_arguments', detail: 'expected_remote_sha must be a 40-hex commit SHA or "" (for a new branch).' };
  }

  // 2. Enforce task pull_request grant & capability ceiling
  if (genericTask(task)) {
    const refusal = pullRequestRefusal(store, task);
    if (refusal) {
      return {
        error: refusal.code,
        tool: 'push_bot_branch',
        missing: refusal.missing,
        detail: refusal.message,
      };
    }
  } else {
    assertRequestPullRequest(store, task);
  }

  // 3. Inspect workspace commit & working tree cleanliness
  const inspect = await workspace.call(`push:inspect:${randomId()}`, {
    type: 'workspace_git_inspect',
    ...(headRef ? { ref: headRef } : {}),
  });
  if (inspect?.error) {
    return { error: 'workspace_git_inspect_failed', detail: String(inspect.detail || inspect.error) };
  }
  if (inspect.is_worktree === false) {
    return {
      error: 'git_history_unavailable',
      detail: 'This task checkout is a file-copy snapshot without upstream Git history, so real git push cannot run. Use open_pull_request to deliver from this checkout.',
    };
  }
  if (Array.isArray(inspect.unmerged_files) && inspect.unmerged_files.length) {
    return {
      error: 'unmerged_index',
      files: inspect.unmerged_files,
      detail: `Workspace has unresolved merge conflicts in index (${inspect.unmerged_files.slice(0, 10).join(', ')}). Resolve conflicts and commit before calling push_bot_branch.`,
    };
  }
  if (Array.isArray(inspect.tracked_dirty_files) && inspect.tracked_dirty_files.length) {
    return {
      error: 'uncommitted_tracked_changes',
      files: inspect.tracked_dirty_files,
      detail: `Workspace has uncommitted tracked/staged changes (${inspect.tracked_dirty_files.slice(0, 10).join(', ')}). Commit or discard them so the pushed Git commit matches your tested workspace.`,
    };
  }
  const headSha = String(inspect.head_sha || '').toLowerCase();
  const treeSha = String(inspect.tree_sha || '').toLowerCase();
  if (!HEX40.test(headSha) || !HEX40.test(treeSha)) {
    return { error: 'workspace_git_inspect_failed', detail: 'Workspace did not report valid commit/tree SHAs.' };
  }

  const repoId = String(task.repository_id);
  const repo = store.get('SELECT * FROM repositories WHERE id=?', repoId)!;
  const github = new GitHub(store, repo, redactor, guard, apiUrl);
  github.purpose = 'git_push';

  const stageBase = gitCache?.root || tmpdir();
  const stageDir = join(stageBase, `push-stage-${randomId()}.git`);
  const packFile = join(stageBase, `push-pack-${randomId()}.pack`);
  let stageCreated = false;

  try {
    // 4. Connect read-only GitHub client to inspect remote refs, base branch, and installation permissions
    await github.connect(false, undefined, { contents: 'read', issues: 'read', pull_requests: 'read' });
    const cloneUrl = validateCloneUrl(github.cloneUrl);
    if (!cloneUrl) {
      return {
        error: 'git_push_unavailable',
        detail: 'Repository clone_url is unavailable for direct git push; use open_pull_request instead.',
      };
    }

    const baseBranch = String(input?.base_branch || github.defaultBranch).trim() || github.defaultBranch;
    const resolvedBranch = resolveTaskBotBranch(store, task, input, requestedBranch, github.defaultBranch, baseBranch);
    if (!resolvedBranch.ok) {
      return { error: resolvedBranch.error, detail: resolvedBranch.detail };
    }
    const { branch, ownerTaskId, existingPr } = resolvedBranch;

    const candidatePrNumber = existingPr ? Number(existingPr.number) : (Number.isSafeInteger(Number(input?.bot_pr?.number)) ? Number(input.bot_pr.number) : null);
    const [remoteBranchRef, remoteBaseRef, liveExistingPr] = await Promise.all([
      github.ref(branch),
      github.ref(baseBranch),
      candidatePrNumber
        ? github.request('GET', github.path('/pulls/' + candidatePrNumber), undefined, true).catch(() => null)
        : Promise.resolve(null),
    ]);
    const remoteHeadSha = HEX40.test(String(remoteBranchRef?.object?.sha || '')) ? String(remoteBranchRef.object.sha).toLowerCase() : null;
    const remoteBaseSha = HEX40.test(String(remoteBaseRef?.object?.sha || '')) ? String(remoteBaseRef.object.sha).toLowerCase() : null;

    if (expectedRemoteShaArg !== undefined) {
      if (expectedRemoteShaArg === '' && remoteHeadSha !== null) {
        return {
          error: 'branch_head_changed',
          branch,
          expected_remote_sha: '',
          actual_remote_sha: remoteHeadSha,
          detail: `Expected branch "${branch}" not to exist, but remote head is ${remoteHeadSha}.`,
        };
      }
      if (expectedRemoteShaArg !== '' && remoteHeadSha !== expectedRemoteShaArg) {
        return {
          error: 'branch_head_changed',
          branch,
          expected_remote_sha: expectedRemoteShaArg,
          actual_remote_sha: remoteHeadSha,
          detail: `Remote head of "${branch}" is ${remoteHeadSha ?? 'missing'}, expected ${expectedRemoteShaArg}.`,
        };
      }
    }

    let existingPrNumber = candidatePrNumber;
    let closedPrNumber: number | null = null;
    if (candidatePrNumber && liveExistingPr && Number(liveExistingPr.number) === candidatePrNumber) {
      if (store.hasTable('bot_pull_requests') && store.get('SELECT 1 FROM bot_pull_requests WHERE repository_id=? AND number=?', repoId, candidatePrNumber)) {
        syncBotPullRequestState(store, repoId, liveExistingPr);
      }
      if (String(liveExistingPr.state || '').toLowerCase() !== 'open') {
        existingPrNumber = null;
        closedPrNumber = candidatePrNumber;
      }
    } else if (candidatePrNumber && store.hasTable('bot_pr_states')) {
      const localState = store.get('SELECT state FROM bot_pr_states WHERE repository_id=? AND number=?', repoId, candidatePrNumber);
      if (localState && String(localState.state || '').toLowerCase() === 'closed') {
        existingPrNumber = null;
        closedPrNumber = candidatePrNumber;
      }
    }
    const existingPrUrl = !existingPrNumber
      ? null
      : (typeof liveExistingPr?.html_url === 'string' && liveExistingPr.html_url
          ? liveExistingPr.html_url
          : store.hasTable('bot_pr_states')
            ? (store.get('SELECT html_url FROM bot_pr_states WHERE repository_id=? AND number=?', repoId, existingPrNumber)?.html_url ?? (typeof input?.bot_pr?.html_url === 'string' ? input.bot_pr.html_url : null))
            : (typeof input?.bot_pr?.html_url === 'string' ? input.bot_pr.html_url : null));

    const expectedHead = resolveExpectedWorkspaceHead(task, input);
    const activeConflictBaseSha = HEX40.test(String(input?.conflict_base_sha || ''))
      ? String(input.conflict_base_sha).toLowerCase()
      : (input?.bot_pr && (input.bot_pr.mergeable === false || String(input.bot_pr.mergeable_state || '').toLowerCase() === 'dirty') && HEX40.test(String(input?.base_ref_sha || input.bot_pr.base?.sha || ''))
        ? String(input.base_ref_sha || input.bot_pr.base?.sha).toLowerCase()
        : null);
    const validAncestors = [...new Set([
      expectedHead,
      remoteBaseSha,
      HEX40.test(String(input?.base_ref_sha || '')) ? String(input.base_ref_sha).toLowerCase() : null,
      HEX40.test(String(input?.bot_pr?.base?.sha || '')) ? String(input.bot_pr.base.sha).toLowerCase() : null,
      activeConflictBaseSha,
    ].filter((s): s is string => !!s && HEX40.test(s)))];

    if (remoteHeadSha && remoteHeadSha === headSha) {
      // Prove baseline ancestry & conflict integration against the control-plane mirror even on already_up_to_date
      // (for example when a resumed/retried execution re-calls push_bot_branch on a commit pushed by an earlier run).
      let upToDateAncestryVerified = false;
      let upToDateFiles: Array<{ path: string; mode: string; sha: string; size: number }> | null = null;
      if (gitCache) {
        const upToDateCommits = [...new Set([headSha, ...validAncestors])];
        const mirror = await gitCache.open(repoId, {
          url: cloneUrl.href,
          token: github.token,
          commits: upToDateCommits,
          refs: [
            `refs/heads/${baseBranch}`,
            `refs/heads/${branch}`,
            ...(existingPrNumber ? [`refs/pull/${existingPrNumber}/head`] : []),
          ],
        }).catch(() => null);
        if (mirror?.has(headSha)) {
          const mirrorDir = gitCache.path(repoId);
          const mirrorTreeSha = (await runGit(['rev-parse', '--verify', '--quiet', headSha + '^{tree}'], { cwd: mirrorDir })).stdout.toString('utf8').trim().toLowerCase();
          if (mirrorTreeSha === treeSha) {
            const presentAncestors: string[] = [];
            for (const candidateAnc of validAncestors) {
              if (await hasCommit(mirrorDir, candidateAnc)) presentAncestors.push(candidateAnc);
            }
            if (validAncestors.length) {
              const baselineLabel = (expectedHead || remoteBaseSha || validAncestors[0] || '').slice(0, 12) || 'unknown';
              if (!presentAncestors.length) {
                return {
                  error: 'baseline_ancestry_unverifiable',
                  expected_head_sha: expectedHead ?? remoteBaseSha ?? validAncestors[0] ?? null,
                  workspace_head_sha: headSha,
                  base_branch: baseBranch,
                  base_sha: remoteBaseSha,
                  detail: `Remote branch "${branch}" is already at ${headSha.slice(0, 12)}, but no baseline commit (${baselineLabel} on "${baseBranch}") could be resolved in the control-plane mirror to prove ancestry.`,
                };
              }
              let rootedOnBaseline = false;
              for (const anc of presentAncestors) {
                if (await isAncestor(mirrorDir, anc, headSha)) {
                  rootedOnBaseline = true;
                  break;
                }
              }
              if (!rootedOnBaseline) {
                return {
                  error: 'workspace_head_drifted',
                  expected_head_sha: expectedHead ?? remoteBaseSha ?? presentAncestors[0] ?? null,
                  workspace_head_sha: headSha,
                  base_branch: baseBranch,
                  detail: `Commit ${headSha.slice(0, 12)} on "${branch}" does not descend from the task baseline (${baselineLabel} on "${baseBranch}"). Restore the task baseline or rebase onto "${baseBranch}" before pushing.`,
                };
              }
              upToDateAncestryVerified = true;
            }
            if (activeConflictBaseSha && existingPrNumber) {
              const hasConflictBase = await hasCommit(mirrorDir, activeConflictBaseSha);
              if (!hasConflictBase || !await isAncestor(mirrorDir, activeConflictBaseSha, headSha)) {
                return {
                  error: 'conflict_not_integrated',
                  conflict_base_sha: activeConflictBaseSha,
                  base_branch: baseBranch,
                  head_sha: headSha,
                  detail: `Bot PR #${existingPrNumber} has a merge conflict against "${baseBranch}" (${activeConflictBaseSha.slice(0, 12)}), which is not an ancestor of ${headSha.slice(0, 12)}. Merge or rebase onto ${activeConflictBaseSha} first, resolve conflicts, verify tests, and retry push_bot_branch.`,
                };
              }
            }
            upToDateFiles = await listTreeFiles(mirrorDir, headSha).catch(() => null);
          }
        }
      }
      if (validAncestors.length && !upToDateAncestryVerified) {
        const baselineLabel = (expectedHead || remoteBaseSha || validAncestors[0] || '').slice(0, 12) || 'unknown';
        return {
          error: 'baseline_ancestry_unverifiable',
          expected_head_sha: expectedHead ?? remoteBaseSha ?? validAncestors[0] ?? null,
          workspace_head_sha: headSha,
          base_branch: baseBranch,
          base_sha: remoteBaseSha,
          detail: `Remote branch "${branch}" is already at ${headSha.slice(0, 12)}, but baseline ancestry against ${baselineLabel} on "${baseBranch}" could not be verified in the control-plane mirror.`,
        };
      }
      return {
        ok: true,
        already_up_to_date: true,
        branch,
        remote_sha: headSha,
        head_sha: headSha,
        tree_sha: treeSha,
        base_branch: baseBranch,
        base_sha: remoteBaseSha,
        commits_pushed: 0,
        forced: false,
        commit_ancestry_verified: upToDateAncestryVerified,
        workflow_files: [],
        existing_pr_number: existingPrNumber,
        existing_pr_url: existingPrUrl,
        ...(closedPrNumber ? { closed_pr_number: closedPrNumber } : {}),
        ...(upToDateFiles ? { _pushed_files: upToDateFiles } : {}),
        next_step: existingPrNumber
          ? `Remote branch "${branch}" is already at ${headSha}. If PR #${existingPrNumber} needs updated title/body or a reply, use github_write, then call submit_report.`
          : `Remote branch "${branch}" is already at ${headSha}${closedPrNumber ? ` (previous PR #${closedPrNumber} is closed)` : ''}. Open a PR with github_write POST /pulls { head: "${branch}", base: "${baseBranch}", title, body }, then call submit_report.`,
      };
    }

    if (!remoteHeadSha && remoteBaseSha && headSha === remoteBaseSha) {
      return {
        error: 'no_commits_to_push',
        branch,
        head_sha: headSha,
        base_branch: baseBranch,
        base_sha: remoteBaseSha,
        detail: `Local HEAD (${headSha.slice(0, 12)}) equals base branch "${baseBranch}". Create at least one commit before calling push_bot_branch.`,
      };
    }

    // 5. Refresh control-plane mirror so thin pack transfer only moves newly created objects
    const mirrorCommits = [...new Set([remoteBaseSha, remoteHeadSha, expectedHead, activeConflictBaseSha].filter((s): s is string => !!s && HEX40.test(s)))];
    if (gitCache && mirrorCommits.length) {
      await gitCache.open(repoId, {
        url: cloneUrl.href,
        token: github.token,
        commits: mirrorCommits,
        refs: [
          `refs/heads/${baseBranch}`,
          ...(remoteHeadSha ? [`refs/heads/${branch}`] : []),
          ...(existingPrNumber ? [`refs/pull/${existingPrNumber}/head`] : []),
        ],
      }).catch(() => null);
    }

    const mirrorObjects = gitCache ? await gitCache.mirrorObjectsDir(repoId) : null;
    const haveCommits = gitCache ? await gitCache.haveCommits(repoId, 500) : [];

    // 6. Stream thin git pack from container workspace into control-plane temp pack file
    await mkdir(stageBase, { recursive: true, mode: 0o700 });
    const packId = randomId();
    const packOut = await open(packFile, 'w', 0o600);
    try {
      let offset = 0;
      for (;;) {
        const chunk = await workspace.deliver({
          type: 'workspace_git_export_pack',
          sha: headSha,
          pack_id: packId,
          offset,
          limit: RUNNER_TRANSFER_CHUNK_BYTES,
          ...(offset === 0 && haveCommits.length ? { have_commits: haveCommits } : {}),
        });
        if (chunk?.error) {
          return { error: 'git_pack_export_failed', detail: String(chunk.detail || chunk.error) };
        }
        const buf = Buffer.from(String(chunk.base64 || ''), 'base64');
        if (buf.length) {
          await packOut.write(buf);
          offset += buf.length;
        }
        if (chunk.done || buf.length === 0) break;
      }
    } finally {
      await packOut.close();
    }

    // 7. Unpack into isolated bare staging repo (with read-only mirror alternates) and verify object integrity
    await checkedGit(['init', '--bare', '--quiet', stageDir], stageBase);
    stageCreated = true;
    if (mirrorObjects) {
      await mkdir(join(stageDir, 'objects', 'info'), { recursive: true, mode: 0o700 });
      await writeFile(join(stageDir, 'objects', 'info', 'alternates'), mirrorObjects + '\n', { mode: 0o600 });
    }
    const packRead = await open(packFile, 'r');
    let indexed;
    try {
      indexed = await runGit(['index-pack', '--stdin', '--fix-thin', '--strict'], { cwd: stageDir, inputFd: packRead.fd });
    } finally {
      await packRead.close();
    }
    if (indexed.code !== 0) {
      return {
        error: 'git_pack_invalid',
        detail: `Control plane rejected Git pack from workspace: ${redactor.text(indexed.stderr.trim() || 'exit ' + indexed.code).slice(0, 1000)}`,
      };
    }

    if (!await hasCommit(stageDir, headSha)) {
      return { error: 'git_pack_invalid', detail: `Exported pack does not contain commit ${headSha}.` };
    }
    const stagedTreeSha = (await checkedGit(['rev-parse', '--verify', '--quiet', headSha + '^{tree}'], stageDir)).toString('utf8').trim().toLowerCase();
    if (stagedTreeSha !== treeSha) {
      return { error: 'git_pack_invalid', detail: `Staged commit tree mismatch: expected ${treeSha}, actual ${stagedTreeSha}.` };
    }

    // 8. Check fast-forward, force_with_lease, baseline ancestry (HEAD drift), and conflict base integration
    let forced = false;
    if (remoteHeadSha) {
      const ff = await isAncestor(stageDir, remoteHeadSha, headSha);
      if (!ff) {
        if (!forceWithLease) {
          return {
            error: 'non_fast_forward',
            branch,
            remote_sha: remoteHeadSha,
            head_sha: headSha,
            detail: `Commit ${headSha.slice(0, 12)} is not a fast-forward descendant of remote branch "${branch}" (${remoteHeadSha.slice(0, 12)}). Pass force_with_lease: true only if you intentionally rebased this bot branch, or integrate the remote commits first.`,
          };
        }
        forced = true;
      }
    }

    const presentAncestors: string[] = [];
    for (const candidateAnc of validAncestors) {
      if (await hasCommit(stageDir, candidateAnc)) presentAncestors.push(candidateAnc);
    }
    let commitAncestryVerified = false;
    if (validAncestors.length) {
      const baselineLabel = (expectedHead || remoteBaseSha || validAncestors[0] || '').slice(0, 12) || 'unknown';
      if (!presentAncestors.length) {
        return {
          error: 'baseline_ancestry_unverifiable',
          expected_head_sha: expectedHead ?? remoteBaseSha ?? validAncestors[0] ?? null,
          workspace_head_sha: headSha,
          base_branch: baseBranch,
          base_sha: remoteBaseSha,
          detail: `Could not resolve any baseline commit (${baselineLabel} on "${baseBranch}") in the staging repository, so baseline ancestry for ${headSha.slice(0, 12)} cannot be verified (unrelated/orphan history or missing baseline commit). Refuse push fail-closed; restore or rebase onto "${baseBranch}" and retry.`,
        };
      }
      let rootedOnBaseline = false;
      for (const anc of presentAncestors) {
        if (await isAncestor(stageDir, anc, headSha)) {
          rootedOnBaseline = true;
          break;
        }
      }
      if (!rootedOnBaseline) {
        return {
          error: 'workspace_head_drifted',
          expected_head_sha: expectedHead ?? remoteBaseSha ?? presentAncestors[0] ?? null,
          workspace_head_sha: headSha,
          base_branch: baseBranch,
          detail: `Commit ${headSha.slice(0, 12)} does not descend from the task baseline (${baselineLabel} on "${baseBranch}"). Restore the task baseline or rebase onto "${baseBranch}" before pushing.`,
        };
      }
      commitAncestryVerified = true;
    }

    if (activeConflictBaseSha && existingPrNumber) {
      const hasConflictBase = await hasCommit(stageDir, activeConflictBaseSha);
      if (!hasConflictBase || !await isAncestor(stageDir, activeConflictBaseSha, headSha)) {
        return {
          error: 'conflict_not_integrated',
          conflict_base_sha: activeConflictBaseSha,
          base_branch: baseBranch,
          head_sha: headSha,
          detail: `Bot PR #${existingPrNumber} has a merge conflict against "${baseBranch}" (${activeConflictBaseSha.slice(0, 12)}), which is not an ancestor of ${headSha.slice(0, 12)}. Merge or rebase onto ${activeConflictBaseSha} first, resolve conflicts, verify tests, and retry push_bot_branch.`,
        };
      }
    }

    // 9. Enumerate all commits in the push range and scan every touched path + introduced blob on the control plane
    const notCommits: string[] = [];
    for (const stopSha of [...new Set([remoteHeadSha, remoteBaseSha, expectedHead].filter((s): s is string => !!s && HEX40.test(s)))]) {
      if (await hasCommit(stageDir, stopSha)) notCommits.push(stopSha);
    }
    const revArgs = ['rev-list', '--topo-order', headSha, ...(notCommits.length ? ['--not', ...notCommits] : [])];
    const commitsToPush = (await checkedGit(revArgs, stageDir)).toString('utf8').split('\n').map(s => s.trim()).filter(s => HEX40.test(s));
    if (commitsToPush.length > MAX_COMMITS_PER_PUSH) {
      return {
        error: 'too_many_commits',
        count: commitsToPush.length,
        limit: MAX_COMMITS_PER_PUSH,
        detail: `Push range contains ${commitsToPush.length} commits (limit ${MAX_COMMITS_PER_PUSH}). Squash or check your branch base before pushing.`,
      };
    }

    const workflowSet = new Set<string>();
    const dirtySet = new Set<string>();
    const unsafePaths: string[] = [];
    const blobPaths = new Map<string, Set<string>>();

    const recordDiffEntries = (entries: DiffRawEntry[], collectBlobs: boolean) => {
      for (const entry of entries) {
        const pathsToCheck = [entry.path, ...(entry.oldPath ? [entry.oldPath] : [])];
        for (const p of pathsToCheck) {
          try {
            safePath(p);
          } catch {
            unsafePaths.push(p);
            continue;
          }
          if (isWorkflowPath(p)) workflowSet.add(p);
          if (entry.status !== 'D' && p === entry.path && dirtyPathPattern.test(p)) dirtySet.add(p);
        }
        if (collectBlobs && entry.status !== 'D' && entry.newSha && entry.newSha !== ZERO40 && entry.newMode !== '160000' && HEX40.test(entry.newSha)) {
          let set = blobPaths.get(entry.newSha);
          if (!set) blobPaths.set(entry.newSha, set = new Set());
          set.add(entry.path);
        }
      }
    };

    for (const cSha of commitsToPush) {
      const diffBuf = await checkedGit(['diff-tree', '-r', '--root', '--no-commit-id', '--raw', '--no-abbrev', '-z', '-m', '--first-parent', cSha], stageDir);
      recordDiffEntries(parseRawDiffZ(diffBuf), true);
    }

    const finalChangedBlobs = new Map<string, Set<string>>();
    const netBase = remoteBaseSha && await hasCommit(stageDir, remoteBaseSha)
      ? remoteBaseSha
      : (remoteHeadSha && await hasCommit(stageDir, remoteHeadSha) ? remoteHeadSha : null);
    if (netBase) {
      const mbRun = await runGit(['merge-base', netBase, headSha], { cwd: stageDir });
      const compareFrom = mbRun.code === 0 && HEX40.test(mbRun.stdout.toString('utf8').trim())
        ? mbRun.stdout.toString('utf8').trim()
        : netBase;
      const netBuf = await checkedGit(['diff', '--raw', '--no-abbrev', '-r', '-z', compareFrom, headSha], stageDir);
      const netEntries = parseRawDiffZ(netBuf);
      recordDiffEntries(netEntries, true);
      for (const entry of netEntries) {
        if (entry.status !== 'D' && entry.newSha && entry.newSha !== ZERO40 && entry.newMode !== '160000' && HEX40.test(entry.newSha)) {
          let set = finalChangedBlobs.get(entry.newSha);
          if (!set) finalChangedBlobs.set(entry.newSha, set = new Set());
          set.add(entry.path);
        }
      }
    } else {
      for (const [blob, paths] of blobPaths) finalChangedBlobs.set(blob, paths);
    }

    const fullRedactor = registeredRedactor(store);
    for (const secret of redactor.values) fullRedactor.add(secret);
    const scanNeedles = [...fullRedactor.values]
      .filter(value => typeof value === 'string' && value.trim().length >= 8)
      .map(value => Buffer.from(value));

    const issues: string[] = [];
    for (const p of unsafePaths.slice(0, 20)) issues.push(`Unsafe repository path in commit: ${p}`);
    for (const p of [...dirtySet].sort().slice(0, 20)) issues.push(`Forbidden or dirty file in commit history: ${p} (remove .env, private keys, .DS_Store, or node_modules).`);

    const blobSizes = await inspectBlobSizes(stageDir, [...blobPaths.keys()]);
    for (const [bSha, paths] of blobPaths) {
      const pathList = [...paths].sort();
      const size = blobSizes.get(bSha.toLowerCase());
      if (size === undefined) {
        issues.push(`Unable to verify blob size for ${pathList.join(', ')} (${bSha.slice(0, 12)}).`);
        continue;
      }
      if (size > MAX_BLOB_SCAN_BYTES) {
        issues.push(`Blob in ${pathList.join(', ')} (${bSha.slice(0, 12)}) exceeds the ${Math.round(MAX_BLOB_SCAN_BYTES / (1024 * 1024))} MiB single-file push limit (${size} bytes).`);
        continue;
      }
      const nonTest = pathList.filter(p => !isTestFixturePath(p));
      const scanned = await scanBlobStreaming(stageDir, bSha, size, {
        needles: scanNeedles,
        maxTextBytes: MAX_TEXT_SCAN_BYTES,
        checkPrivateKey: nonTest.length > 0,
        checkConflictMarkers: finalChangedBlobs.has(bSha),
      });
      if (scanned.secretHit) {
        issues.push(`Registered secret/credential leaked in ${pathList.join(', ')} (blob ${bSha.slice(0, 12)}).`);
        continue;
      }
      if (scanned.privateKeyHit) {
        issues.push(`Private key block found in ${nonTest.join(', ')}.`);
      }
      if (scanned.conflictMarkerHit) {
        issues.push(`Unresolved Git merge conflict markers found in ${pathList.join(', ')}.`);
      }
    }

    if (issues.length) {
      return {
        error: 'push_preflight_failed',
        issues: [...new Set(issues)],
        detail: `Control-plane security/hygiene scan refused the push (${issues.length} issue(s)). Fix the commits (remove leaked secrets/dirty files from history if needed) and retry push_bot_branch.`,
      };
    }

    const workflowFiles = [...workflowSet].sort();

    // 10. Check `.github/workflows/` installation authorization BEFORE running expensive gates or pushing
    if (workflowFiles.length) {
      const installationPermissions = github.installationPermissions;
      const tokenPermissions = github.permissions && typeof github.permissions === 'object' ? github.permissions : {};
      const hasTokenScope = Object.keys(tokenPermissions).length > 0;
      if (installationPermissions != null && installationPermissions.workflows !== 'write') {
        stop('github_workflows_permission_missing', 'waiting_permission', workflowsPermissionMissingDetail(workflowFiles, true));
      }
      if (!github.isAppInstallation && hasTokenScope && tokenPermissions.workflows !== 'write') {
        stop('github_workflows_permission_missing', 'waiting_permission', workflowsPermissionMissingDetail(workflowFiles, true));
      }
    }

    // 11. Run project policy `test_command` and independent QA gate before pushing (unless already verified for this exact commit/tree/policy)
    const policyHash = requestPolicyHash(store, task);
    const policyCommand = String(store.get('SELECT test_command FROM policies WHERE repository_id=?', repoId)?.test_command || '').trim();
    const qaRequired = pullRequestQaRequired(store, repoId);
    let validation: any = { command: agentTestCommand, source: 'agent', skipped: true };
    let qaVerdict: Verdict | null = null;
    let qaCandidateId: string | null = null;

    const headFiles = await listTreeFiles(stageDir, headSha);

    if (!skipGates) {
      const reuseQa = Boolean(
        previousQaPass &&
        previousQaPass.head_sha === headSha &&
        previousQaPass.tree_sha === treeSha &&
        previousQaPass.policy_hash === policyHash &&
        ['pass', 'pass_with_issues'].includes(previousQaPass.verdict.outcome),
      );
      if (reuseQa) {
        qaVerdict = previousQaPass!.verdict;
        qaCandidateId = previousQaPass!.candidate_id;
      } else {
        if (policyCommand) {
          const testRes = await withTaskSsh(store, task, budgetRole, ssh =>
            workspace.call(`push:tests:${execution}:${randomId()}`, { type: 'workspace_command', command: policyCommand, timeout_ms: null }, { ssh }),
          );
          validation = { ...testRes, command: policyCommand, source: 'policy' };
          if (testRes?.error || testRes?.exit_code !== 0 || testRes?.timed_out) {
            return {
              error: 'policy_test_failed',
              command: policyCommand,
              exit_code: testRes?.exit_code ?? null,
              timed_out: Boolean(testRes?.timed_out),
              output: redactor.text(String(testRes?.output || testRes?.error || 'policy verification failed')).slice(-4000),
              detail: `Project policy test_command \`${policyCommand}\` failed. Fix the failure, create a new commit, and call push_bot_branch again.`,
            };
          }
          const afterTest = await workspace.call(`push:inspect-after-test:${randomId()}`, {
            type: 'workspace_git_inspect',
            ...(headRef ? { ref: headRef } : {}),
          });
          if (afterTest?.error || String(afterTest.head_sha || '').toLowerCase() !== headSha || String(afterTest.tree_sha || '').toLowerCase() !== treeSha) {
            return {
              error: 'workspace_changed_during_test',
              detail: 'Workspace HEAD or tree changed while running project test_command. Commit or clean up changes and call push_bot_branch again.',
            };
          }
          if (Array.isArray(afterTest.tracked_dirty_files) && afterTest.tracked_dirty_files.length) {
            return {
              error: 'workspace_changed_during_test',
              files: afterTest.tracked_dirty_files,
              detail: `Project test_command left tracked files dirty (${afterTest.tracked_dirty_files.slice(0, 10).join(', ')}). Clean up or commit changes and call push_bot_branch again.`,
            };
          }
        }

        const records = new TaskRecords(store);
        const snapshotFiles = blobValue(store, input?.snapshot_files) ?? [];
        const codeArtifactContent = {
          files: headFiles,
          snapshot_files: snapshotFiles,
          local_sha: headSha,
          head_sha: headSha,
          tree_sha: treeSha,
          branch,
          base_branch: baseBranch,
          base_sha: remoteBaseSha ?? task.head_sha,
          expected_head_sha: expectedHead,
          commit_ancestry_verified: commitAncestryVerified,
          ...(forced ? { rebase: true } : {}),
          ...(activeConflictBaseSha ? { conflict_resolved: true } : {}),
          ...(pushSummary ? { summary: pushSummary } : {}),
          ...(agentTestCommand ? { test_command: agentTestCommand } : {}),
          validation,
          no_changes: false,
        };
        const policyEvidence = policyCommand
          ? [{ source: 'policy_validation', version: treeSha, verified: true, result: validation }]
          : [];
        const submitted = records.submit(
          String(task.id),
          [
            {
              kind: 'code',
              reference: `task:${task.id}:push:${headSha.slice(0, 12)}`,
              version: treeSha,
              content: codeArtifactContent,
            },
          ],
          policyEvidence,
          { summary: pushSummary || inspect.subject || `Push ${commitsToPush.length} commit(s) to ${branch}`, branch, head_sha: headSha },
          task.claim_token,
        );
        qaCandidateId = submitted.id;

        if (qaRequired) {
          const verdict = await evaluateDelivery(store, task, workspace, redactor, guard);
          if (policyHash !== requestPolicyHash(store, task)) {
            stop('acceptance_context_changed', 'retry_wait', '独立 QA 期间项目验证策略已变化，候选将重新验收。');
          }
          if (!['pass', 'pass_with_issues'].includes(verdict.outcome)) {
            return {
              error: 'qa_rejected',
              outcome: verdict.outcome,
              issues: verdict.gaps,
              reason: verdict.reason,
              detail: `Independent QA did not pass commit ${headSha.slice(0, 12)} (${verdict.outcome}): ${verdict.gaps.join('; ') || verdict.reason}. Fix the issues, commit your changes, and call push_bot_branch again.`,
            };
          }
          qaVerdict = verdict;
        } else {
          const verdict: Verdict = {
            outcome: 'pass',
            reason: `项目关闭了 PR 前的独立 QA 门槛；项目测试命令在提交 ${headSha.slice(0, 12)} 上通过：${policyCommand}`,
            gaps: [],
            residuals: [],
            core_complete: true,
            required_evidence_complete: true,
            acceptable_risk: true,
          };
          records.history(String(task.id), 'acceptance_evaluated', {
            evaluation_id: 'push-gate:' + submitted.id,
            candidate_id: submitted.id,
            elapsed_ms: 0,
            verdict,
            method: 'pull_request_qa_gate_off',
          });
          qaVerdict = verdict;
        }
      }
    }

    // 12. Final live re-check before real `git push`
    await guard();
    if (genericTask(task)) {
      const refusal = pullRequestRefusal(store, task);
      if (refusal) {
        return { error: refusal.code, tool: 'push_bot_branch', missing: refusal.missing, detail: refusal.message };
      }
    } else {
      assertRequestPullRequest(store, task);
    }

    // Register bot branch ownership before pushing so concurrent checks & github_write recognize it.
    if (existingPr) {
      store.run('INSERT INTO bot_branches VALUES(?,?,?) ON CONFLICT DO NOTHING', repoId, branch, ownerTaskId);
    } else {
      store.run(
        'INSERT INTO bot_branches(repository_id,branch,task_id) VALUES(?,?,?) ON CONFLICT(repository_id,branch) DO UPDATE SET task_id=excluded.task_id',
        repoId,
        branch,
        ownerTaskId,
      );
    }

    publicationFact(store, task, 'branch_update_requested', {
      operation_key: `git-push:${branch}:${headSha}`,
      branch,
      target_sha: headSha,
      expected_sha: remoteHeadSha,
      forced,
      workflow_files: workflowFiles,
    });

    // 13. Mint short-lived least-privilege token and run real `git push` from control plane
    const pushPerms: Record<string, string> = {
      contents: 'write',
      ...(workflowFiles.length ? { workflows: 'write' } : {}),
    };

    const runPushWithToken = async (token: string, granted: Record<string, string>) => {
      if (workflowFiles.length && granted && Object.keys(granted).length > 0 && granted.workflows !== 'write') {
        stop('github_workflows_permission_missing', 'waiting_permission', workflowsPermissionMissingDetail(workflowFiles, true));
      }
      const leaseSpec = `--force-with-lease=refs/heads/${branch}:${remoteHeadSha ?? ''}`;
      const pushArgs = ['push', '--porcelain', leaseSpec, '--', cloneUrl.href, `${headSha}:refs/heads/${branch}`];
      const pushed = await runGit(pushArgs, {
        cwd: stageDir,
        env: makeGitHttpEnv(cloneUrl, token),
        timeoutMs: 10 * 60_000,
      });
      if (pushed.code !== 0) {
        const combined = (pushed.stderr + '\n' + pushed.stdout.toString('utf8')).replaceAll(token, '[REDACTED]');
        const cleaned = fullRedactor.text(combined).trim().slice(0, 1500);
        if (workflowFiles.length && /workflow|refusing to allow a GitHub App to create or update workflow/i.test(cleaned)) {
          stop('github_workflows_permission_missing', 'waiting_permission', workflowsPermissionMissingDetail(workflowFiles, github.installationPermissions != null));
        }
        if (/stale info|rejected|non-fast-forward|fetch first|cannot lock ref|\[rejected\]/i.test(cleaned)) {
          return {
            error: 'branch_head_changed',
            branch,
            expected_remote_sha: remoteHeadSha ?? '',
            detail: `Remote branch "${branch}" changed while pushing: ${cleaned}`,
          };
        }
        return {
          error: 'git_push_failed',
          branch,
          detail: `git push to "${branch}" failed: ${cleaned || 'exit ' + pushed.code}`,
        };
      }
      return null;
    };

    let pushError: Record<string, any> | null = null;
    let mintedOk = false;
    try {
      pushError = await github.withPermissions(pushPerms, async (token, granted) => {
        mintedOk = true;
        return runPushWithToken(token, granted);
      });
    } catch (error) {
      if (workflowFiles.length && !mintedOk && error instanceof TaskError && ['github_permission_403', 'github_http_422'].includes(error.code)) {
        stop('github_workflows_permission_missing', 'waiting_permission', workflowsPermissionMissingDetail(workflowFiles, true));
      }
      throw error;
    }

    if (pushError) return pushError;

    // 14. Confirm live remote ref matches exact pushed commit SHA
    const confirmedRef = await github.ref(branch);
    const observedSha = HEX40.test(String(confirmedRef?.object?.sha || '')) ? String(confirmedRef.object.sha).toLowerCase() : null;
    if (observedSha !== headSha) {
      return {
        error: 'branch_not_confirmed',
        branch,
        expected_sha: headSha,
        observed_sha: observedSha,
        detail: `git push succeeded but remote branch "${branch}" reports ${observedSha ?? 'missing'} instead of ${headSha}.`,
      };
    }

    // 15. Pin pushed commit into control-plane GitCache mirror & sync bot_pull_requests/bot_pr_states from live GitHub
    if (gitCache) {
      await gitCache.pinFromStage(repoId, stageDir, headSha).catch(() => false);
    }
    let activePrNumber: number | null = existingPrNumber;
    let activePrUrl: string | null = existingPrUrl;
    if (existingPrNumber && store.hasTable('bot_pull_requests')) {
      const postPushLivePr = await github.request('GET', github.path('/pulls/' + existingPrNumber), undefined, true).catch(() => null);
      const requested = (() => {
        try { return JSON.parse(String(task.input || '{}')).revision?.source === 'request'; } catch { return false; }
      })();
      if (postPushLivePr && Number(postPushLivePr.number) === existingPrNumber) {
        const isOpen = String(postPushLivePr.state || '').toLowerCase() === 'open';
        if (isOpen) {
          store.run(
            'UPDATE bot_pull_requests SET revisions=revisions+CASE WHEN sha<>? AND ? THEN 1 ELSE 0 END,sha=? WHERE repository_id=? AND number=?',
            headSha,
            requested ? 0 : 1,
            headSha,
            repoId,
            existingPrNumber,
          );
          if (typeof postPushLivePr.html_url === 'string' && postPushLivePr.html_url) activePrUrl = postPushLivePr.html_url;
        } else {
          activePrNumber = null;
          activePrUrl = null;
          closedPrNumber = existingPrNumber;
        }
        syncBotPullRequestState(store, repoId, {
          ...postPushLivePr,
          head: { ...(postPushLivePr.head ?? {}), ref: postPushLivePr.head?.ref || branch, sha: isOpen ? headSha : (postPushLivePr.head?.sha ?? headSha) },
        });
      } else {
        // Never overwrite live bot_pr_states.state/mergeable/title with a stale task snapshot when live GET fails:
        // respect existing closed state and narrow-update only head_sha when still open.
        const localState = store.hasTable('bot_pr_states')
          ? store.get('SELECT state FROM bot_pr_states WHERE repository_id=? AND number=?', repoId, existingPrNumber)
          : undefined;
        if (localState && String(localState.state || '').toLowerCase() === 'closed') {
          activePrNumber = null;
          activePrUrl = null;
          closedPrNumber = existingPrNumber;
        } else {
          store.run(
            'UPDATE bot_pull_requests SET revisions=revisions+CASE WHEN sha<>? AND ? THEN 1 ELSE 0 END,sha=? WHERE repository_id=? AND number=?',
            headSha,
            requested ? 0 : 1,
            headSha,
            repoId,
            existingPrNumber,
          );
          if (localState) {
            store.run(
              'UPDATE bot_pr_states SET head_sha=?, updated_at=? WHERE repository_id=? AND number=?',
              headSha,
              new Date().toISOString(),
              repoId,
              existingPrNumber,
            );
          }
        }
      }
    }

    publicationFact(store, task, 'branch_confirmed', {
      operation_key: `git-push:${branch}:${headSha}`,
      branch,
      commit_sha: headSha,
      tree_sha: treeSha,
      forced,
      commits_pushed: commitsToPush.length,
    });
    store.audit('role:dev', 'git.push', `${branch} -> ${headSha.slice(0, 12)}${forced ? ' (force-with-lease)' : ''}`, repoId);
    log({
      type: 'git_pushed',
      branch,
      sha: headSha,
      tree_sha: treeSha,
      commits_pushed: commitsToPush.length,
      forced,
      workflow_files: workflowFiles,
      detail: `已通过受控 git push 推送分支 ${branch} 到远端提交 ${headSha.slice(0, 12)}（共 ${commitsToPush.length} 个提交${forced ? '，force-with-lease' : ''}）。`,
    });

    return {
      ok: true,
      branch,
      remote_sha: headSha,
      head_sha: headSha,
      tree_sha: treeSha,
      base_branch: baseBranch,
      base_sha: remoteBaseSha,
      commits_pushed: commitsToPush.length,
      forced,
      commit_ancestry_verified: commitAncestryVerified,
      workflow_files: workflowFiles,
      existing_pr_number: activePrNumber,
      existing_pr_url: activePrUrl,
      ...(closedPrNumber ? { closed_pr_number: closedPrNumber } : {}),
      test_command: agentTestCommand || (policyCommand || null),
      validation,
      next_step: activePrNumber
        ? `Branch "${branch}" is confirmed on remote at ${headSha}. Update bot PR #${activePrNumber} body/title via github_write PATCH /pulls/${activePrNumber} if progress changed the summary/verification/media, post any stage/reply comments, then finish with submit_report.`
        : `Branch "${branch}" is confirmed on remote at ${headSha}${closedPrNumber ? ` (previous PR #${closedPrNumber} is closed)` : ''}. Open the PR via github_write POST /pulls { head: "${branch}", base: "${baseBranch}", title, body } (citing only confirmed remote SHA ${headSha}), then finish with submit_report.`,
      _qa_verdict: qaVerdict,
      _qa_candidate_id: qaCandidateId,
      _qa_policy_hash: policyHash,
      _pushed_files: headFiles,
    };
  } finally {
    await github.revokeTokens('git_push');
    await rm(packFile, { force: true }).catch(() => {});
    if (stageCreated) await rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}
