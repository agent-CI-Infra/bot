// A scheduled release runs without a person in the room, so the decisions a person makes on the manual path are fixed
// here: when the next run is due, which branch names are accepted, and what counts as a feature worth a minor version.
// The schedule row also stores the administrator who configured it; the worker guard keeps checking that actor's
// current project permission, so a revoked administrator turns the schedule into a visible permission wait.
export const scheduleTimePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
// The same shape Git accepts for a branch: no spaces, no revision syntax, nothing that a shell or a URL would split.
export const scheduleBranchPattern = /^[A-Za-z0-9._/-]+$/;

// The next UTC occurrence of a daily time. A run that is already past today moves to tomorrow instead of firing twice.
export function nextRunAt(time: string, now = Date.now()): number {
  if (!scheduleTimePattern.test(time)) return now + 86_400_000;
  const [hour, minute] = time.split(':').map(Number);
  const date = new Date(now);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour!, minute!, 0, 0);
  return today > now ? today : today + 86_400_000;
}

// Only a feature or a breaking change moves the minor version; a fix, a test or a documentation change takes the patch.
// Conventional commit prefixes and PR titles are the change set the release already collected, so no model decides this.
export function majorFeature(sources: { title?: unknown }[]): boolean {
  return sources.some(source => /^(feat|feature)(\(|!|:)|^BREAKING[ -]CHANGE\b/i.test(String(source.title ?? '').trim()));
}
