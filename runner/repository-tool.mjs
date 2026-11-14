import { createToolDispatch } from './tool-dispatch.mjs';

// Repository exploration and platform write calls share the per-request tool mailbox and run in parallel.
export function createRepositoryTool(dir, options = {}) {
  const dispatch = createToolDispatch(dir, { kind: 'repository', timeoutMs: 120000, ...options });
  return function repositoryTool(name, args, signal) {
    return dispatch(name, args, {
      signal,
      cancelledError: 'repository_tool_cancelled',
      timeoutError: 'repository_tool_timeout'
    });
  };
}
