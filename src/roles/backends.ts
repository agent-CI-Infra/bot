import { harnesses } from './harness.js';

/** Backend names are independent of roles. A planned driver is visible, but never executable by name alone. */
const planned = [
  { id: 'claude_code', name: 'Claude Code', issue: 170 },
  { id: 'codex', name: 'Codex', issue: 171 },
  { id: 'opencode', name: 'OpenCode', issue: 172 }
];
export const recommendedBackend = 'pi';
const names: Record<string, string> = { pi: 'Pi', native: 'Native', process: 'Process', acp: 'ACP' };
export function agentBackends() {
  return [
    ...[...harnesses].sort((a, b) => Number(b.id === recommendedBackend) - Number(a.id === recommendedBackend)).map(h => ({ id: h.id, name: names[h.id] ?? planned.find(p => p.id === h.id)?.name ?? h.id,
      available: true, recommended: h.id === recommendedBackend, version: h.version, kinds: h.kinds,
      model_source: h.externalModel ? 'external_harness' : 'project', integration_issue: planned.find(p => p.id === h.id)?.issue ?? null })),
    ...planned.filter(p => !harnesses.some(h => h.id === p.id)).map(p => ({ id: p.id, name: p.name,
      available: false, recommended: false, version: null, kinds: [], model_source: null, integration_issue: p.issue }))
  ];
}
export const plannedBackend = (id: string) => planned.some(p => p.id === id);
