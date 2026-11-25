import { executeRunnerRequest } from './executor.mjs';
import { runnerRequestLimit } from './command-policy.mjs';

async function readStdin(maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('runner_request_too_large'), {
        code: 'runner_request_too_large',
        limit: maxBytes,
        length: total,
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const arg = process.argv[2] || '';
let request;
if (arg === '--stdin') {
  try {
    request = JSON.parse(await readStdin(runnerRequestLimit));
  } catch (error) {
    if (error?.code === 'runner_request_too_large') {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: 'runner_request_too_large',
        limit: error.limit,
        length: error.length,
        detail: `The runner request is ${error.length} bytes once JSON-encoded; the transport limit is ${error.limit} bytes. Write the command to a script file and run the file, or split the work into smaller requests.`,
      }));
      process.exit(0);
    }
    throw error;
  }
} else {
  request = JSON.parse(Buffer.from(arg, 'base64url').toString());
}

// An SSH grant is served only by the resident daemon's agent socket (runner/ssh-agent.mjs); a one-shot runner drops it.
if (request && typeof request === 'object') delete request.ssh;
const result = await executeRunnerRequest(request, { daemon: false });
process.stdout.write(JSON.stringify(result));
