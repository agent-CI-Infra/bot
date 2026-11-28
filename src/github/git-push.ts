import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store, Row } from '../storage/database.js';
import type { GitCache } from '../agent/git-cache.js';
import { GitHub } from './client.js';
import { Redactor, safePath, stop } from '../agent/common.js';
import { randomId } from '../core/security.js';
import { workflowsPermissionMissingDetail } from './workflow-changes.js';

export const HEX40 = /^[a-f0-9]{40}$/i;
export const ZERO40 = '0'.repeat(40);
export const MAX_BLOB_SCAN_BYTES = 100 * 1024 * 1024; // Matches GitHub's 100 MiB single-file limit

export const pushBotBranchTool = {
  type: 'function',
  function: {
    name: 'push_bot_branch',
    description:
      'Push verified real Git commits from this task workspace to a bot-owned branch (bot/*) through the control plane using real `git push` (GitHub write credentials never enter the container). '
      + 'First create clean commits in the workspace with native `git add` / `git commit` (or `git merge` / `git rebase` when updating or resolving conflicts on a bot branch) and inspect `git diff <base>...HEAD`. '
      + 'The control plane scans every commit in the push range for credentials, private keys, dirty files, conflict markers, and `.github/workflows/` permissions, runs the project policy `test_command` and independent QA gate (when enabled), and then executes an atomic real `git push` (with `--force-with-lease` when rebasing a bot branch). '
      + 'Returns the confirmed `branch` and `remote_sha` (identical to your local commit SHA). '
      + 'Never cite unpushed local commit SHAs in PR descriptions, comments, image captions, or file links: always call `push_bot_branch` first and cite only the confirmed `remote_sha`. '
      + 'After `push_bot_branch` succeeds, call `github_write` (`POST /pulls` to open a new PR, or `PATCH /pulls/{n}` to keep the bot-owned PR body updated to the latest complete state, plus comments/labels as needed), then finish with `submit_report`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branch: {
          type: 'string',
          maxLength: 200,
          description: 'Optional bot branch name (must start with "bot/"). Omit to use the task\'s deterministic bot branch (existing bot PR branch, bot/issue-<N>, or bot/task-<id>).',
        },
        head_ref: {
          type: 'string',
          maxLength: 200,
          description: 'Optional local Git ref or commit SHA to push (defaults to HEAD).',
        },
        force_with_lease: {
          type: 'boolean',
          description: 'Set true ONLY when intentionally rebasing or rewriting commits on this task\'s own bot/* branch (enforces atomic remote --force-with-lease). Never use on non-bot branches.',
        },
        expected_remote_sha: {
          type: 'string',
          maxLength: 40,
          description: 'Optional optimistic concurrency check: expected current 40-hex remote SHA on the target bot branch, or "" to require the branch does not exist yet.',
        },
        test_command: {
          type: 'string',
          maxLength: 500,
          description: 'Optional verification command you ran on this commit (recorded in delivery evidence).',
        },
        summary: {
          type: 'string',
          maxLength: 4000,
          description: 'Brief summary of what this commit delivers (shown to gatekeeper QA when QA runs before push).',
        },
      },
      required: [],
    },
  },
};

export type GitRun = { stdout: Buffer; stderr: string; code: number | null };

export function runGit(
  args: string[],
  options: { cwd: string; env?: Record<string, string>; input?: Buffer | string; inputFd?: number; timeoutMs?: number } = { cwd: '.' },
): Promise<GitRun> {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: options.cwd,
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...options.env,
  };
  return new Promise((resolve, reject) => {
    const stdinMode = options.inputFd !== undefined ? options.inputFd : (options.input === undefined ? 'ignore' : 'pipe');
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
      cwd: options.cwd,
      env,
      stdio: [stdinMode, 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let stderr = '';
    const timer = options.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs) : undefined;
    child.stdout?.on('data', chunk => out.push(chunk));
    child.stderr?.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8000);
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr, code });
    });
    if (options.inputFd === undefined && options.input !== undefined) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(options.input);
    }
  });
}

