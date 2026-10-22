/**
 * Publish a delegated review result as the bot (#1 answer 3).
 *
 * The external worker returns structured text; the control plane attaches it to the PR as a
 * COMMENT review on the head it actually reviewed. The worker never receives a GitHub credential.
 */

import { Redactor } from '../agent/common.js';
import { GitHub } from '../github/client.js';
import type { Store } from '../storage/database.js';

export async function publishAsBot(
  store: Store, repositoryId: string, pullNumber: number, headSha: string, body: string,
): Promise<{ id: string; url: string }> {
  const repository = store.get('SELECT * FROM repositories WHERE id=?', repositoryId);
  if (!repository) throw new Error('repository_not_found');
  const github = new GitHub(store, repository, new Redactor(), async () => {});
  await github.connect(false);
  const response = await github.request('POST', github.path(`/pulls/${pullNumber}/reviews`), {
    commit_id: headSha, event: 'COMMENT', body: `Reviewed commit: ${headSha}\n\n${body}`,
  });
  return { id: String(response.id ?? ''), url: String(response.html_url ?? '') };
}
