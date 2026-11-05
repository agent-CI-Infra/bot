import { parseDocument, parse, isMap, isSeq, isScalar, YAMLMap, type Document } from 'yaml';

/**
 * The gate plan settled in the onboarding conversation, and the files the control plane renders from it.
 *
 * The plan holds only what a person can check: the toolchains to set up, the dependency installs, each lane's commands,
 * which lanes only record failures, and which workflow file holds the gate job. Triggers, permissions and the job layout
 * are decided here from repository facts (the default branch and whether a merge queue is on), so neither the model nor
 * repository text can change what the workflow is allowed to do.
 */
export const gateLanes = ['build', 'pr-ready', 'pr-merge', 'daily', 'release'] as const;
export type Lane = typeof gateLanes[number];
export type MergeQueue = 'enabled' | 'disabled' | 'unknown';

/** When each lane runs under CI-workflow's event mapping; shown before onboarding starts and in the PR. */
export const laneTimes: Record<Lane, string> = {
  build: 'PR 每次更新时和进入 merge queue 后都会跑（没有 merge queue 的仓库在合入默认分支后也跑），确认代码能构建',
  'pr-ready': 'PR 每次更新时跑，对 PR head 提交检查，放 lint、单元测试等合入前必须通过的检查',
  'pr-merge': '进入 merge queue 后对排队中的合并结果跑；仓库没有 merge queue 时不会触发',
  daily: '每天定时（北京时间 0 点）在默认分支跑，放耗时较长的全量或端到端测试',
  release: '推送版本标签（如 v1.2.3）时跑，发布前的最后检查',
};

/** Toolchain versions; an empty string means the toolchain is not set up. Node always runs gate.mjs. */
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
  /** Whether this PR adds release.yml (a repository that has one keeps it). */
  releaseWorkflow: boolean;
  /** package-lock.json exists, so setup-node may cache npm. */
  npmLock: boolean;
}
/** One file of the gate PR; `previous` is its content on the default branch, null for a new file. */
export interface GateFile { path: string; content: string; previous: string | null }

export const emptyPlan = (): GatePlan => ({ toolchains: { node: '22', python: '', go: '', java: '' }, install: [],
  lanes: Object.fromEntries(gateLanes.map(lane => [lane, []])) as unknown as Record<Lane, string[]>, observe: ['daily'], workflow: '' });

/** Thrown for a plan the control plane will not render; `code` is shown to the person or the model. */
export class PlanError extends Error { constructor(readonly code: string, readonly detail: string) { super(code); } }

