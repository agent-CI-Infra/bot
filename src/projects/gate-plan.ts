/**
 * The gate plan settled in the onboarding conversation, and the files the control plane renders from it.
 *
 * The plan holds only what a person can check: the toolchains to set up, the dependency installs and each lane's
 * commands. Triggers, permissions and the job layout are decided here from repository facts (the default branch and
 * whether a merge queue is on), so neither the model nor repository text can change what the workflow is allowed to do.
 */
export const gateLanes = ['build', 'pr-ready', 'pr-merge', 'daily', 'release'] as const;
export type Lane = typeof gateLanes[number];
export type MergeQueue = 'enabled' | 'disabled' | 'unknown';

/** When each lane runs under CI-workflow's event mapping; shown before onboarding starts and in the PR. */
export const laneTimes: Record<Lane, string> = {
  build: 'PR 每次更新时、merge queue 中和合入默认分支后都会跑，确认代码能构建',
  'pr-ready': 'PR 每次更新时跑，对 PR head 提交检查，放 lint、单元测试等合入前必须通过的检查',
  'pr-merge': '进入 merge queue 后对排队中的合并结果跑；仓库没有 merge queue 时不会触发',
  daily: '每天定时（北京时间 0 点）在默认分支跑，放耗时较长的全量或端到端测试',
  release: '推送版本标签（如 v1.2.3）时跑，发布前的最后检查',
};

/** Toolchain versions; an empty string means the toolchain is not set up. Node always runs gate.mjs. */
export interface Toolchains { node: string; python: string; go: string; java: string }
export interface GatePlan { toolchains: Toolchains; install: string[]; lanes: Record<Lane, string[]> }
/** What the control plane decides from facts, never from the plan. */
export interface GateTarget {
  defaultBranch: string;
  mergeQueue: 'enabled' | 'disabled';
  /** `.github/workflows/ci.yml`, or `ci-gates.yml` beside an existing ci.yml that is never overwritten. */
  workflowPath: string;
  /** Whether this PR adds release.yml (a repository that has one keeps it). */
  releaseWorkflow: boolean;
  /** package-lock.json exists, so setup-node may cache npm. */
  npmLock: boolean;
}

export const emptyPlan = (): GatePlan => ({ toolchains: { node: '22', python: '', go: '', java: '' }, install: [],
  lanes: Object.fromEntries(gateLanes.map(lane => [lane, []])) as unknown as Record<Lane, string[]> });

/** Thrown for a plan the control plane will not render; `code` is shown to the person or the model. */
export class PlanError extends Error { constructor(readonly code: string, readonly detail: string) { super(code); } }

// A token in a plan would be committed to the repository; these are GitHub's own token formats.
const tokenPattern = /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/;
const control = /[\u0000-\u0008\u000b-\u001f\u007f]/;

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
  const plan: GatePlan = {
    toolchains: { node: version(tools.node, 'Node 版本') || '22', python: version(tools.python, 'Python 版本'), go: version(tools.go, 'Go 版本'), java: version(tools.java, 'Java 版本') },
    install: commands(value.install, '安装命令', true),
    lanes: Object.fromEntries(gateLanes.map(lane => [lane, commands(lanes[lane], `lane ${lane}`, false)])) as Record<Lane, string[]>,
  };
  const text = JSON.stringify(plan);
  if (tokenPattern.test(text) || [...secrets].some(secret => secret.length >= 8 && text.includes(secret)))
    throw new PlanError('gate_plan_secret', '方案里像是包含了令牌或密钥，不能写进仓库');
  return plan;
}

/** pr-merge only runs on merge_group; with a merge queue this PR leaves out every gate that runs after a PR leaves review. */
export function effectivePlan(plan: GatePlan, target: Pick<GateTarget, 'mergeQueue'>): GatePlan {
  return target.mergeQueue === 'enabled' ? { ...plan, lanes: { ...plan.lanes, 'pr-merge': [] } } : plan;
}

/** The events the gate workflow listens to, in workflow order. */
export function gateEvents(plan: GatePlan, target: GateTarget): string[] {
  const events = ['pull_request'];
  // Without a merge queue the CI-workflow mapping stays whole: merge_group (pr-merge) and push to the default branch (build).
  if (target.mergeQueue === 'disabled') events.push('merge_group', 'push');
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

/** The gate workflow: one `gate` job runs the lanes CI-workflow maps to the triggering event. */
export function gateWorkflow(plan: GatePlan, target: GateTarget): string {
  const events = gateEvents(plan, target), triggers: Record<string, string> = {
    pull_request: '  pull_request:\n',
    merge_group: '  merge_group:\n',
    push: `  push:\n    branches: [${q(target.defaultBranch)}]\n`,
    schedule: "  schedule:\n    # Daily lane: 16:00 UTC = 00:00 Asia/Shanghai.\n    - cron: '0 16 * * *'\n",
    release: '  release:\n    types: [published]\n',
    workflow_dispatch: '  workflow_dispatch:\n',
  };
  const queue = target.mergeQueue === 'enabled'
    ? '# This repository uses a merge queue. Only the gates that run before a PR enters the queue are\n# included: no merge_group trigger and no gate on pushes to the default branch.\n'
    : '';
  return `# CI gates (CI-workflow), generated from the commands confirmed during onboarding.
# One job runs every lane mapped to the current event; lane commands live in .github/ci-gates.json.
# On pull_request the reports name the PR head commit, not GitHub's merge commit.
${queue}name: ${target.workflowPath.endsWith('/ci.yml') ? 'CI' : q('CI gates')}

on:
${events.map(event => triggers[event]).join('')}
permissions:
  contents: read

concurrency:
  group: ci-gates-\${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  gate:
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

/** .github/ci-gates.json; an empty lane reports not_applicable, which means "not configured", never "passed". */
export function gateConfig(plan: GatePlan, target: GateTarget): string {
  const lanes = effectivePlan(plan, target).lanes;
  return JSON.stringify({ version: 1, level: 'C1', preset: 'auto', lanes: Object.fromEntries(gateLanes.map(lane => [lane, { commands: lanes[lane] }])) }, null, 2) + '\n';
}

/** Every file this PR adds, rendered from the plan; gate.mjs is copied from CI-workflow when the PR is created. */
export function gateFiles(plan: GatePlan, target: GateTarget): { path: string; content: string }[] {
  const effective = effectivePlan(plan, target);
  return [{ path: target.workflowPath, content: gateWorkflow(effective, target) }, { path: '.github/ci-gates.json', content: gateConfig(effective, target) },
    ...(target.releaseWorkflow ? [{ path: '.github/workflows/release.yml', content: releaseWorkflowFile(effective, target) }] : [])];
}