export async function checkedGit(args: string[], cwd: string, input?: Buffer | string): Promise<Buffer> {
  const res = await runGit(args, { cwd, input });
  if (res.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${res.stderr.trim() || 'exit ' + res.code}`);
  }
  return res.stdout;
}

export function validateCloneUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return null;
    if (!(parsed.href.startsWith('https://') || parsed.href.startsWith('http://'))) return null;
    if (parsed.username || parsed.password) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function validateBotBranchName(branch: string, defaultBranch: string, baseBranch?: string | null): string | null {
  const trimmed = branch.trim().replace(/^refs\/heads\//, '');
  if (!trimmed || trimmed.length > 200) return 'Branch name must be 1-200 characters.';
  if (!trimmed.startsWith('bot/')) return 'Only bot-owned branches (prefixed with "bot/") may be pushed.';
  if (!/^bot\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed)) return 'Branch name contains unsupported characters.';
  if (/(?:\.\.|@\{|\/\/|\/\.)/.test(trimmed) || trimmed.endsWith('/') || trimmed.endsWith('.') || trimmed.endsWith('.lock') || trimmed.includes('.lock/')) {
    return 'Branch name violates Git ref formatting rules.';
  }
  if (trimmed === defaultBranch || (baseBranch && trimmed === baseBranch)) {
    return `Refusing to push directly to protected/base branch "${trimmed}".`;
  }
  return null;
}

export function defaultTaskBotBranch(task: Row, input: any, defaultBranch: string): string {
  const adopted = typeof input?.bot_pr?.head?.ref === 'string' && input.bot_pr.head.ref.trim()
    ? input.bot_pr.head.ref.trim()
    : null;
  if (adopted) return adopted;
  const target = input?.target && typeof input.target === 'object' ? input.target : null;
  const issueNumber = target?.type === 'issue' && Number.isSafeInteger(Number(target.number)) && Number(target.number) > 0
    ? Number(target.number)
    : (!target && String(task.kind ?? '').endsWith('.issue') && Number.isSafeInteger(Number(task.object_number)) && Number(task.object_number) > 0
      ? Number(task.object_number)
      : null);
  if (issueNumber != null) {
    const base = String(input?.base_branch || '').trim();
    const def = String(input?.default_branch || defaultBranch || '').trim();
    if (!base || base === def) return `bot/issue-${issueNumber}`;
    const slug = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'base';
    return `bot/issue-${issueNumber}-${slug}`;
  }
  return `bot/task-${task.id}`;
}

export function resolveTaskBotBranch(
  store: Store,
  task: Row,
  input: any,
  requestedBranch: string | undefined,
  defaultBranch: string,
  baseBranch: string,
): { ok: true; branch: string; ownerTaskId: string; existingPr: Row | null } | { ok: false; error: string; detail: string } {
  const repoId = String(task.repository_id);
  const ownedTaskPr = store.hasTable('bot_pull_requests')
    ? store.get(
        `SELECT b.* FROM bot_pull_requests b
         LEFT JOIN bot_pr_states s ON s.repository_id=b.repository_id AND s.number=b.number
         WHERE b.repository_id=? AND b.source_task_id=? AND COALESCE(s.state,'open')='open'
         ORDER BY b.number DESC LIMIT 1`,
        repoId,
        task.id,
      ) ?? null
    : null;
  const adoptedPrNumber = Number.isSafeInteger(Number(input?.bot_pr?.number)) && Number(input.bot_pr.number) > 0
    ? Number(input.bot_pr.number)
    : ownedTaskPr ? Number(ownedTaskPr.number) : null;
  const adoptedPrRowRaw = adoptedPrNumber && store.hasTable('bot_pull_requests')
    ? store.get(
        `SELECT b.*, s.state AS pr_state FROM bot_pull_requests b
         LEFT JOIN bot_pr_states s ON s.repository_id=b.repository_id AND s.number=b.number
         WHERE b.repository_id=? AND b.number=?`,
        repoId,
        adoptedPrNumber,
      ) ?? ownedTaskPr
    : ownedTaskPr;
  const adoptedPrRow = adoptedPrRowRaw && String(adoptedPrRowRaw.pr_state || 'open').toLowerCase() === 'closed'
    ? null
    : adoptedPrRowRaw;
  const adoptedBranch = typeof input?.bot_pr?.head?.ref === 'string' && input.bot_pr.head.ref.trim()
    ? input.bot_pr.head.ref.trim()
    : (typeof adoptedPrRow?.branch === 'string' && adoptedPrRow.branch.trim() ? adoptedPrRow.branch.trim() : null);

  const defaultBranchForTask = adoptedBranch || defaultTaskBotBranch(task, input, defaultBranch);
  const branch = requestedBranch !== undefined && requestedBranch.trim()
    ? requestedBranch.trim().replace(/^refs\/heads\//, '')
    : defaultBranchForTask;

  const nameError = validateBotBranchName(branch, defaultBranch, baseBranch);
  if (nameError) {
    return { ok: false, error: 'branch_not_owned', detail: nameError };
  }
  if (adoptedBranch && branch !== adoptedBranch) {
    return {
      ok: false,
      error: 'branch_not_owned',
      detail: `This task is attached to existing bot PR #${adoptedPrNumber} on branch "${adoptedBranch}". Push to "${adoptedBranch}" (or omit branch) instead of "${branch}".`,
    };
  }
  const existingOwner = store.hasTable('bot_branches')
    ? store.get('SELECT task_id FROM bot_branches WHERE repository_id=? AND branch=?', repoId, branch)?.task_id
    : undefined;
  const ownerTaskId = adoptedBranch && existingOwner ? String(existingOwner) : String(task.id);
  if (existingOwner && String(existingOwner) !== String(task.id) && !adoptedBranch) {
    // Allow reclaiming a deterministic per-baseline branch ONLY if no other open bot PR currently holds it.
    const openOtherPr = store.hasTable('bot_pull_requests')
      ? store.get(
          `SELECT b.number, b.source_task_id FROM bot_pull_requests b
           LEFT JOIN bot_pr_states s ON s.repository_id=b.repository_id AND s.number=b.number
           WHERE b.repository_id=? AND b.branch=? AND b.source_task_id<>? AND COALESCE(s.state,'open')='open' LIMIT 1`,
          repoId,
          branch,
          task.id,
        )
      : undefined;
    if (openOtherPr || branch !== defaultBranchForTask) {
      return {
        ok: false,
        error: 'branch_not_owned',
        detail: `Branch "${branch}" is owned by another task (${existingOwner}${openOtherPr ? `, open PR #${openOtherPr.number}` : ''}).`,
      };
    }
  }
  return { ok: true, branch, ownerTaskId, existingPr: adoptedPrRow };
}

