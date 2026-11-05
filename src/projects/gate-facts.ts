import { parseDocument } from 'yaml';
import { emptyPlan, gateLanes, releasePath, type GatePlan, type MergeQueue, type Toolchains } from './gate-plan.js';
import { releaseWorkflow } from '../releases/workflow.js';

/**
 * What the control plane reads from GitHub for a gate onboarding turn: only what it needs to render and check the gate
 * files (the default branch, the merge queue, the existing gate and release files, open gate PRs). Studying the code is
 * the agent's job, in the project computer, on a checkout of the same commit.
 */
export interface GateFacts {
  repository: string; default_branch: string; head_sha: string; private: boolean;
  languages: { name: string; bytes: number }[];
  /** Root entries; directories end with `/`. */
  root: string[];
  /** Existing workflows; `gate_job` is the job that already runs gate.mjs, with the toolchains and installs before it. */
  workflows: { path: string; name: string; events: string[]; jobs: string[]; error?: string;
    gate_job?: { key: string; toolchains: Partial<Toolchains>; install: string[] } }[];
  /** Lock files at the root. */
  lockfiles: string[];
  existing: { ci_yml: boolean; ci_gates_yml: boolean; ci_gates_json: boolean; release_yml: boolean; gate_script: boolean; gate_workflow: string | null };
  /** Whether an existing release.yml can drive the console's release flow: tag-triggered, and whether it has other triggers. */
  release_workflow: { usable: boolean; reason: string; other_triggers: boolean } | null;
  gate_config: unknown;
  /** Current text of every workflow and of ci-gates.json: the base of an update PR and the check that it is still current. */
  sources: Record<string, string>;
  merge_queue: { state: MergeQueue; evidence: string };
  /** Status checks the default branch's rulesets require; null when the rulesets could not be read. */
  required_checks: string[] | null;
  open_gate_prs: { number: number; url: string; branch: string }[];
}
export interface FactReader {
  /** A GitHub REST GET relative to the API root; null for 404, throws otherwise. */
  get(path: string): Promise<any | null>;
  graphql(query: string, variables: Record<string, unknown>): Promise<any>;
}

