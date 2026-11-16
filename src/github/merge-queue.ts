export type MergeQueueState = 'enabled' | 'disabled' | 'unknown';
export interface MergeQueueReader {
  /** A GitHub REST GET relative to the API root; null for 404, throws otherwise. */
  get(path: string): Promise<any | null>;
  graphql(query: string, variables: Record<string, unknown>): Promise<any>;
}
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/**
 * Whether the default branch requires a merge queue. A ruleset's merge_queue rule says so directly; an unprotected branch
 * without one has none. Classic branch protection does not show it over REST, so GraphQL's mergeQueue settles that case.
 * Anything the token cannot read stays unknown. `rules` are the branch's rulesets as read, null when they could not be.
 */
export async function mergeQueue(reader: MergeQueueReader, full: string, branch: string): Promise<{ state: MergeQueueState; evidence: string; rules: any[] | null }> {
  const repo = `/repos/${encode(full)}`;
  let rules: any[] | null = null;
  try { const value = await reader.get(`${repo}/rules/branches/${encode(branch)}`); rules = Array.isArray(value) ? value : null; } catch { rules = null; }
  const queued = rules?.find(rule => rule?.type === 'merge_queue');
  if (queued) return { state: 'enabled', evidence: `默认分支 ${branch} 的规则集${queued.ruleset_id ? ` ${queued.ruleset_id} ` : ''}要求 merge queue`, rules };
  let protectedBranch: boolean | null = null;
  try { const value = await reader.get(`${repo}/branches/${encode(branch)}`); protectedBranch = typeof value?.protected === 'boolean' ? value.protected : null; } catch { protectedBranch = null; }
  if (rules && protectedBranch === false) return { state: 'disabled', evidence: `默认分支 ${branch} 的规则集没有 merge queue，也没有经典分支保护`, rules };
  try {
    const [owner, name] = full.split('/');
    const value = await reader.graphql('query($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){mergeQueue(branch:$branch){id}}}', { owner, name, branch });
    if (!value?.errors && value?.data?.repository) return value.data.repository.mergeQueue
      ? { state: 'enabled', evidence: `GitHub 报告默认分支 ${branch} 已启用 merge queue`, rules }
      : { state: 'disabled', evidence: `GitHub 报告默认分支 ${branch} 没有启用 merge queue`, rules };
  } catch { /* Falls through to unknown. */ }
  return { state: 'unknown', evidence: rules ? `默认分支 ${branch} 有分支保护，但安装令牌读不到它是否要求 merge queue` : '安装令牌读不到默认分支的规则集', rules };
}
