import type { Store, Row } from '../storage/database.js';
import { authorize, resolvePrincipalActor } from '../identity/authorization.js';

/**
 * The project's auto-merge policy (#1170): whether agents may merge pull requests on their own.
 *
 * - disallow (default): no agent merges on its own. A merge needs a maintainer's explicit request for that pull request.
 * - non_bot_only: agents may merge pull requests the bot did not open when the repository's rules allow it; the bot's own
 *   pull requests (bot_pull_requests) still need a maintainer's explicit request.
 * - allow_all: agents may merge any pull request, the bot's own included, when the repository's rules allow it.
 *
 * Merging and adding to a merge queue are one action (github_write's PUT /pulls/{n}/merge picks whichever the base branch
 * uses) under one gate: the develop ceiling, Contents and Pull requests write, and this policy. Which checks, reviews or
 * labels a merge needs stays with the repository (branch protection, rulesets and the project's prompts); the platform
 * only refuses merges the policy does not allow and states the policy in every prompt that can merge.
 */
export const autoMergePolicies = ['disallow', 'non_bot_only', 'allow_all'] as const;
export type AutoMergePolicy = typeof autoMergePolicies[number];
export const isAutoMergePolicy = (value: unknown): value is AutoMergePolicy => (autoMergePolicies as readonly unknown[]).includes(value);

/** The project's policy now; a missing or unknown value is the default, disallow. */
export function autoMergePolicy(store: Store, repositoryId: string, policy: Row | undefined = store.get('SELECT auto_merge_policy FROM policies WHERE repository_id=?', repositoryId)): AutoMergePolicy {
  return isAutoMergePolicy(policy?.auto_merge_policy) ? policy!.auto_merge_policy : 'disallow';
}
/** Whether a merge of this pull request needs a maintainer's explicit request under the policy. */
export const mergeNeedsRequest = (policy: AutoMergePolicy, botPullRequest: boolean) => policy === 'disallow' || policy === 'non_bot_only' && botPullRequest;
/**
 * Is this the bot's own pull request? Registered by the framework publisher (bot_pull_requests), or opened by the bot's
 * GitHub account some other way (github_write POST /pulls): its live author is the bot. An author that cannot be read counts
 * as the bot's, so a doubt never loosens non_bot_only.
 */
export function isBotPullRequest(store: Store, repositoryId: string, number: number, author?: { id?: unknown } | null, botActorId?: string): boolean {
  if (store.get('SELECT 1 FROM bot_pull_requests WHERE repository_id=? AND number=?', repositoryId, number)) return true;
  if (author === undefined) return false;
  const id = String(author?.id ?? '');
  return !/^[1-9]\d*$/.test(id) || !!botActorId && id === botActorId;
}

// Where a maintainer's request can come from depends on the caller: only a conversation (a management or group assistant)
// has a message of its own to pass as current_message; the Manager and tasks pass a GitHub link.
const request = (conversation: boolean) => 'a maintainer (write access or higher) explicitly asked for that pull request to be merged, '
  + (conversation ? 'in a GitHub comment or review on it, or in the message you are answering' : 'in a GitHub comment or review on it (a request made in Feishu or the management conversation is merged by the assistant there)')
  + '; pass that request as merge_request and cite it where you report the merge. An approval, "LGTM" or passing checks are not such a request';
const levels = (conversation: boolean): Record<AutoMergePolicy, string> => ({
  disallow: `The project's auto-merge policy is disallow: never merge a pull request on your own, the bot's own included. Merge one only when ${request(conversation)}.`,
  non_bot_only: `The project's auto-merge policy is non_bot_only: you may merge a pull request the bot did not open when the repository's rules allow it. A pull request the bot opened is merged only when ${request(conversation)}.`,
  allow_all: "The project's auto-merge policy is allow_all: you may merge any pull request, the bot's own included, when the repository's rules allow it.",
});
const how = ' Merging is github_write PUT /pulls/{n}/merge: the control plane adds the pull request to the merge queue when its base branch requires one and merges it directly otherwise, refuses a merge the policy does not allow, refuses merging pull requests that modify .github/workflows/ (even under allow_all; a human maintainer must review and merge them on GitHub), and refuses one when it cannot tell whether the base branch requires a queue. '
  + 'A write that moves the default branch without a pull request (POST /merges into it, PATCH or DELETE of its ref, a file written on it) counts as merging the bot\'s own change: below allow_all it needs the same maintainer request, so prefer a pull request. '
  + 'The repository decides what a merge needs (required checks, reviews, labels and rulesets, its contributing rules and the project\'s prompts): read them and the pull request\'s current state first, and merge only what they allow.';
const short = (conversation: boolean, level: AutoMergePolicy) => levels(conversation)[level].replace("The project's auto-merge policy is " + level + ':', level + ':');
/** The merge boundary an agent that can merge in one project is told, for the project's current policy. */
export function mergeBoundary(policy: AutoMergePolicy, conversation = false): string { return levels(conversation)[policy] + how; }
/**
 * The merge boundary of an assistant that serves several repositories: each repository's policy, then what each level
 * present means. Never lists more than a few dozen repositories; the rest follow the same rule from their own policy.
 */
export function scopedMergeBoundary(projects: { full_name: string; policy: AutoMergePolicy }[]): string {
  if (!projects.length) return '';
  const shown = projects.slice(0, 30), present = autoMergePolicies.filter(level => projects.some(p => p.policy === level));
  return ` Merging follows each repository's auto-merge policy (${shown.map(p => `${p.full_name}: ${p.policy}`).join('; ')}${projects.length > shown.length ? '; the others: see their project policy' : ''}). `
    + present.map(level => short(true, level)).join(' ') + how;
}
/** The rule of an assistant with no fixed project: the policy is read per project. */
export const projectMergeBoundary = " Merging follows the project's auto-merge policy (auto_merge_policy in get_effective_config): "
  + autoMergePolicies.map(level => short(true, level)).join(' ') + how;

/**
 * Does this GitHub user have write access (write, maintain or admin) to the repository? Answered from the platform's own
 * collaborator and installation-owner caches (#1158), never from a comment's author_association.
 */
export function githubMaintainer(store: Store, repositoryId: string, githubUserId: string): boolean {
  return !!store.get(`SELECT 1 FROM github_repository_collaborators WHERE repository_id=? AND github_user_id=? AND role IN ('write','maintain','admin')
    UNION ALL SELECT 1 FROM github_installation_owners o JOIN installation_repositories r ON r.installation_ref=o.installation_ref
      WHERE r.repository_id=? AND r.present=1 AND o.github_user_id=? LIMIT 1`, repositoryId, githubUserId, repositoryId, githubUserId);
}
/**
 * Is this platform person a maintainer of the project: a human whose live authority includes writing tasks there, which
 * repository write access (or project administration) grants?
 */
export function principalMaintainer(store: Store, principalId: string, repositoryId: string): boolean {
  if (store.get('SELECT kind FROM principals WHERE id=?', principalId)?.kind !== 'human') return false;
  try { authorize(resolvePrincipalActor(store, principalId, null, repositoryId, 'service'), 'tasks.write', { project_id: repositoryId }); return true; }
  catch { return false; }
}
