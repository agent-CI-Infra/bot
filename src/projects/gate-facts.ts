import { parseDocument } from 'yaml';
import { emptyPlan, type GatePlan, type Lane, type MergeQueue } from './gate-plan.js';

/**
 * Repository facts for gate onboarding, read with a read-only installation token before anything is proposed.
 * The agent and the person see the same facts; commands found here are candidates with their source, never run.
 */
export interface Candidate { kind: 'install' | 'build' | 'lint' | 'test' | 'e2e'; command: string; source: string; certain: boolean }
export interface GateFacts {
  repository: string; default_branch: string; head_sha: string; private: boolean;
  languages: { name: string; bytes: number }[];
  /** Root entries; directories end with `/`. */
  root: string[];
  workflows: { path: string; name: string; events: string[]; runs: string[]; error?: string }[];
  /** Manifest and version files read from the root, keyed by path; long files are clipped (tools read the rest). */
  files: Record<string, string>;
  lockfiles: string[];
  existing: { ci_yml: boolean; ci_gates_yml: boolean; ci_gates_json: boolean; release_yml: boolean; gate_script: boolean };
  gate_config: unknown;
  merge_queue: { state: MergeQueue; evidence: string };
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

const manifests = ['package.json', '.nvmrc', '.node-version', 'pyproject.toml', 'setup.cfg', 'setup.py', 'tox.ini', 'noxfile.py', 'pytest.ini',
  'requirements.txt', 'requirements-dev.txt', 'Pipfile', '.python-version', 'Makefile', 'makefile', 'GNUmakefile', 'go.mod', 'Cargo.toml',
  'justfile', 'Justfile', 'Taskfile.yml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'CMakeLists.txt', 'Gemfile', 'composer.json',
  'deno.json', '.tool-versions'];
const lockNames = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'poetry.lock', 'uv.lock', 'Pipfile.lock',
  'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock'];
const clipBytes = 32 * 1024;
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');

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
  const tree = await reader.get(`${repo}/git/trees/${sha}`);
  const entries: any[] = Array.isArray(tree?.tree) ? tree.tree : [];
  const root = entries.map(entry => String(entry.path) + (entry.type === 'tree' ? '/' : '')).sort();
  const has = (name: string) => entries.some(entry => entry.path === name && entry.type === 'blob');
  const languages = Object.entries(await reader.get(`${repo}/languages`).catch(() => null) || {})
    .map(([name, bytes]) => ({ name, bytes: Number(bytes) })).sort((a, b) => b.bytes - a.bytes);

  const files: Record<string, string> = {};
  for (const name of manifests) if (has(name)) {
    const text = await content(name);
    if (text !== null) files[name] = text.length > clipBytes ? text.slice(0, clipBytes) + `\n[… ${text.length - clipBytes} characters omitted; read the file for the rest …]` : text;
  }
  const workflows: GateFacts['workflows'] = [];
  const listing = root.includes('.github/') ? await reader.get(`${repo}/contents/.github/workflows?ref=${sha}`) : null;
  const workflowNames = Array.isArray(listing) ? listing.filter(item => item.type === 'file' && /\.ya?ml$/.test(String(item.name))).map(item => String(item.name)) : [];
  for (const name of workflowNames.sort()) {
    const path = `.github/workflows/${name}`, text = await content(path);
    workflows.push(text === null ? { path, name, events: [], runs: [], error: 'unreadable' } : describeWorkflow(path, text));
  }
  const gateText = await content('.github/ci-gates.json');
  let gateConfig: unknown = null;
  if (gateText !== null) { try { gateConfig = JSON.parse(gateText); } catch { gateConfig = gateText; } }
  const existing = { ci_yml: workflowNames.includes('ci.yml'), ci_gates_yml: workflowNames.includes('ci-gates.yml'), ci_gates_json: gateText !== null,
    release_yml: workflowNames.includes('release.yml'), gate_script: await content('scripts/gate/gate.mjs') !== null };
  const pulls = await reader.get(`${repo}/pulls?state=open&per_page=100`).catch(() => null);
  const openGatePrs = (Array.isArray(pulls) ? pulls : []).filter(pull => String(pull?.head?.ref || '').startsWith('bot/gate-onboarding-'))
    .map(pull => ({ number: Number(pull.number), url: String(pull.html_url), branch: String(pull.head.ref) }));
  const facts: GateFacts = { repository: full, default_branch: defaultBranch, head_sha: sha, private: !!meta.private, languages, root, workflows, files,
    lockfiles: lockNames.filter(has), existing, gate_config: gateConfig, merge_queue: await mergeQueue(reader, full, defaultBranch), open_gate_prs: openGatePrs,
    candidates: [], questions: [] };
  detect(facts, has);
  return facts;
}

