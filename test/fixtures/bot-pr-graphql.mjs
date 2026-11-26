// Answers the bot PR reconcile's batched GraphQL query (`pN: pullRequest(number: N)` aliases) from a fake GitHub's REST-shaped
// state: pulls by number, branch tips by name, and check suites by head commit. A number without a pull request answers
// null with GitHub's NOT_FOUND error for that alias, as GitHub does.
export function botPrGraphql(body, { pulls, refs = {}, checkSuites = new Map() }) {
  const repository = {}, errors = [];
  for (const [, alias, number] of String(body?.query || '').matchAll(/(p\d+):pullRequest\(number:(\d+)\)/g)) {
    const pr = pulls.get(Number(number));
    if (!pr) {
      repository[alias] = null;
      errors.push({ type: 'NOT_FOUND', path: ['repository', alias], message: `Could not resolve to a PullRequest with the number of ${number}.` });
      continue;
    }
    const suites = checkSuites.get(pr.head.sha) || [];
    const tip = refs[pr.base.ref];
    repository[alias] = {
      number: pr.number,
      state: pr.state === 'open' ? 'OPEN' : pr.merged ? 'MERGED' : 'CLOSED',
      isDraft: pr.draft === true,
      mergeable: pr.mergeable === true ? 'MERGEABLE' : pr.mergeable === false ? 'CONFLICTING' : 'UNKNOWN',
      updatedAt: pr.updated_at ?? null,
      headRefName: pr.head.ref,
      headRefOid: pr.head.sha,
      baseRefName: pr.base.ref,
      baseRefOid: pr.base.sha ?? null,
      baseRef: tip ? { target: { oid: tip } } : null,
      commits: { nodes: [{ commit: { oid: pr.head.sha, checkSuites: { totalCount: suites.length, nodes: suites.map(s => ({
        databaseId: s.id,
        status: String(s.status || '').toUpperCase(),
        conclusion: s.conclusion ? String(s.conclusion).toUpperCase() : null,
      })) } } }] },
    };
  }
  return { data: { repository }, ...(errors.length ? { errors } : {}) };
}