export interface DiffRawEntry {
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
  status: string;
  path: string;
  oldPath?: string;
}

export function parseRawDiffZ(buffer: Buffer): DiffRawEntry[] {
  const parts = buffer.toString('utf8').split('\0');
  const entries: DiffRawEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const meta = parts[i++];
    if (!meta || !meta.startsWith(':')) continue;
    const cols = meta.slice(1).split(' ');
    if (cols.length < 5) continue;
    const [oldMode, newMode, oldSha, newSha, status] = cols as [string, string, string, string, string];
    if (status.startsWith('R') || status.startsWith('C')) {
      const oldPath = parts[i++] ?? '';
      const newPath = parts[i++] ?? '';
      if (newPath) entries.push({ oldMode, newMode, oldSha, newSha, status, path: newPath, oldPath });
    } else {
      const filePath = parts[i++] ?? '';
      if (filePath) entries.push({ oldMode, newMode, oldSha, newSha, status, path: filePath });
    }
  }
  return entries;
}

export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  if (!HEX40.test(ancestor) || !HEX40.test(descendant)) return false;
  const run = await runGit(['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
  return run.code === 0;
}

export async function hasCommit(cwd: string, sha: string | null | undefined): Promise<boolean> {
  if (!sha || !HEX40.test(sha)) return false;
  const run = await runGit(['cat-file', '-e', sha + '^{commit}'], { cwd });
  return run.code === 0;
}

export async function inspectBlobSizes(cwd: string, shas: string[]): Promise<Map<string, number>> {
  const valid = [...new Set(shas.filter(s => HEX40.test(s)))];
  const sizes = new Map<string, number>();
  if (!valid.length) return sizes;
  const run = await runGit(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    cwd,
    input: valid.join('\n') + '\n',
  });
  if (run.code !== 0) {
    throw new Error(`git cat-file --batch-check failed: ${run.stderr.trim() || 'exit ' + run.code}`);
  }
  for (const line of run.stdout.toString('utf8').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length === 3 && HEX40.test(parts[0]!) && parts[1] === 'blob') {
      const size = Number(parts[2]);
      if (Number.isSafeInteger(size) && size >= 0) sizes.set(parts[0]!.toLowerCase(), size);
    }
  }
  return sizes;
}