/** Name, events and run commands of an existing workflow; a file that does not parse is reported, not guessed at. */
function describeWorkflow(path: string, text: string): GateFacts['workflows'][number] {
  const doc = parseDocument(text, { uniqueKeys: false });
  if (doc.errors.length) return { path, name: path, events: [], runs: [], error: 'yaml_invalid' };
  let data: any;
  try { data = doc.toJS({ maxAliasCount: 50 }); } catch { return { path, name: path, events: [], runs: [], error: 'yaml_invalid' }; }
  const on = data?.on ?? data?.true; // YAML 1.1 readers turn `on` into true; keep both.
  const events = typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : on && typeof on === 'object' ? Object.keys(on) : [];
  const runs: string[] = [];
  for (const job of Object.values(data?.jobs || {}) as any[]) for (const step of Array.isArray(job?.steps) ? job.steps : []) if (typeof step?.run === 'string') runs.push(step.run.trim());
  return { path, name: typeof data?.name === 'string' ? data.name : path, events, runs };
}

/**
 * Whether the default branch requires a merge queue. A ruleset's merge_queue rule says so directly; an unprotected branch
 * without one has none. Classic branch protection does not show it over REST, so GraphQL's mergeQueue settles that case.
 * Anything the token cannot read stays unknown and the person is asked.
 */
export async function mergeQueue(reader: FactReader, full: string, branch: string): Promise<GateFacts['merge_queue']> {
  const repo = `/repos/${encode(full)}`;
  let rules: any[] | null = null;
  try { const value = await reader.get(`${repo}/rules/branches/${encode(branch)}`); rules = Array.isArray(value) ? value : null; } catch { rules = null; }
  const queued = rules?.find(rule => rule?.type === 'merge_queue');
  if (queued) return { state: 'enabled', evidence: `默认分支 ${branch} 的规则集${queued.ruleset_id ? ` ${queued.ruleset_id} ` : ''}要求 merge queue` };
  let protectedBranch: boolean | null = null;
  try { const value = await reader.get(`${repo}/branches/${encode(branch)}`); protectedBranch = typeof value?.protected === 'boolean' ? value.protected : null; } catch { protectedBranch = null; }
  if (rules && protectedBranch === false) return { state: 'disabled', evidence: `默认分支 ${branch} 的规则集没有 merge queue，也没有经典分支保护` };
  try {
    const [owner, name] = full.split('/');
    const value = await reader.graphql('query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id}}}', { owner, name, branch });
    if (!value?.errors && value?.data?.repository) return value.data.repository.mergeQueue
      ? { state: 'enabled', evidence: `GitHub 报告默认分支 ${branch} 已启用 merge queue` }
      : { state: 'disabled', evidence: `GitHub 报告默认分支 ${branch} 没有启用 merge queue` };
  } catch { /* Falls through to unknown. */ }
  return { state: 'unknown', evidence: rules ? `默认分支 ${branch} 有分支保护，但安装令牌读不到它是否要求 merge queue` : '安装令牌读不到默认分支的规则集' };
}

const tomlSection = (text: string, name: string) => new RegExp(`^\\[${name.replace(/\./g, '\\.')}\\]`, 'm').test(text);
const makeTargets = (text: string) => [...text.matchAll(/^([A-Za-z0-9][\w./-]*)\s*:(?!=)/gm)].map(match => match[1]!);

