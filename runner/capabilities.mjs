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
  if (['github_read_token','github_read','github_search','read_job_log'].includes(name) && (!github.permissions || !Object.keys(github.permissions).length || Object.values(github.permissions).some(value => value !== 'read'))) return 'github_read_token_not_allowed';
  return null;
}