const STREAM_PRIVATE_KEY_PATTERN = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

/**
 * Streams a Git blob through `git cat-file blob` in bounded chunks so large blobs never spike control-plane memory.
 * Maintains an overlap tail of `max(needle.length) - 1` bytes across chunks so secrets straddling chunk boundaries are
 * always detected. Text heuristics (private keys and conflict markers) stay bounded to `maxTextBytes`, while large
 * non-binary blobs still stream-scan for private key headers.
 */
export async function scanBlobStreaming(
  cwd: string,
  sha: string,
  size: number,
  options: {
    needles: Buffer[];
    maxTextBytes: number;
    checkPrivateKey: boolean;
    checkConflictMarkers: boolean;
  },
): Promise<{ secretHit: boolean; privateKeyHit: boolean; conflictMarkerHit: boolean }> {
  if (!HEX40.test(sha)) throw new Error(`invalid_blob_sha: ${sha}`);
  const overlap = Math.max(0, ...options.needles.map(n => n.length - 1));
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: cwd,
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  };
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'cat-file', 'blob', sha], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let secretHit = false;
    let killedEarly = false;
    let tail = Buffer.alloc(0);
    let prefixChecked = 0;
    let isBinary = false;
    const collectText = size <= options.maxTextBytes && (options.checkPrivateKey || options.checkConflictMarkers);
    const textChunks: Buffer[] = [];
    let collectedBytes = 0;
    let textTail = '';
    let largePrivateKeyHit = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (secretHit) return;
      if (prefixChecked < 8192) {
        const probe = chunk.subarray(0, 8192 - prefixChecked);
        if (probe.includes(0)) isBinary = true;
        prefixChecked += probe.length;
      }
      if (options.needles.length) {
        const win = tail.length ? Buffer.concat([tail, chunk]) : chunk;
        for (const needle of options.needles) {
          if (win.includes(needle)) {
            secretHit = true;
            killedEarly = true;
            child.kill('SIGTERM');
            return;
          }
        }
        if (overlap > 0) {
          tail = Buffer.from(win.subarray(Math.max(0, win.length - overlap)));
        }
      }
      if (collectText && !isBinary) {
        if (collectedBytes + chunk.length <= options.maxTextBytes) {
          textChunks.push(chunk);
          collectedBytes += chunk.length;
        }
      } else if (!collectText && !isBinary && options.checkPrivateKey && !largePrivateKeyHit) {
        const textWin = textTail + chunk.toString('utf8');
        if (STREAM_PRIVATE_KEY_PATTERN.test(textWin)) largePrivateKeyHit = true;
        textTail = textWin.slice(-64);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', code => {
      if (secretHit) {
        resolve({ secretHit: true, privateKeyHit: false, conflictMarkerHit: false });
        return;
      }
      if (code !== 0 && !killedEarly) {
        reject(new Error(`git cat-file blob ${sha} failed: ${stderr.trim() || 'exit ' + code}`));
        return;
      }
      if (isBinary) {
        resolve({ secretHit: false, privateKeyHit: false, conflictMarkerHit: false });
        return;
      }
      if (collectText) {
        const text = Buffer.concat(textChunks).toString('utf8');
        const privateKeyHit = options.checkPrivateKey && STREAM_PRIVATE_KEY_PATTERN.test(text);
        const conflictMarkerHit = options.checkConflictMarkers && /^(?:<<<<<<< |>>>>>>> )/m.test(text) && /^=======\r?$/m.test(text);
        resolve({ secretHit: false, privateKeyHit, conflictMarkerHit });
        return;
      }
      resolve({ secretHit: false, privateKeyHit: largePrivateKeyHit, conflictMarkerHit: false });
    });
  });
}

export async function listTreeFiles(cwd: string, commitSha: string): Promise<Array<{ path: string; mode: string; sha: string; size: number }>> {
  const raw = (await checkedGit(['ls-tree', '-r', '-l', '-z', commitSha], cwd)).toString('utf8');
  const files: Array<{ path: string; mode: string; sha: string; size: number }> = [];
  for (const row of raw.split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, hash, size] = row.slice(0, tab).trim().split(/\s+/);
    const name = safePath(row.slice(tab + 1));
    if (type === 'commit' && mode === '160000') continue;
    if (type !== 'blob' || !['100644', '100755', '120000'].includes(mode!)) continue;
    files.push({ path: name, mode: mode!, sha: hash!, size: Number(size) || 0 });
  }
  return files;
}

