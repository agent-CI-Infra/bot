// Titles and commit messages have their own contract, separate from review/comment templates.
export function shortTitle(value: string, limit = 160): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  let end = text.slice(0, limit - 1);
  if (/[\p{L}\p{N}]/u.test((text[limit - 1] || '')) && /[\p{L}\p{N}]/u.test((text[limit - 2] || '')) && /[a-zA-Z0-9]/.test((text[limit - 2] || ''))) {
    const boundary = end.search(/\s+\S*$/); end = boundary > 0 ? end.slice(0, boundary) : '';
  }
  return (end.trimEnd() || 'Implementation update'.slice(0, limit - 1)) + '…';
}
export function implementationText(candidate: any, issue: number) {
  const title = shortTitle(candidate.change_title || `Implement #${issue}: ${candidate.implementation_goal || 'Update implementation'}`);
  const body = `${candidate.summary}\n\nCloses #${issue}\n\nTests: ${candidate.validation.command}\nExit code: ${candidate.validation.exit_code}\nCommit: ${candidate.remote_sha}`;
  return { title, body };
}
// Presentation-only routing reasons are retained in task results, never published as findings.
const normalize = (text: string) => text.replace(/[`*_#]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
export function reviewText(summary: string, findings: any[], inline: Set<string>) {
  const unique = findings.filter((finding, index) => findings.findIndex(f => normalize(f.body) === normalize(finding.body)) === index);
  // A verbatim finding embedded in a summary belongs at its selected location, once.
  let overview = summary;
  for (const finding of unique) if (inline.has(finding.id)) overview = overview.replaceAll(finding.body, '').trim();
  const discussion = unique.filter(f => !inline.has(f.id) && !normalize(overview).includes(normalize(f.body))).map(f => f.body);
  return { overview, findings: unique, discussion };
}
