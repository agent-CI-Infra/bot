import { parseDocument, parse, isMap, isSeq, isScalar, YAMLMap, type Document } from 'yaml';

/**
 * The gate plan settled in the onboarding conversation, and the files the control plane renders from it.
 *
 * The plan holds only what a person can check: the toolchains to set up, the dependency installs, each lane's commands,
 * which lanes only record failures, and which workflow file holds the gate job. Triggers, permissions, the job layout and
 * which lanes each event runs are decided here from repository facts (the default branch, whether a merge queue is on), so
 * neither the model nor repository text can change what the workflow is allowed to do.
 */
// CI-workflow knows five lanes; build is folded into pr-ready, so a plan has four. ci-gates.json maps events to them.
export const gateLanes = ['pr-ready', 'pr-merge', 'daily', 'release'] as const;
export type Lane = typeof gateLanes[number];
export type MergeQueue = 'enabled' | 'disabled' | 'unknown';

/**
 * Which lanes gate.mjs runs for each event (`events` in ci-gates.json). pr-merge is the merge gate: it runs again everything
 * pr-ready checks, then its own costlier checks, on the merged result: in the merge queue (merge_group), or after a merge
 * to the default branch (push) when the repository has no queue.
 */
export const laneEvents: Record<string, Lane[]> = {
  pull_request: ['pr-ready'], workflow_dispatch: ['pr-ready'], merge_group: ['pr-ready', 'pr-merge'], push: ['pr-ready', 'pr-merge'],
  schedule: ['daily'], release: ['release'],
};

/** When each lane runs and what belongs in it; shown before onboarding starts, to the agent and in the PR. */
export const laneTimes: Record<Lane, string> = {
  'pr-ready': 'PR 每次提交或更新时跑（也可以手动运行），检查 PR 的 head 提交；放构建和基础检查（编译、lint、类型检查、快速的单元测试），要在几分钟内跑完',
  'pr-merge': '合入门禁，确保多个 PR 合在一起不会互相影响：有 merge queue 时在队列里对合并结果先跑 pr-ready 再跑这一层，没有 merge queue 时在合入默认分支后对合入结果这样运行；放需要费用、资源或较长时间的检查',
  daily: '每天定时（北京时间 0 点）在默认分支跑，放耗时较长或依赖外部环境的全量测试、端到端测试，通常只记录失败',
  release: '推送版本标签（如 v1.2.3）时跑，是发版本前的最后一道检查；通过后「发版本」才生成 Release 草稿',
};

/** Toolchain versions; an empty string means the toolchain is not set up; go may name a go.mod. Node always runs gate.mjs. */
export interface Toolchains { node: string; python: string; go: string; java: string }
export interface GatePlan {
  toolchains: Toolchains; install: string[]; lanes: Record<Lane, string[]>;
  /** Lanes whose failures are recorded (CI-workflow's `observe`) without failing the job; their later commands still run. */
  observe: Lane[];
  /** The workflow file that holds the gate job; empty means the default for this repository. */
  workflow: string;
}
/** What the control plane decides from facts, never from the plan. */
export interface GateTarget {
  defaultBranch: string;
  mergeQueue: 'enabled' | 'disabled';
  /** The workflow file that holds the gate job. */
  workflowPath: string;
  /** Its current content on the default branch; null when this PR creates it. */
  workflowSource: string | null;
  /** The current .github/ci-gates.json; null when this PR creates it. */
  configSource: string | null;
  /** The current .github/workflows/release.yml; null when this PR creates it. */
  releaseSource: string | null;
  /** Whether that release.yml is triggered by version tags, so the console's release flow can use it. */
  releaseUsable: boolean;
  /** package-lock.json exists, so setup-node may cache npm. */
  npmLock: boolean;
}
/** One file of the gate PR; `previous` is its content on the default branch, null for a new file. */
export interface GateFile { path: string; content: string; previous: string | null }

export const releasePath = '.github/workflows/release.yml';
export const emptyPlan = (): GatePlan => ({ toolchains: { node: '22', python: '', go: '', java: '' }, install: [],
  lanes: Object.fromEntries(gateLanes.map(lane => [lane, []])) as unknown as Record<Lane, string[]>, observe: ['daily'], workflow: '' });

/** Thrown for a plan the control plane will not render; `code` is shown to the person or the model. */
export class PlanError extends Error { constructor(readonly code: string, readonly detail: string) { super(code); } }

