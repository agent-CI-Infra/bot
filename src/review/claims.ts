import type { GitHub } from '../github/client.js';
import type { Store } from '../storage/database.js';
import { TaskError } from '../agent/common.js';
import { assigneesOf } from './queue.js';

/** An open pull request of someone else that GitHub links to the Issue. */
export interface LinkedPullRequest { number: number; repository?: string; title: string; author: string | null; draft: boolean; url: string; closes: boolean }
/** A comment as its author wrote it, clipped. */
export interface ClaimComment { id: string; author: string | null; association: string | null; created_at: string | null; body: string; url: string | null }
/**
 * What a review and the Manager judge a claim on an Issue from (#1047). The control plane only gathers facts: who is assigned,
 * the open pull requests of other people that GitHub links to the Issue (they reference it, or merging them closes it) and,
 * for the Manager, the latest comments as their authors wrote them. Whether any of it means someone else has taken the Issue
 * on is the model's judgement; nothing here reads what a comment says. `unavailable` names a read that failed, so the model
 * knows to look for itself instead of taking an empty list as "nobody".
 */
export interface ClaimFacts { assignees: string[]; pull_requests: LinkedPullRequest[]; comments?: ClaimComment[]; unavailable?: string }

const clip = (value: unknown, limit: number) => { const text = String(value ?? ''); return text.length > limit ? text.slice(0, limit) + '…' : text; };
const pullRequest = 'number title url state isDraft author{login} repository{nameWithOwner}';
// GitHub's own links between the Issue and pull requests: the ones that close it when merged (closing keywords or the
// Development sidebar) and every cross-reference from a pull request, in this repository or another one.
const linked = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){
  closedByPullRequestsReferences(first:20,includeClosedPrs:false){nodes{${pullRequest}}}
  timelineItems(last:50,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{...on CrossReferencedEvent{willCloseTarget source{...on PullRequest{${pullRequest}}}}}}}}}`;
const latestComments = 10;
// A GraphQL login has no [bot] suffix; the REST one of an App has.
const login = (value: unknown) => String(value ?? '').replace(/\[bot\]$/, '').toLowerCase();

/**
 * Reads the claim facts of an open Issue with the caller's client. `comments` adds the latest comments: those already read
 * (an array), or read now (true). The bot's own pull requests and comments are left out: they are the bot's work, not a claim.
 */
export async function issueClaims(github: GitHub, store: Store, issue: any, options: { comments?: any[] | true } = {}): Promise<ClaimFacts> {
  const facts: ClaimFacts = { assignees: assigneesOf(issue), pull_requests: [] }, failed: string[] = [];
  const reason = (error: unknown) => error instanceof TaskError ? error.code : 'read_failed';
  const number = Number(issue?.number), [owner, name] = github.fullName.split('/'), self = login(github.actorLogin);
  const own = new Set(store.all('SELECT number FROM bot_pull_requests WHERE repository_id=?', String(github.repository.id)).map(row => Number(row.number)));
  try {
    const data = await github.graphql(linked, { owner, name, number });
    const found = new Map<string, LinkedPullRequest>(), node = data?.repository?.issue;
    const add = (pr: any, closes: boolean) => {
      if (!pr?.url || pr.state !== 'OPEN') return;
      const repository = String(pr.repository?.nameWithOwner ?? ''), here = repository.toLowerCase() === github.fullName.toLowerCase();
      if (here && own.has(Number(pr.number)) || self && login(pr.author?.login) === self) return;
      const known = found.get(pr.url);
      found.set(pr.url, { number: Number(pr.number), ...(here ? {} : { repository }), title: clip(pr.title, 200), author: pr.author?.login ?? null,
        draft: pr.isDraft === true, url: String(pr.url), closes: closes || !!known?.closes });
    };
    for (const pr of node?.closedByPullRequestsReferences?.nodes ?? []) add(pr, true);
    for (const event of node?.timelineItems?.nodes ?? []) add(event?.source, event?.willCloseTarget === true);
    facts.pull_requests = [...found.values()];
  } catch (error) { failed.push('pull_requests: ' + reason(error)); }
  if (options.comments) {
    try {
      const all = Array.isArray(options.comments) ? options.comments : await github.pages(github.path(`/issues/${number}/comments`));
      facts.comments = all.filter((c: any) => !(self && login(c?.user?.login) === self) && !String(c?.body ?? '').includes('<!-- dept-bot'))
        .slice(-latestComments).map((c: any) => ({ id: String(c.id ?? ''), author: c.user?.login ?? null, association: c.author_association ?? null,
          created_at: c.created_at ?? null, body: clip(c.body, 1500), url: c.html_url ?? null }));
    } catch (error) { failed.push('comments: ' + reason(error)); }
  }
  return failed.length ? { ...facts, unavailable: failed.join('; ') } : facts;
}
