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
export function testEvidence(candidate: any) {
  const validation=candidate.validation;
  return `Tests: ${candidate.test_command||validation.command}\n`+(validation.source==='agent'
    ? 'Reported by the agent; not rerun by the control plane.'
    : `${validation.source==='policy'?'Policy tests: '+validation.command+'\n':''}Exit code: ${validation.exit_code}`);
}
export function implementationText(candidate: any, issue: number) {
  const title = shortTitle(candidate.change_title || `Implement #${issue}: ${candidate.implementation_goal || 'Update implementation'}`);
  const body = `${candidate.summary}\n\nCloses #${issue}\n\n${testEvidence(candidate)}\nCommit: ${candidate.remote_sha}`;
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

// The summary comment's own words follow the repository's review language; for auto, the language the summary is in.
export function reviewLanguage(setting: unknown, summary: string): 'zh' | 'en' {
  return setting === 'zh' || setting === 'en' ? setting : /[㐀-鿿]/.test(summary) ? 'zh' : 'en';
}
const words = {
  zh: { review: (n: number, at: string, sha: string) => `第 ${n} 次检视，更新于 ${at}，检视提交 ${sha}`, reply: (actor: string, url: string) => `；回应 @${actor} 的${url ? `[评论](${url})` : '评论'}`,
    alert: (n: number, items: string) => `需要人工处理 ${n} 项：${items}。汇总见文末。`, heading: (n: number) => `需要人工处理（${n} 项）`, inline: '行内意见', mark: '需要人工处理',
    resolved: (n: number, items: string) => `已关闭 ${n} 条后续提交已修复的行内意见：${items}。`, open: (n: number, items: string) => `之前的行内意见仍未解决 ${n} 条：${items}。`, join: '；', list: '、',
    behavior: (files: string[]) => `这些文件改变了 bot 的行为，需要维护者决定是否接受：${files.join('、')}`, clarification: '需求有待人确认，确认前不会自动开发' },
  en: { review: (n: number, at: string, sha: string) => `Review ${n}, updated ${at}, reviewed commit ${sha}`, reply: (actor: string, url: string) => `; responding to @${actor}'s ${url ? `[comment](${url})` : 'comment'}`,
    alert: (n: number, items: string) => `Needs a person (${n}): ${items}. Summary at the end.`, heading: (n: number) => `Needs a person (${n})`, inline: 'inline comment', mark: 'Needs a person',
    resolved: (n: number, items: string) => `Resolved ${n} inline comment(s) fixed by later commits: ${items}.`, open: (n: number, items: string) => `Still open from earlier reviews (${n}): ${items}.`, join: '; ', list: ', ',
    behavior: (files: string[]) => `These files change the bot's behavior; a maintainer decides whether to accept them: ${files.join(', ')}`, clarification: 'The requirement needs a person to confirm it; nothing is developed automatically until then' },
};
// One line of a finding for the lists: the model's human_action, else the first line of the finding without markdown.
const line = (text: string, limit: number) => { const value = text.replace(/[`*_#>]/g, '').split('\n').map(part => part.trim()).find(Boolean) || ''; return value.length > limit ? value.slice(0, limit - 1) + '…' : value; };
export interface HumanItem { text: string, url?: string | null }
// An inline comment on GitHub, as the summary comment links to it.
export interface Place { path: string, line: number | null, html_url: string }
// What a person has to decide or do: the findings the model marked, the bot behavior files a PR changes, and a requirement
// that needs confirming when no finding says so already.
export function humanItems(language: 'zh' | 'en', result: any, inlineUrls: Map<string, string>): HumanItem[] {
  const items: HumanItem[] = result.findings.filter((f: any) => f.requires_human_decision === true)
    .map((f: any) => ({ text: line(String(f.human_action || '').trim() || f.body, 300), url: inlineUrls.get(f.id) || null }));
  if (result.behavior_changes?.length) items.push({ text: words[language].behavior(result.behavior_changes) });
  if (result.clarification_required && !items.length) items.push({ text: words[language].clarification });
  return items;
}
// A finding a person must handle says so where it stands, inline or in the summary comment.
// A body the model copied from an earlier comment may carry the mark already.
export const markHuman = (language: 'zh' | 'en', finding: any) => finding.requires_human_decision !== true
  || Object.values(words).some(w => String(finding.body).startsWith(`**[${w.mark}]**`)) ? finding.body : `**[${words[language].mark}]** ${finding.body}`;
// The summary comment. What needs a person is named first, the review follows, and the same items close it as a list, so
// they are seen on opening the comment and found again at its end. A comment that later reviews edit says which review
// it shows and, when a person's comment asked for it, whom it answers.
export function summaryComment(o: { language: 'zh' | 'en', review?: { count: number, at: string, sha: string, actor?: string | null, url?: string | null },
  overview: string, discussion: string[], coverage: string, human: HumanItem[], resolved: Place[], open?: Place[] }): string {
  const w = words[o.language], parts: string[] = [];
  if (o.review && o.review.count > 1) parts.push(`*${w.review(o.review.count, o.review.at, o.review.sha.slice(0, 7))}${o.review.actor ? w.reply(o.review.actor, o.review.url || '') : ''}*`);
  // Items run together in one sentence there, so each loses its own closing punctuation.
  const brief = (text: string) => line(text, 120).replace(/[。．.；;，,、:：\s]+$/u, '');
  if (o.human.length) parts.push(`> [!IMPORTANT]\n> ${w.alert(o.human.length, o.human.map(item => brief(item.text)).join(w.join))}`);
  parts.push(o.overview, o.discussion.join('\n\n---\n\n'));
  const places = (list: Place[]) => list.map(r => `[${r.path}${r.line ? ':' + r.line : ''}](${r.html_url})`).join(w.list);
  if (o.open?.length) parts.push(w.open(o.open.length, places(o.open)));
  if (o.resolved.length) parts.push(w.resolved(o.resolved.length, places(o.resolved)));
  parts.push(o.coverage);
  const link = (url: string) => o.language === 'zh' ? `（[${w.inline}](${url})）` : ` ([${w.inline}](${url}))`;
  if (o.human.length) parts.push(`### ${w.heading(o.human.length)}\n\n` + o.human.map((item, index) => `${index + 1}. ${item.text}${item.url ? link(item.url) : ''}`).join('\n'));
  return parts.filter(Boolean).join('\n\n');
}