// A token in a plan would be committed to the repository; these are GitHub's own token formats.
const tokenPattern = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/;
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
 * written into the repository (the run's tokens and model key).
 */
export function normalizePlan(input: unknown, secrets: Iterable<string> = []): GatePlan {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PlanError('gate_plan_invalid', '方案必须是对象');
  const value = input as any, tools = value.toolchains ?? {};
  if (typeof tools !== 'object' || Array.isArray(tools)) throw new PlanError('gate_plan_invalid', 'toolchains 必须是对象');
  const lanes = value.lanes ?? {};
  if (typeof lanes !== 'object' || Array.isArray(lanes)) throw new PlanError('gate_plan_invalid', 'lanes 必须是对象');
  const unknown = Object.keys(lanes).find(lane => !(gateLanes as readonly string[]).includes(lane));
  if (unknown) throw new PlanError('gate_plan_invalid', `未知的 lane：${unknown}`);
  const observe = value.observe ?? ['daily'];
  if (!Array.isArray(observe) || observe.some(lane => !(gateLanes as readonly string[]).includes(lane))) throw new PlanError('gate_plan_invalid', 'observe 只能列出五个 lane 的名字');
  const workflow = value.workflow ?? '';
  if (typeof workflow !== 'string' || (workflow && !workflowPathPattern.test(workflow))) throw new PlanError('gate_plan_invalid', 'workflow 必须是 .github/workflows/ 下的 YAML 文件');
  const plan: GatePlan = {
    toolchains: { node: version(tools.node, 'Node 版本') || '22', python: version(tools.python, 'Python 版本'), go: version(tools.go, 'Go 版本'), java: version(tools.java, 'Java 版本') },
    install: commands(value.install, '安装命令', true),
    lanes: Object.fromEntries(gateLanes.map(lane => [lane, commands(lanes[lane], `lane ${lane}`, false)])) as Record<Lane, string[]>,
    observe: gateLanes.filter(lane => observe.includes(lane)), workflow,
  };
  const text = JSON.stringify(plan);
  if (tokenPattern.test(text) || [...secrets].some(secret => secret.length >= 8 && text.includes(secret)))
    throw new PlanError('gate_plan_secret', '方案里像是包含了令牌或密钥，不能写进仓库');
  return plan;
}

/**
 * The events the gate job runs on, in workflow order. merge_group always reports, so `gate` can be a required check under
 * a merge queue. With a merge queue the gate does not run again after merging: no push to the default branch.
 */
export function gateEvents(plan: GatePlan, target: Pick<GateTarget, 'mergeQueue' | 'releaseWorkflow'>): string[] {
  const events = ['pull_request', 'merge_group'];
  if (target.mergeQueue === 'disabled') events.push('push');
  if (plan.lanes.daily.length) events.push('schedule');
  // The release lane runs from release.yml on a version tag; a repository that keeps its own release.yml gets it on releases.
  if (!target.releaseWorkflow && plan.lanes.release.length) events.push('release');
  events.push('workflow_dispatch');
  return events;
}

const q = (value: string) => JSON.stringify(value); // A JSON string is a valid YAML double-quoted scalar.
function setupSteps(plan: GatePlan, target: GateTarget): string {
  const { node, python, go, java } = plan.toolchains, npm = target.npmLock && plan.install.some(command => /^npm\s+(?:ci|install|i)\b/.test(command));
  let steps = `      - name: Checkout
        uses: actions/checkout@v4

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
          ${go === 'go.mod' ? 'go-version-file: go.mod' : `go-version: ${q(go)}`}
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
  release: () => '  release:\n    types: [published]\n',
  workflow_dispatch: () => '  workflow_dispatch:\n',
};

function gateJob(plan: GatePlan, target: GateTarget): string {
  return `  gate:
    name: gate
    runs-on: ubuntu-latest
    env:
      # pull_request: report the PR head, not GitHub's merge commit.
      CI_GATES_SHA: \${{ github.event.pull_request.head.sha || github.sha }}
    steps:
${setupSteps(plan, target)}
      - name: Run gate lanes
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: node scripts/gate/gate.mjs run --event "$GITHUB_EVENT_NAME"
${upload('ci-gates-reports')}`;
}

/** A new gate workflow: one `gate` job runs the lanes CI-workflow maps to the triggering event. */
export function gateWorkflow(plan: GatePlan, target: GateTarget): string {
  const queue = target.mergeQueue === 'enabled'
    ? '# This repository uses a merge queue: the gate runs on pull requests and in the queue (merge_group),\n# and not again after merging (no push to the default branch).\n'
    : '';
  return `# CI gates (CI-workflow), generated from the commands confirmed during onboarding.
# One job runs every lane mapped to the current event; lane commands live in .github/ci-gates.json.
# On pull_request the reports name the PR head commit, not GitHub's merge commit.
${queue}name: ${target.workflowPath.endsWith('/ci.yml') ? 'CI' : q('CI gates')}

on:
${gateEvents(plan, target).map(event => triggerText[event]!(target.defaultBranch)).join('')}
permissions:
  contents: read

# Only pull request runs of the same branch replace each other; a push never cancels a queue or daily run.
concurrency:
  group: ci-gates-\${{ github.workflow }}-\${{ github.event_name }}-\${{ github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
${gateJob(plan, target)}`;
}

/** The job that already runs gate.mjs in a workflow, if any. */
export function gateJobKey(doc: Document): string | null {
  const jobs = doc.get('jobs', true);
  if (!isMap(jobs)) return null;
  for (const pair of jobs.items) {
    const steps = isMap(pair.value) ? pair.value.get('steps', true) : null;
    if (isSeq(steps) && steps.items.some(step => isMap(step) && String(step.get('run') ?? '').includes('scripts/gate/gate.mjs')))
      return String(isScalar(pair.key) ? pair.key.value : pair.key);
  }
  return null;
}

/**
 * The gate job merged into an existing workflow. The job that already runs gate.mjs is replaced (keeping its display name,
 * which is the required-check context); otherwise a `gate` job is added. Missing triggers are added, none is removed: when
 * the file has other triggers, the job's own `if:` limits it to the gate events, so other jobs and their triggers stay.
 */
export function mergeGateJob(source: string, plan: GatePlan, target: GateTarget): string {
  const doc = parseDocument(source);
  if (doc.errors.length || !isMap(doc.contents)) throw new PlanError('gate_workflow_invalid', `${target.workflowPath} 不是有效的 workflow YAML，不能并入门禁 job`);
  const events = gateEvents(plan, target), generated = parseDocument(`jobs:\n${gateJob(plan, target)}`);
  const job = generated.getIn(['jobs', 'gate'], true) as YAMLMap;
  let jobs = doc.get('jobs', true);
  if (!isMap(jobs)) { jobs = doc.createNode({}) as YAMLMap; doc.set('jobs', jobs); }
  const existing = gateJobKey(doc), key = existing ?? (!(jobs as YAMLMap).has('gate') ? 'gate' : 'ci-gates');
  const previous = existing ? (jobs as YAMLMap).get(existing, true) : null;
  if (isMap(previous) && previous.has('name')) job.set('name', previous.get('name'));
  (jobs as YAMLMap).set(key, job);
  // `on: push` and `on: [push, pull_request]` become a map so triggers can be added.
  let on = doc.get('on', true);
  if (isScalar(on) || isSeq(on)) {
    const names = isScalar(on) ? [String(on.value)] : on.items.map(item => String(isScalar(item) ? item.value : item));
    on = doc.createNode(Object.fromEntries(names.map(name => [name, null]))) as YAMLMap; doc.set('on', on);
  } else if (!isMap(on)) { on = doc.createNode({}) as YAMLMap; doc.set('on', on); }
  const values: Record<string, unknown> = { push: { branches: [target.defaultBranch] }, schedule: [{ cron: '0 16 * * *' }], release: { types: ['published'] } };
  for (const event of events) if (!(on as YAMLMap).has(event)) (on as YAMLMap).set(event, values[event] ?? null);
  const others = (on as YAMLMap).items.map(pair => String(isScalar(pair.key) ? pair.key.value : pair.key)).filter(event => !events.includes(event));
  if (others.length) job.items.splice(1, 0, doc.createPair('if', events.map(event => `github.event_name == '${event}'`).join(' || ')));
  // Untouched parts keep their usual style: no folding of long lines, `[main]` rather than `[ main ]`, empty rather than `null`.
  return doc.toString({ lineWidth: 0, nullStr: '', flowCollectionPadding: false });
}

/** release.yml: a version tag runs the release lane; the console's release flow needs this tag trigger. */
export function releaseWorkflowFile(plan: GatePlan, target: GateTarget): string {
  return `# Release gate: a version tag runs the repository-configured release lane on the tagged commit.
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
  gate:
    name: release
    runs-on: ubuntu-latest
    steps:
${setupSteps(plan, target)}
      - name: Gate lane release
        run: node scripts/gate/gate.mjs run --lane release
${upload('ci-gates-release')}`;
}

/**
 * .github/ci-gates.json. An existing file keeps every key the plan does not own (level, caseCatalog, events, timeouts…);
 * an empty lane reports not_applicable, which means "not configured", never "passed".
 */
export function gateConfig(plan: GatePlan, target: Pick<GateTarget, 'configSource'>): string {
  let base: Record<string, any> = { version: 1, level: 'C1', preset: 'auto' };
  if (target.configSource !== null) {
    try { const parsed = JSON.parse(target.configSource); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed; } catch { /* Rewritten whole; the diff shows it. */ }
  }
  const lanes: Record<string, any> = base.lanes && typeof base.lanes === 'object' && !Array.isArray(base.lanes) ? { ...base.lanes } : {};
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
  return JSON.stringify({ ...base, lanes }, null, 2) + '\n';
}

/** Two texts with the same parsed value; formatting differences alone do not make a file part of the PR. */
function same(previous: string | null, content: string, json: boolean): boolean {
  if (previous === null) return false;
  try { return JSON.stringify(json ? JSON.parse(previous) : parse(previous)) === JSON.stringify(json ? JSON.parse(content) : parse(content)); }
  catch { return previous === content; }
}

/** The files this PR adds or changes, rendered from the plan; gate.mjs is copied from CI-workflow when the PR is created. */
export function gateFiles(plan: GatePlan, target: GateTarget): GateFile[] {
  const workflow = target.workflowSource === null ? gateWorkflow(plan, target) : mergeGateJob(target.workflowSource, plan, target);
  const files: GateFile[] = [{ path: target.workflowPath, content: workflow, previous: target.workflowSource },
    { path: '.github/ci-gates.json', content: gateConfig(plan, target), previous: target.configSource },
    ...(target.releaseWorkflow ? [{ path: '.github/workflows/release.yml', content: releaseWorkflowFile(plan, target), previous: null }] : [])];
  return files.filter(file => !same(file.previous, file.content, file.path.endsWith('.json')));
}
