// #480: the shell project picker is one session-wide default scope shared by the board, usage/costs and the management
// assistant. Deliberately memory-only: the console never persisted this choice, and a stored default would describe a
// project the reader did not pick in this session. Every surface that overrides it has to say so next to its controls.
let consoleDefaultScope = null;
function consoleDefaultProject() { return consoleDefaultScope; }
function setConsoleDefaultProject(id) {
  const next = id === null || id === undefined || id === '' ? null : String(id);
  if (next === consoleDefaultScope) return;
  consoleDefaultScope = next;
  dispatchEvent(new CustomEvent('console-scope-change'));
}
