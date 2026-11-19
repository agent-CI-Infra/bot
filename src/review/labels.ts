// Classification labels a review may add. The model only names them; the control plane adds a name only when the
// repository already has that label, it is not reserved for people or for the bot's own signals, and the object has no
// value yet on the same axis (`type/…`, `priority/…`), so a person's earlier choice is never overridden.
const names = (labels: unknown): string[] => (Array.isArray(labels) ? labels : [])
  .map(label => typeof label === 'string' ? label : (label as any)?.name).filter((name): name is string => typeof name === 'string' && !!name);
const axis = (name: string) => name.includes('/') ? name.slice(0, name.indexOf('/')).toLowerCase() : null;
export const developedLabel = { name: 'bot-developed', color: '0e8a16', description: 'The bot opened a pull request for this Issue' };
export function developingIssueLabel(name: string) {
  // A project may already use the completion marker as its custom in-progress label.
  if (!name || name.toLowerCase() === developedLabel.name) return null;
  return { name, color: 'fbca04', description: 'The bot is developing this Issue; removed when its pull request is opened or it stops' };
}

// Opt-in, veto, hold and gate labels are human or automation decisions.
export const reservedLabel = (name: string) => /^(agent|pr|gate)\//i.test(name) || /^(blocker|priority\/critical)$/i.test(name);

/**
 * The labels an agent asks to put on its pull request (#845), checked by the rules above before anything is published: each must
 * already exist in the repository and must be neither reserved nor one of the bot's own labels. Returns the repository's spelling
 * of the accepted names (at most 8, like classification) and every refused name with why, so the agent can correct its call.
 */
export function pullRequestLabels(requested: unknown, available: unknown, own: string[]): { labels: string[]; refused: { name: string; reason: 'not_in_repository' | 'reserved' | 'too_many' }[] } {
  const existing = new Map(names(available).map(name => [name.toLowerCase(), name])), ownNames = [developedLabel.name, ...own.filter(Boolean).map(name => name.toLowerCase())];
  const labels: string[] = [], refused: { name: string; reason: 'not_in_repository' | 'reserved' | 'too_many' }[] = [];
  for (const raw of Array.isArray(requested) ? requested : []) {
    const wanted = String(raw).trim(), name = existing.get(wanted.toLowerCase());
    if (!name) refused.push({ name: wanted, reason: 'not_in_repository' });
    else if (reservedLabel(name) || ownNames.includes(name.toLowerCase())) refused.push({ name, reason: 'reserved' });
    else if (!labels.includes(name)) labels.push(name);
  }
  refused.push(...labels.splice(8).map(name => ({ name, reason: 'too_many' as const })));
  return { labels, refused };
}

export function repositoryLabels(rows: unknown): { name: string; description: string }[] {
  return (Array.isArray(rows) ? rows : []).filter(row => typeof row?.name === 'string' && row.name)
    .map(row => ({ name: String(row.name), description: String(row.description || '').slice(0, 200) })).slice(0, 200);
}

export function classificationLabels(suggested: unknown, available: unknown, current: unknown, own: string[]): string[] {
  const existing = new Map(names(available).map(name => [name.toLowerCase(), name])), have = names(current).map(name => name.toLowerCase());
  const ownNames = [developedLabel.name, ...own.filter(Boolean).map(name => name.toLowerCase())], taken = new Set(have.map(axis).filter(Boolean));
  const chosen: string[] = [];
  for (const raw of Array.isArray(suggested) ? suggested : []) {
    const name = existing.get(String(raw).trim().toLowerCase());
    if (!name || reservedLabel(name) || ownNames.includes(name.toLowerCase()) || have.includes(name.toLowerCase()) || chosen.includes(name)) continue;
    const group = axis(name);
    if (group && taken.has(group)) continue;
    if (group === 'priority' && chosen.some(label => axis(label) === 'priority')) continue;
    chosen.push(name);
    if (chosen.length === 8) break;
  }
  return chosen;
}
