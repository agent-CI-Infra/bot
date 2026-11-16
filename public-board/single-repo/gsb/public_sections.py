"""Public repository maintenance views (releases, branches, community, activity), without private account data."""
from concurrent.futures import ThreadPoolExecutor

from .collectors import OPS_BLOCKS
from .github import GitHubError


def envelope(fn):
    try:
        result = fn()
        notes = result.pop('notes', [])
        safe_notes = [{'what': n.get('what') or n.get('key') or '数据源', 'message': '此项数据不完整或暂不可读取。'} for n in notes]
        return {'status': 'partial' if notes else 'ok', 'data': result, 'notes': safe_notes, 'error': None}
    except Exception:
        return {'status': 'error', 'data': None, 'notes': [], 'error': {'kind': 'error', 'message': '该区块暂不可读取，请稍后查看新快照。'}}


def public_ops(ctx):
    notes = []
    out = {'notes': notes, 'security': None, 'traffic': None}
    # These are explicitly public repository maintenance views. Never call the private collectors.
    keys = ('releases', 'branches', 'community', 'activity', 'commits', 'stale_automation')
    with ThreadPoolExecutor(max_workers=4) as pool:
        tasks = {k: pool.submit(OPS_BLOCKS[k][0], ctx, notes) for k in keys}
        for key, future in tasks.items():
            try:
                value = future.result()
            except Exception:
                notes.append({'key': key})
                value = None
            if key == 'commits':
                out['recent_commits'], out['commits_7d'] = value or ([], None)
            elif key == 'stale_automation':
                out[key] = value or {'workflow': None}
            else:
                out[key] = value
    if out.get('branches'):
        protection = out['branches']['protection']
        for key in ('reason', 'hint', 'kind'):
            protection.pop(key, None)
    out['public_advisories'] = None
    try:
        advisories = ctx.gh.get(f'/repos/{ctx.repo}/security-advisories', {'per_page': 30})
        out['public_advisories'] = [{'id': a.get('ghsa_id'), 'summary': a.get('summary'), 'severity': a.get('severity'),
                                    'url': a.get('html_url'), 'published_at': a.get('published_at')}
                                   for a in advisories if a.get('state') == 'published']
    except GitHubError:
        pass
    return out