const lockNames = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'poetry.lock', 'uv.lock', 'Pipfile.lock',
  'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock'];
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Reads the gate facts of the default branch; `full` is owner/name. */
export async function collectFacts(reader: FactReader, full: string): Promise<GateFacts> {
  const repo = `/repos/${encode(full)}`;
  const meta = await reader.get(repo);
  if (!meta) throw new Error('repository_not_found');
  const defaultBranch = String(meta.default_branch || 'main');
  let head: any;
  // An empty repository has no default branch commit; GitHub answers 409.
  try { head = await reader.get(`${repo}/git/ref/heads/${encode(defaultBranch)}`); } catch (error) { if (/409/.test(String((error as any)?.code ?? (error as Error).message))) head = null; else throw error; }
  const sha = String(head?.object?.sha || '');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('repository_empty');
  const content = async (path: string): Promise<string | null> => {
    const value = await reader.get(`${repo}/contents/${encode(path)}?ref=${sha}`);
    return value && !Array.isArray(value) && typeof value.content === 'string' ? Buffer.from(value.content, 'base64').toString('utf8') : null;
  };
  const tree = await reader.get(`${repo}/git/trees/${sha}`);
  const entries: any[] = Array.isArray(tree?.tree) ? tree.tree : [];
  const root = entries.map(entry => String(entry.path) + (entry.type === 'tree' ? '/' : '')).sort();
  const languages = Object.entries(await reader.get(`${repo}/languages`).catch(() => null) || {})
    .map(([name, bytes]) => ({ name, bytes: Number(bytes) })).sort((a, b) => b.bytes - a.bytes);

  const workflows: GateFacts['workflows'] = [], sources: Record<string, string> = {};
  const listing = root.includes('.github/') ? await reader.get(`${repo}/contents/.github/workflows?ref=${sha}`) : null;
  const workflowPaths = (Array.isArray(listing) ? listing : []).filter(item => item.type === 'file' && /\.ya?ml$/.test(String(item.name))).map(item => `.github/workflows/${item.name}`).sort();
  for (const path of workflowPaths) {
    const text = await content(path);
    if (text !== null) sources[path] = text;
    workflows.push(text === null ? { path, name: path, events: [], jobs: [], error: 'unreadable' } : describeWorkflow(path, text));
  }
  const gateText = await content('.github/ci-gates.json');
  if (gateText !== null) sources['.github/ci-gates.json'] = gateText;
  let gateConfig: unknown = null;
  if (gateText !== null) { try { gateConfig = JSON.parse(gateText); } catch { gateConfig = gateText; } }
  // The gate workflow CI-workflow names ci.yml wins over other workflows that also call gate.mjs.
  const gateWorkflows = workflows.filter(item => item.gate_job).map(item => item.path);
  const gateWorkflow = ['.github/workflows/ci.yml', '.github/workflows/ci-gates.yml'].find(path => gateWorkflows.includes(path)) ?? gateWorkflows[0] ?? null;
  const existing = { ci_yml: workflowPaths.includes('.github/workflows/ci.yml'), ci_gates_yml: workflowPaths.includes('.github/workflows/ci-gates.yml'), ci_gates_json: gateText !== null,
    release_yml: workflowPaths.includes(releasePath), gate_script: await content('scripts/gate/gate.mjs') !== null, gate_workflow: gateWorkflow };
  let release: GateFacts['release_workflow'] = null;
  if (sources[releasePath] !== undefined) {
    try {
      const checked = releaseWorkflow(sources[releasePath]!, 'v1.2.3'), events = workflows.find(item => item.path === releasePath)?.events ?? [];
      release = { usable: checked.matched, reason: checked.matched ? 'v1.2.3 这样的版本标签会触发它' : checked.reason || '版本标签不会触发它',
        other_triggers: checked.branch_trigger || events.some(event => !['push', 'workflow_dispatch'].includes(event)) };
    } catch (error) { release = { usable: false, reason: (error as Error).message, other_triggers: false }; }
  }
  const pulls = await reader.get(`${repo}/pulls?state=open&per_page=100`).catch(() => null);
  const openGatePrs = (Array.isArray(pulls) ? pulls : []).filter(pull => String(pull?.head?.ref || '').startsWith('bot/gate-onboarding-'))
    .map(pull => ({ number: Number(pull.number), url: String(pull.html_url), branch: String(pull.head.ref) }));
  const { rules, ...queue } = await mergeQueue(reader, full, defaultBranch);
  const requiredChecks = rules ? rules.filter(rule => rule?.type === 'required_status_checks')
    .flatMap(rule => (rule.parameters?.required_status_checks || []).map((check: any) => String(check?.context || ''))).filter(Boolean) : null;
  return { repository: full, default_branch: defaultBranch, head_sha: sha, private: !!meta.private, languages, root, workflows,
    lockfiles: lockNames.filter(name => root.includes(name)), existing, release_workflow: release, gate_config: gateConfig, sources, merge_queue: queue,
    required_checks: requiredChecks, open_gate_prs: openGatePrs };
}

/** Name, events, jobs and the gate job of an existing workflow; one that does not parse is reported, not guessed at. */
function describeWorkflow(path: string, text: string): GateFacts['workflows'][number] {
  const failed = { path, name: path, events: [], jobs: [], error: 'yaml_invalid' };
  const doc = parseDocument(text, { uniqueKeys: false });
  if (doc.errors.length) return failed;
  let data: any;
  try { data = doc.toJS({ maxAliasCount: 50 }); } catch { return failed; }
  const on = data?.on ?? data?.true; // YAML 1.1 readers turn `on` into true; keep both.
  const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : on && typeof on === 'object' ? Object.keys(on) : [];
  const jobs = data?.jobs && typeof data.jobs === 'object' ? data.jobs : {};
  let gateJob: NonNullable<GateFacts['workflows'][number]['gate_job']> | undefined;
  for (const [key, job] of Object.entries(jobs) as [string, any][]) {
    const steps: any[] = Array.isArray(job?.steps) ? job.steps : [];
    const gateAt = steps.findIndex(step => typeof step?.run === 'string' && step.run.includes('scripts/gate/gate.mjs') && !step.run.includes('--lane release'));
    if (gateAt < 0) continue;
    // What the gate job sets up before running gate.mjs is the starting point for toolchains and installs.
    const before = steps.slice(0, gateAt), toolchains: Partial<Toolchains> = {};
    for (const step of before) {
      const uses = String(step?.uses || ''), withs = step?.with || {};
      if (/^actions\/setup-node@/.test(uses) && withs['node-version'] != null) toolchains.node = String(withs['node-version']);
      if (/^actions\/setup-python@/.test(uses) && withs['python-version'] != null) toolchains.python = String(withs['python-version']);
      if (/^actions\/setup-go@/.test(uses)) toolchains.go = withs['go-version'] != null ? String(withs['go-version']) : String(withs['go-version-file'] || 'go.mod');
      if (/^actions\/setup-java@/.test(uses) && withs['java-version'] != null) toolchains.java = String(withs['java-version']);
    }
    gateJob = { key, toolchains, install: before.filter(step => typeof step?.run === 'string' && step.run.trim()).map(step => step.run.trim()) };
    break;
  }
  return { path, name: typeof data?.name === 'string' ? data.name : path, events, jobs: Object.keys(jobs), ...(gateJob ? { gate_job: gateJob } : {}) };
}