// A token in a plan would be committed to the repository; these are GitHub's own token formats.
export const tokenPattern = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/;
const control = /[\u0000-\u0008\u000b-\u001f\u007f]/;
export const workflowPathPattern = /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/;

function commands(value: unknown, where: string, yaml: boolean): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PlanError('gate_plan_invalid', `${where} 必须是命令列表`);
  return value.map(item => {
    if (typeof item !== 'string') throw new PlanError('gate_plan_invalid', `${where} 的每条命令必须是字符串`);
    return item.trim();
  }).filter(item => {
    if (!item) return false;
    if (control.test(item)) throw new PlanError('gate_plan_invalid', `${where} 的命令含有控制字符`);
    // Install commands become workflow `run:` steps, where Actions would evaluate an expression before the shell runs.
    if (yaml && item.includes('${{')) throw new PlanError('gate_plan_invalid', `${where} 的命令不能包含 GitHub Actions 表达式 \${{ }}，请改用环境变量`);
    return true;
  });
}
function version(value: unknown, where: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new PlanError('gate_plan_invalid', `${where} 必须是字符串`);
  const text = value.trim();
  if (/[\r\n]/.test(text) || control.test(text) || text.includes('${{')) throw new PlanError('gate_plan_invalid', `${where} 不是有效的版本`);
  return text;
}

/**
 * Checks a plan from the model or a person and returns it in canonical form. `secrets` are values that must never be
 * written into the repository (the run's tokens and model key). A `build` lane from an older plan is folded into pr-ready.
 */
export function normalizePlan(input: unknown, secrets: Iterable<string> = []): GatePlan {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PlanError('gate_plan_invalid', '方案必须是对象');
  const value = input as any, tools = value.toolchains ?? {};
  if (typeof tools !== 'object' || Array.isArray(tools)) throw new PlanError('gate_plan_invalid', 'toolchains 必须是对象');
  const lanes = value.lanes ?? {};
  if (typeof lanes !== 'object' || Array.isArray(lanes)) throw new PlanError('gate_plan_invalid', 'lanes 必须是对象');
  const known = [...gateLanes, 'build'] as string[];
  const unknown = Object.keys(lanes).find(lane => !known.includes(lane));
  if (unknown) throw new PlanError('gate_plan_invalid', `未知的 lane：${unknown}（可用：${gateLanes.join('、')}）`);
  const observe = value.observe ?? ['daily'];
  if (!Array.isArray(observe) || observe.some(lane => !known.includes(lane))) throw new PlanError('gate_plan_invalid', `observe 只能列出 ${gateLanes.join('、')}`);
  const workflow = value.workflow ?? '';
  if (typeof workflow !== 'string' || (workflow && !workflowPathPattern.test(workflow))) throw new PlanError('gate_plan_invalid', 'workflow 必须是 .github/workflows/ 下的 YAML 文件');
  const normalized = Object.fromEntries(gateLanes.map(lane => [lane, commands(lanes[lane], `lane ${lane}`, false)])) as Record<Lane, string[]>;
  const build = commands(lanes.build, 'lane build', false);
  normalized['pr-ready'] = [...build, ...normalized['pr-ready'].filter(command => !build.includes(command))];
  const plan: GatePlan = {
    toolchains: { node: version(tools.node, 'Node 版本') || '22', python: version(tools.python, 'Python 版本'), go: version(tools.go, 'Go 版本'), java: version(tools.java, 'Java 版本') },
    install: commands(value.install, '安装命令', true), lanes: normalized,
    observe: gateLanes.filter(lane => observe.includes(lane)), workflow,
  };
  const text = JSON.stringify(plan);
  if (tokenPattern.test(text) || [...secrets].some(secret => secret.length >= 8 && text.includes(secret)))
    throw new PlanError('gate_plan_secret', '方案里像是包含了令牌或密钥，不能写进仓库');
  return plan;
}

/**
 * The events the gate job runs on, in workflow order. merge_group always reports, so `gate` can be a required check under a
 * merge queue; without a queue the merge gate runs after pushes to the default branch instead. Version tags run the release
 * lane from release.yml, not from here.
 */
export function gateEvents(plan: GatePlan, target: Pick<GateTarget, 'mergeQueue'>): string[] {
  const events = ['pull_request', 'merge_group'];
  if (target.mergeQueue === 'disabled') events.push('push');
  if (plan.lanes.daily.length) events.push('schedule');
  events.push('workflow_dispatch');
  return events;
}

