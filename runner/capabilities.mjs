// Trusted control-plane capabilities, never inferred from an exposed tool name.
// These checks govern runner tools; they are not an OS sandbox for arbitrary shell commands.
export function toolCapabilityError(config, name, args = {}) {
  const workspace = config.capabilities?.workspace || {};
  const github = config.capabilities?.github || {};
  if (name === 'read_file' && workspace.read !== true) return 'workspace_read_not_allowed';
  if (name === 'run_command' && workspace.shell !== true) return 'shell_not_allowed';
  if (name === 'write_file') {
    const note = typeof args.path === 'string' && args.path.startsWith('../notes/');
    if (note ? workspace.notes !== true : workspace.write !== true) return note ? 'notes_write_not_allowed' : 'review_repository_write_forbidden';
  }
  if (name === 'create_pull_request' && github.publication !== 'pull_request') return 'publication_not_allowed';
  if (name === 'start_agent' && config.capabilities?.agents !== true) return 'agents_not_allowed';
  if (['github_read_token','github_read','github_search','read_job_log'].includes(name) && (!github.permissions || !Object.keys(github.permissions).length || Object.values(github.permissions).some(value => value !== 'read'))) return 'github_read_token_not_allowed';
  return null;
}
// A sub-agent's capabilities: the parent's, narrowed by what the parent asked for. A requested true never adds what the
// parent lacks; the sub-agent never publishes and never starts agents of its own.
export function narrowCapabilities(parent = {}, requested = {}) {
  const ask = requested && typeof requested === 'object' && !Array.isArray(requested) ? requested : {};
  const workspace = parent.workspace || {}, github = parent.github || {};
  const allow = (have, key) => have === true && ask[key] !== false;
  const read = allow(workspace.read, 'workspace_read');
  return { workspace: { read, write: read && allow(workspace.write, 'write_workspace'), notes: allow(workspace.notes, 'write_notes'), shell: read && allow(workspace.shell, 'run_commands') },
    github: { permissions: ask.github_read === false ? {} : { ...(github.permissions || {}) }, publication: 'none' }, agents: false };
}
