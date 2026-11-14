import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';

/**
 * Per-request mailbox tool dispatcher shared by Pi (`runner/pi-entry.mjs`) and the stdio MCP bridge
 * (`runner/mcp-bridge.mjs`). Each call owns `tool-requests/<id>.json` and waits for `tool-replies/<id>.json`,
 * allowing parallel tool calls to complete independently and in any order.
 */
export function createToolDispatch(dir, options = {}) {
  const requestsDir = dir + '/tool-requests', repliesDir = dir + '/tool-replies';
  const defaultToken = options.token ?? null;
  const pollMs = options.pollMs ?? 50;
  let dirsReady;
  const ensureDirs = () => (dirsReady ??= Promise.all([
    mkdir(requestsDir, { recursive: true, mode: 0o700 }),
    mkdir(repliesDir, { recursive: true, mode: 0o700 })
  ]));

  return async function dispatchTool(name, args, callOptions = {}) {
    const signal = callOptions.signal;
    const cancelledError = callOptions.cancelledError ?? 'tool_cancelled';
    const timeoutError = callOptions.timeoutError ?? 'tool_timeout';
    const timeoutMs = callOptions.timeoutMs !== undefined ? callOptions.timeoutMs : (options.timeoutMs ?? null);
    const kind = callOptions.kind ?? options.kind;
    const token = callOptions.token !== undefined ? callOptions.token : defaultToken;
    if (signal?.aborted) return { error: cancelledError };

    await ensureDirs();
    if (signal?.aborted) return { error: cancelledError };

    const id = randomBytes(24).toString('hex');
    const reqBase = `${requestsDir}/${id}`, replyBase = `${repliesDir}/${id}`;
    const payload = {
      id,
      name,
      arguments: args ?? {},
      ...(kind ? { kind } : {}),
      ...(token ? { token } : {})
    };
    try {
      await writeFile(reqBase + '.tmp', JSON.stringify(payload), { mode: 0o600 });
      await rename(reqBase + '.tmp', reqBase + '.json');
      const end = timeoutMs !== null ? Date.now() + timeoutMs : Infinity;
      for (;;) {
        if (signal?.aborted) return { error: cancelledError };
        const value = await readFile(replyBase + '.json', 'utf8').then(JSON.parse).catch(() => null);
        if (value !== null) return value;
        if (Date.now() >= end) return { error: timeoutError };
        try {
          await delay(pollMs, undefined, signal ? { signal } : undefined);
        } catch (error) {
          if (signal?.aborted) return { error: cancelledError };
          throw error;
        }
      }
    } finally {
      await unlink(reqBase + '.json').catch(() => {});
      await unlink(reqBase + '.tmp').catch(() => {});
      await unlink(replyBase + '.json').catch(() => {});
      await unlink(replyBase + '.tmp').catch(() => {});
    }
  };
}