/**
 * Whether the default branch requires a merge queue. A ruleset's merge_queue rule says so directly; an unprotected branch
 * without one has none. Classic branch protection does not show it over REST, so GraphQL's mergeQueue settles that case.
 * Anything the token cannot read stays unknown and the person is asked.
 */
export async function mergeQueue(reader: FactReader, full: string, branch: string): Promise<GateFacts['merge_queue'] & { rules: any[] | null }> {
  const repo = `/repos/${encode(full)}`;
  let rules: any[] | null = null;
  try { const value = await reader.get(`${repo}/rules/branches/${encode(branch)}`); rules = Array.isArray(value) ? value : null; } catch { rules = null; }
  const queued = rules?.find(rule => rule?.type === 'merge_queue');
  if (queued) return { state: 'enabled', evidence: `默认分支 ${branch} 的规则集${queued.ruleset_id ? ` ${queued.ruleset_id} ` : ''}要求 merge queue`, rules };
  let protectedBranch: boolean | null = null;
  try { const value = await reader.get(`${repo}/branches/${encode(branch)}`); protectedBranch = typeof value?.protected === 'boolean' ? value.protected : null; } catch { protectedBranch = null; }
  if (rules && protectedBranch === false) return { state: 'disabled', evidence: `默认分支 ${branch} 的规则集没有 merge queue，也没有经典分支保护`, rules };
  try {
    const [owner, name] = full.split('/');
    const value = await reader.graphql('query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id}}}', { owner, name, branch });
    if (!value?.errors && value?.data?.repository) return value.data.repository.mergeQueue
      ? { state: 'enabled', evidence: `GitHub 报告默认分支 ${branch} 已启用 merge queue`, rules }
      : { state: 'disabled', evidence: `GitHub 报告默认分支 ${branch} 没有启用 merge queue`, rules };
  } catch { /* Falls through to unknown. */ }
  return { state: 'unknown', evidence: rules ? `默认分支 ${branch} 有分支保护，但安装令牌读不到它是否要求 merge queue` : '安装令牌读不到默认分支的规则集', rules };
}

/**
 * The plan a conversation starts from: a repository that already has gates starts from its own configuration (its build
 * lane folded into pr-ready), anything else from an empty plan that the agent's first turn fills.
 */
export function baselinePlan(facts: GateFacts): GatePlan {
  const plan = emptyPlan(), config = facts.gate_config && typeof facts.gate_config === 'object' ? facts.gate_config as any : null;
  if (!config) return plan;
  const list = (raw: unknown) => (typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []).filter((item: unknown): item is string => typeof item === 'string' && !!item.trim());
  const lanes = config.lanes && typeof config.lanes === 'object' ? config.lanes : {}, build = list(lanes.build?.commands);
  for (const lane of gateLanes) plan.lanes[lane] = list(lanes[lane]?.commands);
  plan.lanes['pr-ready'] = [...build, ...plan.lanes['pr-ready'].filter(command => !build.includes(command))];
  plan.observe = gateLanes.filter(lane => lanes[lane]?.enforcement === 'observe');
  const gate = facts.workflows.find(item => item.path === facts.existing.gate_workflow)?.gate_job;
  if (gate) { plan.toolchains = { ...plan.toolchains, ...gate.toolchains }; plan.install = gate.install; }
  plan.workflow = facts.existing.gate_workflow ?? '';
  return plan;
}