const q = (value: string) => JSON.stringify(value); // A JSON string is a valid YAML double-quoted scalar.
// `head`: check out the PR head on pull_request, so the code tested is the commit the reports name.
function setupSteps(plan: GatePlan, target: GateTarget, head: boolean): string {
  const { node, python, go, java } = plan.toolchains, npm = target.npmLock && plan.install.some(command => /^npm\s+(?:ci|install|i)\b/.test(command));
  let steps = `      - name: Checkout
        uses: actions/checkout@v4
${head ? `        with:
          # The PR head itself, not GitHub's merge preview: the reports name this commit.
          ref: \${{ github.event.pull_request.head.sha || github.sha }}
` : ''}
      # gate.mjs runs on Node 20+; the repository's own toolchains follow.
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: ${q(node || '22')}
${npm ? "          cache: 'npm'\n" : ''}`;
  if (python) steps += `
      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: ${q(python)}
`;
  if (go) steps += `
      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          ${go.endsWith('go.mod') ? `go-version-file: ${q(go)}` : `go-version: ${q(go)}`}
`;
  if (java) steps += `
      - name: Setup Java
        uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: ${q(java)}
`;
  // A literal block keeps the command as written; every line is indented, so no content can end the block early.
  plan.install.forEach((command, index) => { steps += `
      - name: ${plan.install.length > 1 ? `Install dependencies (${index + 1})` : 'Install dependencies'}
        run: |-
${command.split('\n').map(line => '          ' + line).join('\n')}
`; });
  return steps;
}
const upload = (name: string) => `
      - name: Upload gate reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ${name}
          path: gate-reports/
          if-no-files-found: warn
          retention-days: 30
`;
const triggerText: Record<string, (branch: string) => string> = {
  pull_request: () => '  pull_request:\n',
  merge_group: () => '  merge_group:\n',
  push: branch => `  push:\n    branches: [${q(branch)}]\n`,
  schedule: () => "  schedule:\n    # Daily lane: 16:00 UTC = 00:00 Asia/Shanghai.\n    - cron: '0 16 * * *'\n",
  workflow_dispatch: () => '  workflow_dispatch:\n',
};

function gateJob(plan: GatePlan, target: GateTarget): string {
  return `  gate:
    name: gate
    runs-on: ubuntu-latest
    env:
      # The commit the reports name: the PR head on pull_request, the checked-out commit otherwise.
      CI_GATES_SHA: \${{ github.event.pull_request.head.sha || github.sha }}
    steps:
${setupSteps(plan, target, true)}
      - name: Run gate lanes
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        # ci-gates.json maps each event to its lanes.
        run: node scripts/gate/gate.mjs run --event "$GITHUB_EVENT_NAME"
${upload('ci-gates-reports')}`;
}
function releaseJob(plan: GatePlan, target: GateTarget, key = 'gate'): string {
  return `  ${key}:
    name: release
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
${setupSteps(plan, target, false)}
      - name: Gate lane release
        run: node scripts/gate/gate.mjs run --lane release
${upload('ci-gates-release')}`;
}

/** A new gate workflow: one `gate` job runs the lanes ci-gates.json maps to the triggering event. */
export function gateWorkflow(plan: GatePlan, target: GateTarget): string {
  const queue = target.mergeQueue === 'enabled'
    ? '# This repository uses a merge queue: pr-ready runs on pull requests; the queue (merge_group) runs pr-ready and pr-merge\n# on the merged result, and nothing runs again after merging.\n'
    : '# Without a merge queue, pr-ready runs on pull requests and the merge gate (pr-ready and pr-merge) runs after each merge.\n';
  return `# CI gates (CI-workflow), generated from the commands confirmed during onboarding.
# One job runs the lanes .github/ci-gates.json maps to the current event, and reports the commit it checked out.
${queue}name: ${target.workflowPath.endsWith('/ci.yml') ? 'CI' : q('CI gates')}

on:
${gateEvents(plan, target).map(event => triggerText[event]!(target.defaultBranch)).join('')}
permissions:
  contents: read

# Pull request runs of one branch replace each other; every queue entry, merge, daily and manual run keeps its own run.
concurrency:
  group: ci-gates-\${{ github.workflow }}-\${{ github.event_name }}-\${{ github.event_name == 'pull_request' && github.ref || github.sha }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
${gateJob(plan, target)}`;
}

