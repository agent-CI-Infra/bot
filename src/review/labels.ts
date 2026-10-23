// Classification labels a review may add. The model only names them; the control plane adds a name only when the
// repository already has that label, it is not reserved for people or for the bot's own signals, and the object has no
// value yet on the same axis (`type/…`, `priority/…`), so a person's earlier choice is never overridden.
const names = (labels: unknown): string[] => (Array.isArray(labels) ? labels : [])
  .map(label => typeof label === 'string' ? label : (label as any)?.name).filter((name): name is string => typeof name === 'string' && !!name);
const axis = (name: string) => name.includes('/') ? name.slice(0, name.indexOf('/')).toLowerCase() : null;
// Opt-in, veto, hold and gate labels are human or automation decisions.
const reserved = (name: string) => /^(agent|pr|gate)\//i.test(name) || /^(blocker|priority\/critical)$/i.test(name);

export function repositoryLabels(rows: unknown): { name: string; description: string }[] {
  return (Array.isArray(rows) ? rows : []).filter(row => typeof row?.name === 'string' && row.name)
    .map(row => ({ name: String(row.name), description: String(row.description || '').slice(0, 200) })).slice(0, 200);
}

export function classificationLabels(suggested: unknown, available: unknown, current: unknown, own: string[]): string[] {
  const existing = new Map(names(available).map(name => [name.toLowerCase(), name])), have = names(current).map(name => name.toLowerCase());
  const ownNames = own.filter(Boolean).map(name => name.toLowerCase()), taken = new Set(have.map(axis).filter(Boolean));
  const chosen: string[] = [];
  for (const raw of Array.isArray(suggested) ? suggested : []) {
    const name = existing.get(String(raw).trim().toLowerCase());
    if (!name || reserved(name) || ownNames.includes(name.toLowerCase()) || have.includes(name.toLowerCase()) || chosen.includes(name)) continue;
    const group = axis(name);
    if (group && taken.has(group)) continue;
    if (group === 'priority' && chosen.some(label => axis(label) === 'priority')) continue;
    chosen.push(name);
    if (chosen.length === 8) break;
  }
  return chosen;
}
