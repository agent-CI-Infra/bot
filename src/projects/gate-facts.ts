import { parseDocument } from 'yaml';
import { emptyPlan, gateLanes, releasePath, type GatePlan, type MergeQueue, type Toolchains } from './gate-plan.js';
import { releaseWorkflow } from '../releases/workflow.js';

/**
 * Repository facts for gate onboarding, read with a read-only installation token before anything is proposed.
 * The agent and the person see the same facts; commands found here are candidates with their sources, never run.
 */
export interface Candidate { kind: 'install' | 'build' | 'lint' | 'test' | 'e2e'; command: string; source: string; certain: boolean }
export interface GateFacts {
  repository: string; default_branch: string; head_sha: string; private: boolean;
  languages: { name: string; bytes: number }[];
  /** Every path of the default branch (directories end with `/`), without vendored or generated directories. */
  tree: string[];
  /** The listing was cut short: by GitHub (very large repositories) or at the size the facts keep. */
  tree_truncated: boolean;
  /** Root entries; directories end with `/`. */
  root: string[];
  /** Existing workflows; `gate_job` is the job that already runs gate.mjs, with the toolchains and installs before it. */
  workflows: { path: string; name: string; events: string[]; jobs: string[]; runs: string[]; toolchains: Partial<Toolchains>; error?: string;
    gate_job?: { key: string; toolchains: Partial<Toolchains>; install: string[] } }[];
  /** Manifests anywhere near the top, the README, version files and test or build scripts, keyed by path; long files are clipped. */
  files: Record<string, string>;
  lockfiles: string[];
  existing: { ci_yml: boolean; ci_gates_yml: boolean; ci_gates_json: boolean; release_yml: boolean; gate_script: boolean; gate_workflow: string | null };
  /** Whether an existing release.yml can drive the console's release flow (version tag trigger). */
  release_workflow: { usable: boolean; reason: string } | null;
  gate_config: unknown;
  /** Current text of every workflow and of ci-gates.json: the base of an update PR and the check that it is still current. */
  sources: Record<string, string>;
  merge_queue: { state: MergeQueue; evidence: string };
  /** Status checks the default branch's rulesets require; null when the rulesets could not be read. */
  required_checks: string[] | null;
  /** Recent completed Actions runs, newest first, with how long each took: what "fast enough" means for this repository. */
  actions_runs: { workflow: string; event: string; conclusion: string; minutes: number; started_at: string }[] | null;
  open_gate_prs: { number: number; url: string; branch: string }[];
  candidates: Candidate[];
  /** What the person must answer before a command can be proposed with confidence. */
  questions: string[];
}
export interface FactReader {
  /** A GitHub REST GET relative to the API root; null for 404, throws `github_http_<status>` otherwise. */
  get(path: string): Promise<any | null>;
  graphql(query: string, variables: Record<string, unknown>): Promise<any>;
}

const manifestNames = new Set(['package.json', '.nvmrc', '.node-version', 'pyproject.toml', 'setup.cfg', 'setup.py', 'tox.ini', 'noxfile.py', 'pytest.ini',
  'requirements.txt', 'requirements-dev.txt', 'Pipfile', '.python-version', 'Makefile', 'makefile', 'GNUmakefile', 'go.mod', 'Cargo.toml',
  'justfile', 'Justfile', 'Taskfile.yml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'CMakeLists.txt', 'Gemfile', 'composer.json',
  'deno.json', '.tool-versions']);
const lockNames = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'poetry.lock', 'uv.lock', 'Pipfile.lock',
  'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock']);
// Directories that hold dependencies or build output rather than the repository's own code.
const skipped = /(?:^|\/)(?:node_modules|vendor|third_party|dist|build|out|target|\.venv|venv|__pycache__|\.git)\//;
// Scripts a repository runs its checks with: scripts/test.sh, tools/lint.py, ci/build.sh, a root check.sh …
const scriptPattern = /^(?:(?:scripts?|tools|ci|bin|hack)\/)?[^/]*(?:test|lint|check|build|verify|ci)[^/]*\.(?:sh|bash|py|mjs|js|ps1)$/i;
const clipBytes = 32 * 1024, treeLimit = 5000, readLimit = 40;
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const base = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dir = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const clip = (text: string) => text.length > clipBytes ? text.slice(0, clipBytes) + `\n[… ${text.length - clipBytes} characters omitted; read the file for the rest …]` : text;