/** The job in a workflow whose steps run gate.mjs (`release`: the one running the release lane), if any. */
export function gateJobKey(doc: Document, release = false): string | null {
  const jobs = doc.get('jobs', true);
  if (!isMap(jobs)) return null;
  for (const pair of jobs.items) {
    const steps = isMap(pair.value) ? pair.value.get('steps', true) : null;
    const runs = (step: unknown) => String(isMap(step) ? step.get('run') ?? '' : '');
    if (isSeq(steps) && steps.items.some(step => runs(step).includes('scripts/gate/gate.mjs') && runs(step).includes('--lane release') === release))
      return String(isScalar(pair.key) ? pair.key.value : pair.key);
  }
  return null;
}

/** Puts `job` under `jobs`, replacing the job `existing` names (keeping its display name, the required-check context). */
function placeJob(doc: Document, job: YAMLMap, existing: string | null, fallback: string): void {
  let jobs = doc.get('jobs', true);
  if (!isMap(jobs)) { jobs = doc.createNode({}) as YAMLMap; doc.set('jobs', jobs); }
  const map = jobs as YAMLMap, key = existing ?? (!map.has(fallback) ? fallback : `ci-${fallback}`);
  const previous = existing ? map.get(existing, true) : null;
  if (isMap(previous) && previous.has('name')) job.set('name', previous.get('name'));
  map.set(key, job);
}
function parseWorkflow(source: string, path: string): Document {
  const doc = parseDocument(source);
  if (doc.errors.length || !isMap(doc.contents)) throw new PlanError('gate_workflow_invalid', `${path} 不是有效的 workflow YAML，不能并入门禁 job`);
  return doc;
}
// Untouched parts keep their usual style: no folding of long lines, `[main]` rather than `[ main ]`, empty rather than `null`.
const render = (doc: Document) => doc.toString({ lineWidth: 0, nullStr: '', flowCollectionPadding: false });

/**
 * The gate job merged into an existing workflow. The job that already runs gate.mjs is replaced; otherwise a `gate` job is
 * added. Missing triggers are added, none is removed: when the file has other triggers, the job's own `if:` limits it to the
 * gate events, so other jobs and their triggers stay as they are.
 */
export function mergeGateJob(source: string, plan: GatePlan, target: GateTarget): string {
  const doc = parseWorkflow(source, target.workflowPath), events = gateEvents(plan, target);
  const job = parseDocument(`jobs:\n${gateJob(plan, target)}`).getIn(['jobs', 'gate'], true) as YAMLMap;
  // `on: push` and `on: [push, pull_request]` become a map so triggers can be added.
  let on = doc.get('on', true);
  if (isScalar(on) || isSeq(on)) {
    const names = isScalar(on) ? [String(on.value)] : on.items.map(item => String(isScalar(item) ? item.value : item));
    on = doc.createNode(Object.fromEntries(names.map(name => [name, null]))) as YAMLMap; doc.set('on', on);
  } else if (!isMap(on)) { on = doc.createNode({}) as YAMLMap; doc.set('on', on); }
  const values: Record<string, unknown> = { push: { branches: [target.defaultBranch] }, schedule: [{ cron: '0 16 * * *' }] };
  for (const event of events) if (!(on as YAMLMap).has(event)) (on as YAMLMap).set(event, values[event] ?? null);
  const others = (on as YAMLMap).items.map(pair => String(isScalar(pair.key) ? pair.key.value : pair.key)).filter(event => !events.includes(event));
  if (others.length) job.items.splice(1, 0, doc.createPair('if', events.map(event => `github.event_name == '${event}'`).join(' || ')));
  placeJob(doc, job, gateJobKey(doc), 'gate');
  return render(doc);
}

/** release.yml: a version tag runs the release lane; the console's release flow waits for this run before the draft. */
export function releaseWorkflowFile(plan: GatePlan, target: GateTarget): string {
  return `# Release gate: a version tag runs the repository-configured release lane on the tagged commit.
# The console's release flow tags a version, waits for this run, then writes the notes and creates the Release draft.
# Publishing packages or images is up to the repository; add those steps here when needed.
name: Release

on:
  push:
    tags:
      - "v*"
      - "[0-9]+.[0-9]+.[0-9]+*"
  workflow_dispatch:

permissions:
  contents: read

jobs:
${releaseJob(plan, target)}`;
}

/**
 * A repository's own tag-triggered release.yml gets a job that runs the release lane, so a failing lane fails the run the
 * release flow waits for; its triggers and other jobs are not touched, and the job runs on version tags only.
 */
