import { sanitizeAgentPollTrajectory } from '../runner/image-budget.mjs';

const RUN_TOKEN_PATTERN = /\brrt_[A-Za-z0-9_-]{12}\.[A-Za-z0-9_-]{43}\b/g;
function sanitizeTrajectoryValue(value) {
  if (typeof value === 'string') return value.includes('rrt_') ? value.replace(RUN_TOKEN_PATTERN, '[redacted:run_token]') : value;
  if (Array.isArray(value)) return value.map(sanitizeTrajectoryValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if ((key === 'run_token' || key === 'token') && typeof entry === 'string' && entry.length > 0) out[key] = '[redacted]';
    else out[key] = sanitizeTrajectoryValue(entry);
  }
  return out;
}
export function sanitizeTrajectoryInput(input) {
  if (input?.request && ['workspace_harness_config', 'workspace_agent_token', 'workspace_agent_config', 'workspace_agent_gateway', 'workspace_agent_tool'].includes(input.request.type) && typeof input.request.base64 === 'string') {
    return sanitizeTrajectoryValue({ ...input, request: { ...input.request, base64: '[redacted]' } });
  }
  return sanitizeTrajectoryValue(input);
}
export function sanitizeTrajectoryResult(type, result) {
  if (type === 'workspace_agent_poll' || type === 'workspace_harness_poll') return sanitizeAgentPollTrajectory(sanitizeTrajectoryValue(result));
  return result;
}
