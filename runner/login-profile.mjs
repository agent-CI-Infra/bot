// Login shells (`bash -lc` / `sh -lc`, used by Claude Code's shell snapshot and Codex's shell tool) source `/etc/profile`
// before the CLI HOME's `.profile`, and on Debian `/etc/profile` replaces PATH with the system default. The harness passes
// the PATH it built for the CLI in BOT_LOGIN_PATH: the wrapper directory, the Node directory, in local mode the runner's
// Node, then the computer user's tool directories and the system directories, in that order. The profile puts that PATH
// back and appends whatever the system profile added that it does not already contain, so login shells see the same
// commands as the CLI itself. POSIX sh only: dash reads it for `sh -lc`, bash through `.bash_profile`.
export const loginProfile = [
  '# Managed by Bot container harness (#705, #1024)',
  'if [ -n "${BOT_LOGIN_PATH:-}" ]; then',
  '  _bot_path=$BOT_LOGIN_PATH',
  '  _bot_rest=${PATH:-}',
  '  while [ -n "$_bot_rest" ]; do',
  '    _bot_dir=${_bot_rest%%:*}',
  '    case "$_bot_rest" in *:*) _bot_rest=${_bot_rest#*:} ;; *) _bot_rest= ;; esac',
  '    [ -n "$_bot_dir" ] || continue',
  '    case ":$_bot_path:" in *":$_bot_dir:"*) ;; *) _bot_path=$_bot_path:$_bot_dir ;; esac',
  '  done',
  '  PATH=$_bot_path',
  '  unset _bot_path _bot_rest _bot_dir',
  'fi',
  'export PATH',
  '',
].join('\n');

// A login bash reads the first of `.bash_profile`, `.bash_login` and `.profile`; the managed `.bash_profile` makes sure it
// ends up in the profile above.
export const bashProfile = 'if [ -f "$HOME/.profile" ]; then\n  . "$HOME/.profile"\nfi\n';