export function makeGitHttpEnv(target: URL, token: string): Record<string, string> {
  return {
    GIT_ALLOW_PROTOCOL: target.protocol.slice(0, -1),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${target.origin}/.extraheader`,
    GIT_CONFIG_VALUE_0: 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64'),
  };
}

/**
 * Legacy `Publisher.branch` git-push fast path: builds the exact deterministic candidate tree and commit inside an
 * isolated staging repo backed by `GitCache` alternates and pushes via real `git push`, avoiding GitHub's slow
 * `POST /git/trees` REST endpoint (502/504 on large repositories). Returns the confirmed commit SHA, or `null` when
 * `gitCache` / `cloneUrl` / parent objects are unavailable so `Publisher.branch` can fall back cleanly to REST.
 */
export async function pushCandidateCommitViaGit(options: {
  gitCache: GitCache;
  github: GitHub;
  repositoryId: string;
  branch: string;
  expectedTreeSha: string;
  sourceTreeSha?: string | null;
  files: Array<{ path: string; mode: string; sha: string; base64?: string }>;
  snapshotFiles: Array<{ path: string; mode: string; sha: string }>;
  parents: string[];
  expectedRemoteSha: string | null;
  currentRemoteSha?: string | null;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  writeToken?: string;
  workflowFiles: string[];
  redactor: Redactor;
  beforePush?: () => void;
}): Promise<string | null> {
  const cloneUrl = validateCloneUrl(options.github.cloneUrl);
  if (!cloneUrl) return null;

  const repoId = options.repositoryId;
  const neededCommits = [...new Set([...options.parents, ...(options.expectedRemoteSha ? [options.expectedRemoteSha] : [])].filter(s => HEX40.test(s)))];
  if (!neededCommits.length) return null;

  const token = options.writeToken || options.github.token;
  const mirror = await options.gitCache.open(repoId, {
    url: cloneUrl.href,
    token,
    commits: neededCommits,
    refs: [`refs/heads/${options.branch}`],
  });
  if (!neededCommits.every(sha => mirror.has(sha))) return null;
  const mirrorObjects = await options.gitCache.mirrorObjectsDir(repoId);
  if (!mirrorObjects) return null;

  const stageDir = join(options.gitCache.root, `pub-stage-${randomId()}.git`);
  const indexFile = join(stageDir, 'bot-index');
  try {
    await checkedGit(['init', '--bare', '--quiet', stageDir], options.gitCache.root);
    await mkdir(join(stageDir, 'objects', 'info'), { recursive: true, mode: 0o700 });
    await writeFile(join(stageDir, 'objects', 'info', 'alternates'), mirrorObjects + '\n', { mode: 0o600 });

    // Confirm source_tree (or first parent's tree) is readable in alternates before building the candidate tree.
    const baseTree = options.sourceTreeSha && HEX40.test(options.sourceTreeSha) ? options.sourceTreeSha : options.parents[0]! + '^{tree}';
    const envWithIndex = { GIT_INDEX_FILE: indexFile };
    const readTree = await runGit(['read-tree', baseTree], { cwd: stageDir, env: envWithIndex });
    if (readTree.code !== 0) return null;

    const upstream = new Map(options.snapshotFiles.map(f => [f.path, f]));
    const currentPaths = new Set(options.files.map(f => f.path));

    // Remove deleted files from the index.
    const deleted = options.snapshotFiles.filter(f => !currentPaths.has(f.path)).map(f => f.path);
    if (deleted.length) {
      const rmRun = await runGit(['update-index', '--force-remove', '--stdin', '-z'], {
        cwd: stageDir,
        env: envWithIndex,
        input: Buffer.from(deleted.join('\0') + '\0'),
      });
      if (rmRun.code !== 0) return null;
    }

    // Write any changed/new blobs and update index entries.
    const indexLines: string[] = [];
    for (const file of options.files) {
      const prev = upstream.get(file.path);
      if (prev && prev.sha === file.sha && prev.mode === file.mode) continue;
      if (file.base64 !== undefined) {
        const bytes = Buffer.from(file.base64, 'base64');
        const written = (await checkedGit(['hash-object', '--no-filters', '-w', '--stdin'], stageDir, bytes)).toString('utf8').trim();
        if (written !== file.sha) {
          stop('candidate_blob_mismatch', undefined, `发布前校验候选文件 ${file.path} 失败，内容与预期 SHA ${file.sha} 不一致。`);
        }
      } else {
        const checkBlob = await runGit(['cat-file', '-e', file.sha + '^{blob}'], { cwd: stageDir });
        if (checkBlob.code !== 0) return null;
      }
      indexLines.push(`${file.mode} ${file.sha}\t${file.path}`);
    }
    if (indexLines.length) {
      const upd = await runGit(['update-index', '--add', '--index-info'], {
        cwd: stageDir,
        env: envWithIndex,
        input: indexLines.join('\n') + '\n',
      });
      if (upd.code !== 0) return null;
    }

    const builtTree = (await runGit(['write-tree'], { cwd: stageDir, env: envWithIndex })).stdout.toString('utf8').trim();
    if (builtTree !== options.expectedTreeSha) return null;

    const parentArgs = options.parents.flatMap(p => ['-p', p]);
    const commitRun = await runGit(['commit-tree', builtTree, ...parentArgs], {
      cwd: stageDir,
      input: options.message.endsWith('\n') ? options.message : options.message + '\n',
      env: {
        GIT_AUTHOR_NAME: options.authorName,
        GIT_AUTHOR_EMAIL: options.authorEmail,
        GIT_AUTHOR_DATE: options.authorDate,
        GIT_COMMITTER_NAME: options.authorName,
        GIT_COMMITTER_EMAIL: options.authorEmail,
        GIT_COMMITTER_DATE: options.authorDate,
      },
    });
    if (commitRun.code !== 0) return null;
    const commitSha = commitRun.stdout.toString('utf8').trim().toLowerCase();
    if (!HEX40.test(commitSha)) return null;

    if (options.currentRemoteSha && options.currentRemoteSha.toLowerCase() === commitSha) {
      await options.gitCache.pinFromStage(repoId, stageDir, commitSha).catch(() => false);
      return commitSha;
    }
    if (options.currentRemoteSha && options.currentRemoteSha.toLowerCase() !== (options.expectedRemoteSha || '').toLowerCase()) {
      stop('branch_head_changed', 'needs_replan', `发布分支 ${options.branch} 前发现 head 已变化，当前提交=${options.currentRemoteSha}。`);
    }
    if (!options.currentRemoteSha && options.expectedRemoteSha) {
      stop('branch_disappeared', 'needs_replan', `待更新的分支 ${options.branch} 已不存在。`);
    }

    options.beforePush?.();
    const leaseSpec = `--force-with-lease=refs/heads/${options.branch}:${options.expectedRemoteSha ?? ''}`;
    const pushed = await runGit(
      ['push', '--porcelain', leaseSpec, '--', cloneUrl.href, `${commitSha}:refs/heads/${options.branch}`],
      { cwd: stageDir, env: makeGitHttpEnv(cloneUrl, token), timeoutMs: 10 * 60_000 },
    );
    if (pushed.code !== 0) {
      const combined = (pushed.stderr + '\n' + pushed.stdout.toString('utf8')).replaceAll(token, '[REDACTED]');
      const cleaned = options.redactor.text(combined).trim().slice(0, 1500);
      if (options.workflowFiles.length && /workflow|refusing to allow a GitHub App to create or update workflow/i.test(cleaned)) {
        stop('github_workflows_permission_missing', 'waiting_permission', workflowsPermissionMissingDetail(options.workflowFiles, options.github.installationPermissions != null));
      }
      if (/stale info|rejected|non-fast-forward|fetch first|\[rejected\]/i.test(cleaned)) {
        stop('branch_head_changed', 'needs_replan', `发布分支 ${options.branch} 前发现 head 已变化：${cleaned}`);
      }
      // On transport/protocol errors (for example a test fixture without smart-HTTP push), return null to fall back cleanly.
      if (/not found|404|405|501|not a git repository|repository .* not found/i.test(cleaned)) {
        return null;
      }
      stop('github_response_unknown', 'retry_wait', `git push 分支 ${options.branch} 失败：${cleaned || 'exit ' + pushed.code}`);
    }

    await options.gitCache.pinFromStage(repoId, stageDir, commitSha).catch(() => false);
    return commitSha;
  } finally {
    await rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}