/** Reads every fact onboarding needs; `full` is owner/name. */
export async function collectFacts(reader: FactReader, full: string): Promise<GateFacts> {
  const repo = `/repos/${encode(full)}`;
  const meta = await reader.get(repo);
  if (!meta) throw new Error('repository_not_found');
  const defaultBranch = String(meta.default_branch || 'main');
  let head: any;
  // An empty repository has no default branch commit; GitHub answers 409.
  try { head = await reader.get(`${repo}/git/ref/heads/${encode(defaultBranch)}`); } catch (error) { if ((error as Error).message === 'github_http_409') head = null; else throw error; }
  const sha = String(head?.object?.sha || '');
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('repository_empty');
  const content = async (path: string): Promise<string | null> => {
    const value = await reader.get(`${repo}/contents/${encode(path)}?ref=${sha}`);
    return value && !Array.isArray(value) && typeof value.content === 'string' ? Buffer.from(value.content, 'base64').toString('utf8') : null;
  };
  // The whole tree shows how the repository is laid out: sub-projects, test directories, scripts.
  const tree = await reader.get(`${repo}/git/trees/${sha}?recursive=1`);
  const entries: any[] = (Array.isArray(tree?.tree) ? tree.tree : []).filter((entry: any) => !skipped.test(String(entry.path) + '/'));
  const paths = entries.map(entry => String(entry.path) + (entry.type === 'tree' ? '/' : '')).sort();
  const blobs = entries.filter(entry => entry.type === 'blob').map(entry => String(entry.path));
  const has = (path: string) => blobs.includes(path);
  const root = paths.filter(path => !path.replace(/\/$/, '').includes('/'));
  const languages = Object.entries(await reader.get(`${repo}/languages`).catch(() => null) || {})
    .map(([name, bytes]) => ({ name, bytes: Number(bytes) })).sort((a, b) => b.bytes - a.bytes);

  // Manifests up to three directories deep, the README and check scripts, shallowest first, within a reading budget.
  const depth = (path: string) => path.split('/').length;
  const readme = blobs.find(path => /^readme(?:\.md|\.rst|\.txt)?$/i.test(path));
  const wanted = [...(readme ? [readme] : []), ...blobs.filter(path => manifestNames.has(base(path)) && depth(path) <= 4).sort((a, b) => depth(a) - depth(b) || a.localeCompare(b)),
    ...blobs.filter(path => scriptPattern.test(path))].filter((path, index, all) => all.indexOf(path) === index).slice(0, readLimit);
  const files: Record<string, string> = {};
  for (const path of wanted) { const text = await content(path); if (text !== null) files[path] = clip(text); }

  const workflows: GateFacts['workflows'] = [], sources: Record<string, string> = {};
  const workflowPaths = blobs.filter(path => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)).sort();
  for (const path of workflowPaths) {
    const text = await content(path);
    if (text !== null) sources[path] = text;
    workflows.push(text === null ? { path, name: path, events: [], jobs: [], runs: [], toolchains: {}, error: 'unreadable' } : describeWorkflow(path, text));
  }
  const gateText = await content('.github/ci-gates.json');
  if (gateText !== null) sources['.github/ci-gates.json'] = gateText;
  let gateConfig: unknown = null;
  if (gateText !== null) { try { gateConfig = JSON.parse(gateText); } catch { gateConfig = gateText; } }
  // The gate workflow CI-workflow names ci.yml wins over other workflows that also call gate.mjs.
  const gateWorkflows = workflows.filter(item => item.gate_job).map(item => item.path);
  const gateWorkflow = ['.github/workflows/ci.yml', '.github/workflows/ci-gates.yml'].find(path => gateWorkflows.includes(path)) ?? gateWorkflows[0] ?? null;
  const existing = { ci_yml: workflowPaths.includes('.github/workflows/ci.yml'), ci_gates_yml: workflowPaths.includes('.github/workflows/ci-gates.yml'), ci_gates_json: gateText !== null,
    release_yml: workflowPaths.includes(releasePath), gate_script: has('scripts/gate/gate.mjs'), gate_workflow: gateWorkflow };
  let release: GateFacts['release_workflow'] = null;
  if (sources[releasePath] !== undefined) {
    try { const checked = releaseWorkflow(sources[releasePath]!, 'v1.2.3'); release = { usable: checked.matched, reason: checked.matched ? 'v1.2.3 这样的版本标签会触发它' : checked.reason || '版本标签不会触发它' }; }
    catch (error) { release = { usable: false, reason: (error as Error).message }; }
  }
  const runs = await reader.get(`${repo}/actions/runs?status=completed&per_page=30`).catch(() => null);
  const actionsRuns = Array.isArray(runs?.workflow_runs) ? runs.workflow_runs.map((run: any) => ({ workflow: String(run.path || run.name || ''), event: String(run.event || ''),
    conclusion: String(run.conclusion || ''), started_at: String(run.run_started_at || run.created_at || ''),
    minutes: Math.round((Date.parse(run.updated_at) - Date.parse(run.run_started_at || run.created_at)) / 6000) / 10 })).filter((run: any) => Number.isFinite(run.minutes)) : null;
  const pulls = await reader.get(`${repo}/pulls?state=open&per_page=100`).catch(() => null);
  const openGatePrs = (Array.isArray(pulls) ? pulls : []).filter(pull => String(pull?.head?.ref || '').startsWith('bot/gate-onboarding-'))
    .map(pull => ({ number: Number(pull.number), url: String(pull.html_url), branch: String(pull.head.ref) }));
  const { rules, ...queue } = await mergeQueue(reader, full, defaultBranch);
  const requiredChecks = rules ? rules.filter(rule => rule?.type === 'required_status_checks')
    .flatMap(rule => (rule.parameters?.required_status_checks || []).map((check: any) => String(check?.context || ''))).filter(Boolean) : null;
  const facts: GateFacts = { repository: full, default_branch: defaultBranch, head_sha: sha, private: !!meta.private, languages,
    tree: paths.slice(0, treeLimit), tree_truncated: !!tree?.truncated || paths.length > treeLimit, root, workflows, files,
    lockfiles: blobs.filter(path => lockNames.has(base(path))), existing, release_workflow: release, gate_config: gateConfig, sources, merge_queue: queue,
    required_checks: requiredChecks, actions_runs: actionsRuns, open_gate_prs: openGatePrs, candidates: [], questions: [] };
  detect(facts, has);
  return facts;
}

