import type { GitHub } from './client.js';
import { TaskError } from '../agent/common.js';
import { classificationLabels, pullRequestLabels, repositoryLabels } from '../review/labels.js';

// Labels an agent chooses for its pull request (#845). A repository's own rules (for example a contribution guide or a
// create-github-pr skill asking for one release:* label) tell the agent which to pick; the platform only checks them against the
// repository by the same rules as review classification labels, and adds them once the pull request exists.

/** The optional labels argument of create_pull_request and of a software submit_delivery. */
export const pullRequestLabelsSchema = { type: 'array', maxItems: 8, items: { type: 'string' }, description: 'Optional labels for the pull request, '
  + 'each an existing label of this repository. Use them when the repository\'s contribution rules or skills ask for them (for example one '
  + 'release:* category). Reserved labels (agent/*, pr/*, gate/*, blocker, priority/critical) and the bot\'s review and development labels are '
  + 'refused. The control plane adds them after the pull request is created; a label is skipped when a person already set another label of the '
  + 'same prefix (such as type/…) on the pull request, and at most one priority/… label is added.' };

const readLabels = (github: GitHub) => github.pages(github.path('/labels')).then(repositoryLabels);

/**
 * Checks the requested labels before anything is published. Returns the repository's names to keep on the candidate, or a tool
 * error the agent can correct in the same conversation: which names were refused and why.
 */
export async function checkPullRequestLabels(github: GitHub, requested: unknown, own: string[]):
  Promise<{ labels: string[] } | { error: string; refused: { name: string; reason: string }[]; message: string }> {
  if (requested === undefined || Array.isArray(requested) && !requested.length) return { labels: [] };
  let available: { name: string }[];
  try { available = await readLabels(github); } catch (error) {
    if (!(error instanceof TaskError) || !error.code.startsWith('github_permission_')) throw error;
    return { error: 'pull_request_labels_refused', refused: [], message: 'The repository\'s labels cannot be read with this installation, so no labels can be checked. Call again without labels.' };
  }
  const { labels, refused } = pullRequestLabels(requested, available, own);
  if (!refused.length) return { labels };
  return { error: 'pull_request_labels_refused', refused, message: 'Some labels cannot be put on the pull request: a label must already exist in the '
    + 'repository, must not be reserved (agent/*, pr/*, gate/*, blocker, priority/critical) or be the bot\'s own review or development label, and '
    + 'at most 8 are kept. Fix labels (or omit them) and call again; the repository\'s own contribution rules say which labels it expects.' };
}

/**
 * Adds the candidate's labels to the pull request after it exists. The rules are applied again against the repository and the
 * pull request's current labels, so a retry adds nothing twice and a label a person already set on the same axis stays. Labels
 * are an addition to the pull request, not part of it: a GitHub refusal is logged and publication continues.
 */
export async function applyPullRequestLabels(github: GitHub, number: number, requested: string[] | undefined, log: (value: any) => void): Promise<string[]> {
  if (!requested?.length) return [];
  const path = github.path(`/issues/${number}/labels`);
  try {
    const names = classificationLabels(requested, await readLabels(github), await github.pages(path), []);
    if (names.length) await github.request('POST', path, { labels: names });
    log({ type: 'pr_labels', pr_number: number, requested, added: names });
    return names;
  } catch (error) {
    if (!(error instanceof TaskError) || !error.code.startsWith('github_')) throw error;
    log({ type: 'pr_labels', pr_number: number, requested, added: [], error_code: error.code });
    return [];
  }
}