export function mergeReleaseJob(source: string, plan: GatePlan, target: GateTarget): string {
  const doc = parseWorkflow(source, releasePath);
  const job = parseDocument(`jobs:\n${releaseJob(plan, target, 'release-gate')}`).getIn(['jobs', 'release-gate'], true) as YAMLMap;
  // The release flow waits for the tag's run; branch pushes or published releases in the same file do not run the lane.
  job.items.splice(1, 0, doc.createPair('if', "startsWith(github.ref, 'refs/tags/')"));
  placeJob(doc, job, gateJobKey(doc, true), 'release-gate');
  return render(doc);
}

/**
 * .github/ci-gates.json. An existing file keeps every key and form the plan does not change (level, caseCatalog, timeouts,
 * string commands, absent lanes); `events` maps each event to its lanes, and the folded build lane is removed. An empty
 * lane reports not_applicable, which means "not configured", never "passed".
 */
export function gateConfig(plan: GatePlan, target: Pick<GateTarget, 'configSource'>): string {
  let base: Record<string, any> = { version: 1, level: 'C1', preset: 'auto' };
  if (target.configSource !== null) {
    try { const parsed = JSON.parse(target.configSource); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed; } catch { /* Rewritten whole; the diff shows it. */ }
  }
  const lanes: Record<string, any> = base.lanes && typeof base.lanes === 'object' && !Array.isArray(base.lanes) ? { ...base.lanes } : {};
  delete lanes.build;
  for (const lane of gateLanes) {
    // An untouched lane keeps its exact form: a lane the file leaves out stays out, a string command stays a string.
    if (!(lane in lanes) && target.configSource !== null && !plan.lanes[lane].length && !plan.observe.includes(lane)) continue;
    const current = lanes[lane] && typeof lanes[lane] === 'object' && !Array.isArray(lanes[lane]) ? { ...lanes[lane] } : {};
    const before = typeof current.commands === 'string' ? [current.commands] : current.commands;
    if (JSON.stringify(before ?? []) !== JSON.stringify(plan.lanes[lane]) || current.commands === undefined) current.commands = plan.lanes[lane];
    if (plan.observe.includes(lane)) { current.enforcement = 'observe'; current.continueOnError ??= true; }
    else if (current.enforcement === 'observe') { delete current.enforcement; if (current.continueOnError === true) delete current.continueOnError; }
    lanes[lane] = current;
  }
  const events = { ...(base.events && typeof base.events === 'object' && !Array.isArray(base.events) ? base.events : {}), ...laneEvents };
  // Keys keep their places; `events` goes just before `lanes` when the file has none.
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(base)) {
    if (key === 'lanes' && !('events' in base)) result.events = events;
    result[key] = key === 'lanes' ? lanes : key === 'events' ? events : value;
  }
  if (!('events' in result)) result.events = events;
  if (!('lanes' in result)) result.lanes = lanes;
  return JSON.stringify(result, null, 2) + '\n';
}

/** Object keys sorted at every level, so key order alone never counts as a change. */
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as any)[key])])) : value;
/** Two texts with the same parsed value; formatting differences alone do not make a file part of the PR. */
function same(previous: string | null, content: string, json: boolean): boolean {
  if (previous === null) return false;
  try { return JSON.stringify(canonical(json ? JSON.parse(previous) : parse(previous))) === JSON.stringify(canonical(json ? JSON.parse(content) : parse(content))); }
  catch { return previous === content; }
}

/**
 * The files this PR adds or changes, rendered from the plan; gate.mjs is copied from CI-workflow when the PR is created.
 * release.yml is created when missing; a usable one of the repository's own gets the release lane job when the lane has
 * commands; one the release flow cannot use is left to the person.
 */
export function gateFiles(plan: GatePlan, target: GateTarget): GateFile[] {
  const workflow = target.workflowSource === null ? gateWorkflow(plan, target) : mergeGateJob(target.workflowSource, plan, target);
  const release = target.releaseSource === null ? releaseWorkflowFile(plan, target)
    : target.releaseUsable && plan.lanes.release.length ? mergeReleaseJob(target.releaseSource, plan, target) : target.releaseSource;
  const files: GateFile[] = [{ path: target.workflowPath, content: workflow, previous: target.workflowSource },
    { path: '.github/ci-gates.json', content: gateConfig(plan, target), previous: target.configSource }];
  if (target.workflowPath !== releasePath) files.push({ path: releasePath, content: release, previous: target.releaseSource });
  return files.filter(file => !same(file.previous, file.content, file.path.endsWith('.json')));
}