/** Name, events, jobs, run commands and toolchain setups of an existing workflow; one that does not parse is reported, not guessed at. */
function describeWorkflow(path: string, text: string): GateFacts['workflows'][number] {
  const failed = { path, name: path, events: [], jobs: [], runs: [], toolchains: {}, error: 'yaml_invalid' };
  const doc = parseDocument(text, { uniqueKeys: false });
  if (doc.errors.length) return failed;
  let data: any;
  try { data = doc.toJS({ maxAliasCount: 50 }); } catch { return failed; }
  const on = data?.on ?? data?.true; // YAML 1.1 readers turn `on` into true; keep both.
  const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : on && typeof on === 'object' ? Object.keys(on) : [];
  const runs: string[] = [], jobs = data?.jobs && typeof data.jobs === 'object' ? data.jobs : {}, toolchains: Partial<Toolchains> = {};
  // The toolchain versions a set of setup steps installs.
  const setups = (steps: any[]) => {
    const found: Partial<Toolchains> = {};
    for (const step of steps) {
      const uses = String(step?.uses || ''), withs = step?.with || {};
      if (/^actions\/setup-node@/.test(uses) && withs['node-version'] != null) found.node = String(withs['node-version']);
      if (/^actions\/setup-python@/.test(uses) && withs['python-version'] != null) found.python = String(withs['python-version']);
      if (/^actions\/setup-go@/.test(uses)) found.go = withs['go-version'] != null ? String(withs['go-version']) : String(withs['go-version-file'] || 'go.mod');
      if (/^actions\/setup-java@/.test(uses) && withs['java-version'] != null) found.java = String(withs['java-version']);
    }
    return found;
  };
  let gateJob: NonNullable<GateFacts['workflows'][number]['gate_job']> | undefined;
  for (const [key, job] of Object.entries(jobs) as [string, any][]) {
    const steps: any[] = Array.isArray(job?.steps) ? job.steps : [];
    for (const step of steps) if (typeof step?.run === 'string') runs.push(step.run.trim());
    Object.assign(toolchains, setups(steps));
    const gateAt = steps.findIndex(step => typeof step?.run === 'string' && step.run.includes('scripts/gate/gate.mjs') && !step.run.includes('--lane release'));
    if (gateAt < 0 || gateJob) continue;
    // What the gate job sets up before running gate.mjs is the starting point for toolchains and installs.
    const before = steps.slice(0, gateAt);
    gateJob = { key, toolchains: setups(before), install: before.filter(step => typeof step?.run === 'string' && step.run.trim()).map(step => step.run.trim()) };
  }
  return { path, name: typeof data?.name === 'string' ? data.name : path, events, jobs: Object.keys(jobs), runs, toolchains, ...(gateJob ? { gate_job: gateJob } : {}) };
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

const tomlSection = (text: string, name: string) => new RegExp(`^\\[${name.replace(/\./g, '\\.')}\\]`, 'm').test(text);
const makeTargets = (text: string) => [...text.matchAll(/^([A-Za-z0-9][\w./-]*)\s*:(?!=)/gm)].map(match => match[1]!);
// A command run inside a sub-project: `(cd textkit && npm test)`, or as is at the root.
const inDir = (where: string, command: string) => where ? `(cd ${where} && ${command})` : command;
const kindOf = (text: string): Candidate['kind'] | null => /\b(?:e2e|playwright|cypress|integration)\b/i.test(text) ? 'e2e'
  : /\b(?:test|tests|pytest|unittest|tox|nox|spec)\b/i.test(text) ? 'test'
  : /\b(?:lint|ruff|eslint|flake8|clippy|vet|typecheck|mypy|check|format)\b/i.test(text) ? 'lint' : /\b(?:build|compile|package)\b/i.test(text) ? 'build' : null;

/** Candidate commands with their sources, and what to ask about the rest. */
function detect(facts: GateFacts, has: (name: string) => boolean): void {
  // A command found in several places is one candidate with every source; any certain source makes it certain.
  const { files } = facts, add = (kind: Candidate['kind'], command: string, source: string, certain = true) => {
    const found = facts.candidates.find(item => item.kind === kind && item.command === command);
    if (!found) facts.candidates.push({ kind, command, source, certain });
    else { if (!found.source.split('；').includes(source)) found.source += '；' + source; found.certain ||= certain; }
  };
  const manifests = Object.keys(files).filter(path => manifestNames.has(base(path)));
  // Scripts the repository keeps for its own checks are its entry points.
  for (const path of Object.keys(files).filter(path => scriptPattern.test(path))) {
    const kind = kindOf(base(path)) ?? 'test', runner = /\.py$/.test(path) ? 'python3' : /\.m?js$/.test(path) ? 'node' : /\.ps1$/.test(path) ? 'pwsh' : 'sh';
    add(kind, `${runner} ${path}`, path);
  }
  for (const path of manifests.filter(path => base(path) === 'package.json')) {
    const where = dir(path), inside = (name: string) => has(where ? `${where}/${name}` : name);
    let pkg: any = null; try { pkg = JSON.parse(files[path]!); } catch { facts.questions.push(`${path} 无法解析，这个 Node 项目的构建和测试命令需要你确认。`); continue; }
    const manager = inside('pnpm-lock.yaml') ? 'pnpm' : inside('yarn.lock') ? 'yarn' : 'npm', scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const dependencies = ['dependencies', 'devDependencies', 'optionalDependencies'].some(key => pkg[key] && Object.keys(pkg[key]).length);
    if (inside('package-lock.json') || inside('npm-shrinkwrap.json')) add('install', inDir(where, 'npm ci'), `${where ? where + '/' : ''}package-lock.json`);
    else if (manager === 'pnpm') add('install', inDir(where, 'corepack enable && pnpm install --frozen-lockfile'), path, false);
    else if (manager === 'yarn') add('install', inDir(where, 'corepack enable && yarn install --immutable'), path, false);
    else if (dependencies) { add('install', inDir(where, 'npm install'), `${path}（没有锁文件）`, false); facts.questions.push(`${path} 有依赖但没有锁文件：CI 里用 npm install 安装，还是先提交锁文件？`); }
    const run = (name: string) => inDir(where, name === 'test' ? `${manager} test` : `${manager} run ${name}`);
    const kinds: [Candidate['kind'], string[]][] = [['build', ['build', 'compile']], ['lint', ['lint', 'typecheck', 'check', 'format:check']],
      ['test', ['test', 'test:unit', 'unit']], ['e2e', ['test:e2e', 'e2e', 'test:integration']]];
    for (const [kind, names] of kinds) for (const name of names) if (typeof scripts[name] === 'string' && scripts[name].trim()) add(kind, run(name), `${path} scripts.${name}`);
  }
  for (const path of manifests.filter(path => ['Makefile', 'makefile', 'GNUmakefile'].includes(base(path)))) {
    const where = dir(path), targets = new Set(makeTargets(files[path]!));
    const kinds: [Candidate['kind'], string[]][] = [['build', ['build']], ['lint', ['lint', 'vet', 'check']], ['test', ['test', 'unit']], ['e2e', ['e2e', 'integration']]];
    for (const [kind, names] of kinds) for (const name of names) if (targets.has(name)) add(kind, where ? `make -C ${where} ${name}` : `make ${name}`, `${path} target ${name}`);
  }
  for (const path of manifests.filter(path => base(path) === 'go.mod')) {
    const where = dir(path);
    add('build', inDir(where, 'go build ./...'), path); add('lint', inDir(where, 'go vet ./...'), path); add('test', inDir(where, 'go test ./...'), path);
  }
  for (const path of manifests.filter(path => base(path) === 'Cargo.toml')) {
    const where = dir(path), locked = has(where ? `${where}/Cargo.lock` : 'Cargo.lock') || has('Cargo.lock') ? ' --locked' : '';
    // Members of a workspace are built from the workspace root.
    if (where && files['Cargo.toml'] && tomlSection(files['Cargo.toml'], 'workspace')) continue;
    add('build', inDir(where, `cargo build${locked}`), path); add('test', inDir(where, `cargo test${locked}`), path);
  }
  const pythonFiles = manifests.filter(path => ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'tox.ini'].includes(base(path)));
  for (const where of [...new Set(pythonFiles.map(dir))]) {
    const at = (name: string) => where ? `${where}/${name}` : name, pyproject = files[at('pyproject.toml')];
    if (has(at('uv.lock'))) add('install', inDir(where, 'pip install uv && uv sync --frozen'), at('uv.lock'), false);
    else if (has(at('poetry.lock'))) add('install', inDir(where, 'pipx install poetry && poetry install'), at('poetry.lock'), false);
    else if (files[at('requirements.txt')] !== undefined) add('install', `pip install -r ${at('requirements.txt')}`, at('requirements.txt'));
    else if (pyproject !== undefined && tomlSection(pyproject, 'project')) add('install', inDir(where, 'pip install -e .'), `${at('pyproject.toml')} [project]`, false);
    if (files[at('requirements-dev.txt')] !== undefined) add('install', `pip install -r ${at('requirements-dev.txt')}`, at('requirements-dev.txt'), false);
    if (files[at('tox.ini')] !== undefined || (pyproject && tomlSection(pyproject, 'tool.tox'))) add('test', inDir(where, 'tox'), files[at('tox.ini')] !== undefined ? at('tox.ini') : `${at('pyproject.toml')} [tool.tox]`, false);
    if (files[at('noxfile.py')] !== undefined) add('test', inDir(where, 'nox'), at('noxfile.py'), false);
    const pytest = files[at('pytest.ini')] !== undefined || (pyproject && (tomlSection(pyproject, 'tool.pytest.ini_options') || /\bpytest\b/.test(pyproject)))
      || /\bpytest\b/.test(files[at('requirements-dev.txt')] || '') || /\bpytest\b/.test(files[at('requirements.txt')] || '');
    if (pytest) add('test', inDir(where, 'python -m pytest'), files[at('pytest.ini')] !== undefined ? at('pytest.ini') : `${at('pyproject.toml')} / requirements`, false);
    if (pyproject && tomlSection(pyproject, 'tool.ruff')) add('lint', inDir(where, 'ruff check .'), `${at('pyproject.toml')} [tool.ruff]`, false);
  }
  // Commands the README tells people to run, from its shell code blocks.
  const readme = Object.keys(files).find(path => /^readme/i.test(path));
  if (readme) for (const block of files[readme]!.matchAll(/```(?:sh|bash|shell|console)?\n([\s\S]*?)```/g))
    for (const line of block[1]!.split('\n').map(text => text.replace(/^\$\s+/, '').trim()).filter(text => text && !text.startsWith('#'))) {
      const kind = kindOf(line); if (kind) add(kind, line, readme, false);
    }
  // Commands the repository already runs in CI are evidence, but they may rely on that workflow's own setup.
  for (const workflow of facts.workflows) for (const command of workflow.runs) {
    if (command.includes('scripts/gate/gate.mjs')) continue;
    const kind = kindOf(command); if (kind) add(kind, command, workflow.path, false);
  }
  const python = facts.languages.some(item => item.name === 'Python') || pythonFiles.length > 0;
  if (pythonFiles.length && !facts.candidates.some(item => item.kind === 'install' && item.certain)) facts.questions.push('Python 依赖在 CI 里怎么安装（例如 pip install -e ".[test]"、uv sync 或 poetry install）？');
  if (python && !facts.candidates.some(item => item.certain && item.kind === 'test')) facts.questions.push('Python 的测试命令是什么？');
  if (manifests.some(path => ['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(base(path)))) facts.questions.push('Java 项目的 JDK 版本和构建、测试命令（mvn -B verify、./gradlew check 等）是什么？');
  if (!facts.candidates.some(item => item.kind !== 'install')) facts.questions.push('仓库里没有找到可以直接使用的构建或测试命令：各 lane 要运行什么？');
  if (facts.merge_queue.state === 'unknown') facts.questions.push('这个仓库的默认分支是否启用了 merge queue？');
  if (facts.release_workflow && !facts.release_workflow.usable) facts.questions.push(`已有的 ${releasePath} 不能用于发版本（${facts.release_workflow.reason}）：要不要给它加上 v* 版本标签触发，或改名后由门禁新建一个？`);
}

/**
 * The plan a conversation starts from. A repository that already has gates starts from its own configuration (its build
 * lane folded into pr-ready), so leaving it unchanged changes nothing; otherwise only certain candidates are used, and the
 * commands the repository's CI already runs are preferred over everything else it might run.
 */
export function baselinePlan(facts: GateFacts): GatePlan {
  const plan = emptyPlan(), config = facts.gate_config && typeof facts.gate_config === 'object' ? facts.gate_config as any : null;
  const list = (raw: unknown) => (typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : []).filter((item: unknown): item is string => typeof item === 'string' && !!item.trim());
  if (config) {
    const lanes = config.lanes && typeof config.lanes === 'object' ? config.lanes : {}, build = list(lanes.build?.commands);
    for (const lane of gateLanes) plan.lanes[lane] = list(lanes[lane]?.commands);
    plan.lanes['pr-ready'] = [...build, ...plan.lanes['pr-ready'].filter(command => !build.includes(command))];
    plan.observe = gateLanes.filter(lane => lanes[lane]?.enforcement === 'observe');
    const gate = facts.workflows.find(item => item.path === facts.existing.gate_workflow)?.gate_job;
    if (gate) { plan.toolchains = { ...plan.toolchains, ...gate.toolchains }; plan.install = gate.install; }
    plan.workflow = facts.existing.gate_workflow ?? '';
    return plan;
  }
  const certain = facts.candidates.filter(item => item.certain), used = certain.filter(item => item.source.includes('.github/workflows/'));
  const pick = (kind: Candidate['kind']) => ((used.some(item => item.kind === kind) ? used : certain).filter(item => item.kind === kind)).map(item => item.command);
  // Versions the repository's own CI sets up come first, then version files, then defaults for the languages it has.
  const seen: Partial<Toolchains> = Object.assign({}, ...facts.workflows.map(item => item.toolchains));
  const nvm = /^v?(\d+)/.exec((facts.files['.nvmrc'] ?? facts.files['.node-version'] ?? '').trim());
  const node = seen.node ?? (nvm && Number(nvm[1]) >= 20 ? nvm[1] : undefined);
  if (node && /^\d+/.test(node) && Number(/^\d+/.exec(node)![0]) >= 20) plan.toolchains.node = node;
  const python = facts.languages.some(item => item.name === 'Python') || Object.keys(facts.files).some(path => ['pyproject.toml', 'setup.py', 'requirements.txt'].includes(base(path)));
  if (python) plan.toolchains.python = seen.python ?? /^\d+\.\d+/.exec((facts.files['.python-version'] ?? '').trim())?.[0] ?? '3.12';
  const gomod = Object.keys(facts.files).find(path => base(path) === 'go.mod');
  if (gomod) plan.toolchains.go = seen.go ?? gomod;
  if (seen.java) plan.toolchains.java = seen.java;
  plan.install = pick('install');
  plan.lanes['pr-ready'] = [...new Set([...pick('build'), ...pick('lint'), ...pick('test')])];
  plan.lanes.daily = pick('e2e');
  return plan;
}