/** Candidate commands with their sources, a starting plan built from the certain ones, and what to ask about the rest. */
function detect(facts: GateFacts, has: (name: string) => boolean): void {
  // A command found in several places is one candidate with every source; any certain source makes it certain.
  const { files } = facts, add = (kind: Candidate['kind'], command: string, source: string, certain = true) => {
    const found = facts.candidates.find(item => item.kind === kind && item.command === command);
    if (!found) facts.candidates.push({ kind, command, source, certain });
    else { if (!found.source.split('；').includes(source)) found.source += '；' + source; found.certain ||= certain; }
  };
  if (files['package.json'] !== undefined) {
    let pkg: any = null; try { pkg = JSON.parse(files['package.json']); } catch { facts.questions.push('package.json 无法解析，Node 的构建和测试命令需要你确认。'); }
    if (pkg) {
      const manager = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm', scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
      const dependencies = ['dependencies', 'devDependencies', 'optionalDependencies'].some(key => pkg[key] && Object.keys(pkg[key]).length);
      if (has('package-lock.json') || has('npm-shrinkwrap.json')) add('install', 'npm ci', 'package-lock.json');
      else if (manager === 'pnpm') add('install', 'corepack enable && pnpm install --frozen-lockfile', 'pnpm-lock.yaml', false);
      else if (manager === 'yarn') add('install', 'corepack enable && yarn install --immutable', 'yarn.lock', false);
      else if (dependencies) { add('install', 'npm install', 'package.json（没有锁文件）', false); facts.questions.push('package.json 有依赖但没有锁文件：CI 里用 npm install 安装，还是先提交锁文件？'); }
      const run = (name: string) => name === 'test' ? `${manager} test` : `${manager} run ${name}`;
      const kinds: [Candidate['kind'], string[]][] = [['build', ['build', 'compile']], ['lint', ['lint', 'typecheck', 'check', 'format:check']],
        ['test', ['test', 'test:unit', 'unit']], ['e2e', ['test:e2e', 'e2e', 'test:integration']]];
      for (const [kind, names] of kinds) for (const name of names) if (typeof scripts[name] === 'string' && scripts[name].trim()) add(kind, run(name), `package.json scripts.${name}`);
    }
  }
  const makefile = files.Makefile ?? files.makefile ?? files.GNUmakefile;
  if (makefile !== undefined) {
    const targets = new Set(makeTargets(makefile)), source = files.Makefile !== undefined ? 'Makefile' : files.makefile !== undefined ? 'makefile' : 'GNUmakefile';
    const kinds: [Candidate['kind'], string[]][] = [['build', ['build']], ['lint', ['lint', 'vet', 'check']], ['test', ['test', 'unit']], ['e2e', ['e2e', 'integration']]];
    for (const [kind, names] of kinds) for (const name of names) if (targets.has(name)) add(kind, `make ${name}`, `${source} target ${name}`);
  }
  if (files['go.mod'] !== undefined) {
    add('build', 'go build ./...', 'go.mod'); add('lint', 'go vet ./...', 'go.mod'); add('test', 'go test ./...', 'go.mod');
  }
  if (files['Cargo.toml'] !== undefined) {
    const locked = has('Cargo.lock') ? ' --locked' : '';
    add('build', `cargo build${locked}`, 'Cargo.toml'); add('test', `cargo test${locked}`, 'Cargo.toml');
  }
  const pyproject = files['pyproject.toml'], python = pyproject !== undefined || ['setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'tox.ini'].some(name => files[name] !== undefined);
  if (python) {
    if (has('uv.lock')) add('install', 'pip install uv && uv sync --frozen', 'uv.lock', false);
    else if (has('poetry.lock')) add('install', 'pipx install poetry && poetry install', 'poetry.lock', false);
    else if (files['requirements.txt'] !== undefined) add('install', 'pip install -r requirements.txt', 'requirements.txt');
    else if (pyproject !== undefined && tomlSection(pyproject, 'project')) add('install', 'pip install -e .', 'pyproject.toml [project]', false);
    if (files['requirements-dev.txt'] !== undefined) add('install', 'pip install -r requirements-dev.txt', 'requirements-dev.txt', false);
    if (files['tox.ini'] !== undefined || (pyproject && tomlSection(pyproject, 'tool.tox'))) add('test', 'tox', files['tox.ini'] !== undefined ? 'tox.ini' : 'pyproject.toml [tool.tox]', false);
    if (files['noxfile.py'] !== undefined) add('test', 'nox', 'noxfile.py', false);
    const pytest = files['pytest.ini'] !== undefined || (pyproject && (tomlSection(pyproject, 'tool.pytest.ini_options') || /\bpytest\b/.test(pyproject)))
      || /\bpytest\b/.test(files['requirements-dev.txt'] || '') || /\bpytest\b/.test(files['requirements.txt'] || '');
    if (pytest) add('test', 'python -m pytest', files['pytest.ini'] !== undefined ? 'pytest.ini' : 'pyproject.toml / requirements', false);
    if (pyproject && tomlSection(pyproject, 'tool.ruff')) add('lint', 'ruff check .', 'pyproject.toml [tool.ruff]', false);
    if (!facts.candidates.some(item => item.kind === 'install' && item.certain)) facts.questions.push('Python 依赖在 CI 里怎么安装（例如 pip install -e ".[test]"、uv sync 或 poetry install）？');
    if (!facts.candidates.some(item => item.kind === 'test' && item.source !== 'go.mod')) facts.questions.push('Python 的测试命令是什么？');
  }
  if (['pom.xml', 'build.gradle', 'build.gradle.kts'].some(name => files[name] !== undefined)) facts.questions.push('Java 项目的 JDK 版本和构建、测试命令（mvn -B verify、./gradlew check 等）是什么？');
  for (const workflow of facts.workflows) for (const command of workflow.runs) {
    // Commands the repository already runs in CI are evidence, but they may rely on that workflow's own setup.
    const kind: Candidate['kind'] | null = /\b(?:e2e|playwright|cypress)\b/i.test(command) ? 'e2e' : /\b(?:test|pytest|tox|nox)\b/i.test(command) ? 'test'
      : /\b(?:lint|ruff|eslint|flake8|clippy|vet|typecheck|mypy)\b/i.test(command) ? 'lint' : /\b(?:build|compile)\b/i.test(command) ? 'build' : null;
    if (kind) add(kind, command, workflow.path, false);
  }
  if (!facts.candidates.some(item => item.kind !== 'install')) facts.questions.push('仓库里没有找到可以直接使用的构建或测试命令：各 lane 要运行什么？');
  if (facts.merge_queue.state === 'unknown') facts.questions.push('这个仓库的默认分支是否启用了 merge queue？');
}

/** A plan made only from the certain candidates; uncertain lanes stay empty until someone answers. */
export function baselinePlan(facts: GateFacts): GatePlan {
  const plan = emptyPlan(), certain = (kind: Candidate['kind']) => facts.candidates.filter(item => item.kind === kind && item.certain).map(item => item.command);
  const nvm = /^v?(\d+)/.exec((facts.files['.nvmrc'] ?? facts.files['.node-version'] ?? '').trim());
  if (nvm && Number(nvm[1]) >= 20) plan.toolchains.node = nvm[1]!;
  if (['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'tox.ini'].some(name => facts.files[name] !== undefined))
    plan.toolchains.python = /^\d+\.\d+/.exec((facts.files['.python-version'] ?? '').trim())?.[0] ?? '3.12';
  if (facts.files['go.mod'] !== undefined) plan.toolchains.go = 'go.mod';
  plan.install = certain('install');
  const lanes: Partial<Record<Lane, string[]>> = { build: certain('build').slice(0, 1), 'pr-ready': [...certain('lint'), ...certain('test')], daily: certain('e2e') };
  for (const [lane, commands] of Object.entries(lanes)) plan.lanes[lane as Lane] = commands!;
  return plan;
}
