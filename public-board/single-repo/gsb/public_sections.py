"""Restore the detailed dashboard sections without exporting private account data."""
from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
import json
import re
from datetime import datetime, timedelta, timezone

from .board import BoardStore
from .collectors import collect_ci, _coverage_probe, _tree_paths, OPS_BLOCKS
from .github import GitHubError
from .testparse import summarize_tree, package_of
from .real_e2e_definitions import definition as real_e2e_definition


def _score_with_definition(score):
    if score.get('journey'):
        return score
    details = real_e2e_definition(score.get('case'), score.get('family'))
    return {**score, 'journey': details} if details else score


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


def daily_score_runs(runs, limit=30, usable=None):
    """Use one attempt per Beijing day; a manual dispatch supersedes a schedule.

    With `usable`, only runs whose latest attempt passes it compete for a day.
    """
    latest = {}
    for run in runs:
        ident = run.get('id')
        if ident is None:
            continue
        if run.get('attempt', 1) > latest.get(ident, {}).get('attempt', 0):
            latest[ident] = run
    selected = {}
    for run in latest.values():
        if usable and not usable(run):
            continue
        timestamp = run.get('created_at') or run.get('updated_at') or next(
            (report.get('created_at') for report in run.get('tests', []) if report.get('created_at')), None)
        try:
            when = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
            day = (when if when.tzinfo else when.replace(tzinfo=timezone.utc)).astimezone(
                timezone(timedelta(hours=8))).date().isoformat()
        except (AttributeError, ValueError):
            continue
        rank = (run.get('event') == 'workflow_dispatch', timestamp, run.get('id') or 0)
        if day not in selected or rank > selected[day][0]:
            selected[day] = (rank, run)
    return sorted((entry[1] for entry in selected.values()),
                  key=lambda run: (run.get('created_at') or run.get('updated_at') or '', run.get('id') or 0), reverse=True)[:limit]


def _has_scores(run):
    return any(report.get('name', '').startswith('real-e2e-results') and report.get('scores')
               for report in run.get('tests', []))


def score_history(runs, limit=30):
    """Bounded per-case observations; label carried values separately from measurements.

    A day's point comes from its preferred run that has readable scores, so a manual run
    still in progress, or one whose artifact is unreadable, does not hide an earlier one.
    """
    points = defaultdict(list)
    previous = defaultdict(dict)
    for run in reversed(daily_score_runs(runs, limit, _has_scores)):
        seen = set()
        for report in run.get('tests', []):
            if not report.get('name', '').startswith('real-e2e-results'):
                continue
            for score in report.get('scores', []):
                score = _score_with_definition(score)
                case = score.get('case')
                if not isinstance(case, str) or not case or case in seen:
                    continue
                seen.add(case)
                failed = score.get('delivery') == 'failed'
                metrics = []
                observed = score.get('metrics', [])
                if failed:
                    observed = [*observed, *(dict(label=label, unit=unit, value=None)
                        for label, unit in previous[case] if (label, unit) not in
                        {(m.get('label'), m.get('unit')) for m in observed})]
                for metric in observed:
                    key = (metric.get('label'), metric.get('unit'))
                    value = metric.get('value')
                    usable = isinstance(value, (int, float)) and not isinstance(value, bool)
                    if usable and not failed:
                        previous[case][key] = value
                        metrics.append({**metric, 'source': 'measured'})
                    elif failed:
                        prior = previous[case].get(key)
                        metrics.append({**metric, 'value': prior if prior is not None else 0,
                                        'source': 'carried' if prior is not None else 'baseline'})
                    else:
                        metrics.append({**metric, 'source': 'unavailable'})
                points[case].append({
                    'run_id': run['id'], 'attempt': run.get('attempt', 1),
                    'created_at': run.get('created_at') or report.get('created_at') or run.get('updated_at'),
                    'url': report.get('url') or run.get('url'),
                    'delivery': score.get('delivery'), 'quality_status': score.get('quality_status'),
                    'duration_ms': score.get('duration_ms'),
                    # Lets the page group cases that have left the latest report.
                    **({'family': score['family']} if score.get('family') else {}),
                    **({'journey': score['journey']} if score.get('journey') else {}),
                    **({'model': score['model']} if score.get('model') else {}),
                    'metrics': metrics,
                })
    return {case: rows[-limit:] for case, rows in points.items()}


def latest_score_report(runs):
    """Keep the newest readable Real E2E scores when newer artifacts cannot be parsed."""
    for run in sorted(runs, key=lambda row: (row.get('created_at') or '', row.get('id') or 0), reverse=True):
        for report in run.get('tests', []):
            if report.get('name', '').startswith('real-e2e-results') and report.get('scores'):
                return {'artifact': report['name'], 'run_id': run['id'], 'attempt': run.get('attempt', 1),
                        'branch': run.get('branch'), 'created_at': report.get('created_at') or run.get('updated_at'),
                        'url': report.get('url') or run.get('url'),
                        'scores': [_score_with_definition(score) for score in report['scores']]}
    return None


def public_tests(ctx, runs, owns=None, coverage_eligible=None):
    """Test evidence of ``runs``; filter coverage by branch and run policy."""
    notes = []
    paths, source = _tree_paths(ctx, notes)
    tree = summarize_tree(paths) if paths else None
    scripts = {}
    try:
        pkg = ctx.gh.get_text_file(ctx.repo, 'package.json', ctx.default_branch)
        scripts = {k: v for k, v in json.loads(pkg or '{}').get('scripts', {}).items() if re.search('test|e2e|check|smoke', k)}
    except (GitHubError, ValueError):
        notes.append({'key': 'package.json'})
    executed, seen, artifacts = [], set(), []
    package_counts = {}
    # Keep run / SHA / attempt association from the strict report collector.
    for run in runs:
        for report in run.get('tests', []):
            artifacts.append({'id': report['artifact_id'], 'name': report['name'], 'run_id': run['id'], 'url': report['url'], 'created_at': report.get('created_at')})
            if report['name'] in seen:
                continue
            seen.add(report['name'])
            counts = report.get('counts')
            if report['layer'] == 'unit' and counts:
                for package in report.get('packages', []):
                    package_counts.setdefault(package['package'], {'tests': 0, 'failed': 0})
                    for key in ('tests', 'failed'):
                        package_counts[package['package']][key] += package[key]
                cases = report.get('cases', [])
                # Truncated or non-file-based reports cannot establish a package total.
                if not report.get('packages') and len(cases) == counts['tests'] and all(c.get('file') in paths for c in cases):
                    for case in cases:
                        entry = package_counts.setdefault(package_of(case['file']), {'tests': 0, 'failed': 0})
                        entry['tests'] += 1
                        entry['failed'] += case['status'] == 'failed'
            by_file = defaultdict(lambda: {'specs': 0, 'passed': 0, 'failed': 0, 'skipped': 0, 'flaky': 0, 'timedOut': 0, 'duration_ms': None})
            for case in report.get('cases', []):
                row = by_file[case.get('file') or '(未提供文件)']
                row['specs'] += 1
                row[case['status']] += 1
            executed.append({'artifact': report['name'], 'layer': 'ut' if report['layer'] == 'unit' else report['layer'],
                             'status': 'incomplete' if counts is None else 'failed' if counts['failed'] else 'unstable' if counts['flaky'] or counts['skipped'] else 'passed',
                             'run_id': run['id'], 'sha': run['sha'], 'attempt': run['attempt'], 'branch': run['branch'],
                             'created_at': run['updated_at'], 'url': report['url'], 'duration_ms': None, 'totals': counts,
                             'scores': report.get('scores', []),
                             'detail': {'files': [{'file': k, **v} for k, v in by_file.items()],
                                        'failures': [{'file': c.get('file'), 'title': c['name'], 'status': c['status']} for c in report.get('cases', []) if c['status'] == 'failed'],
                                        'stats': {'expected': (counts or {}).get('passed'), 'unexpected': (counts or {}).get('failed'), 'flaky': (counts or {}).get('flaky')},
                                        'projects': sorted({c['project'] for c in report.get('cases', []) if c.get('project')}),
                                        **{k: report[k] for k in ('commands', 'packages') if k in report}},
                             'note': None if counts else '此运行没有可核验的用例数量。'})
    try:
        store = ctx.coverage_store
        paginate = getattr(ctx.gh, 'paginate', None)
        # With a store, only artifacts created since the last build are listed.
        raw_artifacts = store.listing(ctx.gh, ctx.repo, ctx.now) if store is not None else paginate(
            f'/repos/{ctx.repo}/actions/artifacts', {'per_page': 100}, max_pages=5, key='artifacts'
        ) if paginate else []
    except GitHubError:
        raw_artifacts = []
        notes.append({'key': 'coverage-artifacts'})
    coverage_artifacts = [{
        'id': artifact['id'],
        'name': artifact['name'],
        'size': artifact.get('size_in_bytes'),
        'expired': artifact.get('expired'),
        'created_at': artifact.get('created_at'),
        'expires_at': artifact.get('expires_at'),
        'url': artifact.get('url'),
        'run_id': (artifact.get('workflow_run') or {}).get('id'),
        'branch': (artifact.get('workflow_run') or {}).get('head_branch'),
        'sha': (artifact.get('workflow_run') or {}).get('head_sha'),
    } for artifact in raw_artifacts]
    if owns:
        coverage_artifacts = [artifact for artifact in coverage_artifacts if owns(artifact)]
    if coverage_eligible:
        coverage_artifacts = [artifact for artifact in coverage_artifacts if coverage_eligible(artifact)]
    coverage = _coverage_probe(ctx, coverage_artifacts, paths, {}, notes) if hasattr(ctx.gh, 'get') else {
        'source': None,
        'value': None,
        'attempts': [{'step': 'Actions 覆盖率摘要', 'ok': False, 'detail': '测试替身未提供 GitHub 数据接口。'}],
    }
    # Preserve the generic run-level fallback for repositories that expose
    # coverage through an existing test artifact rather than our summary
    # manifests. ScienceDiscovery normally takes the manifest path above.
    if not coverage.get('source'):
        for run in runs:
            values = run.get('coverage') or []
            if not values:
                continue
            coverage_source = f"Actions run {run['id']} / attempt {run['attempt']} · {run['sha'][:12]}"
            coverage.update(source=coverage_source, value=values[0])
            coverage.setdefault('attempts', []).insert(0, {
                'step': 'Actions 测试产物', 'ok': True, 'detail': coverage_source,
            })
            break
    return {'notes': notes, 'tree_source': source, 'tree': {k: v for k, v in tree.items() if k != 'inventory'} if tree else None,
            'inventory': [{**row, 'ci_cases': package_counts.get(row['package'], {}).get('tests'), 'ci_failed': package_counts.get(row['package'], {}).get('failed')} for row in (tree or {}).get('inventory', [])],
            'test_scripts': scripts, 'artifacts_recent': artifacts[:30], 'executed': executed,
            'score_history': score_history(runs), 'score_report': latest_score_report(runs), 'coverage': coverage}


def extend_project(doc, ctx):
    meta = ctx.repo_meta
    repo = {key: meta.get(key) for key in ('description', 'default_branch', 'language', 'pushed_at')}
    repo.update(stars=meta.get('stargazers_count'), forks=meta.get('forks_count'), license=(meta.get('license') or {}).get('spdx_id'))
    wrap = lambda value: {'status': 'ok' if value is not None else 'error', 'data': value, 'notes': [], 'error': None if value is not None else {'kind': 'error', 'message': '数据暂不可读取'}}
    sections = {'repo': wrap(repo), 'issues': wrap(doc['issues']), 'prs': wrap(doc['prs'])}
    with ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {'ci': pool.submit(envelope, lambda: collect_ci(ctx)),
                'tests': pool.submit(envelope, lambda: public_tests(ctx, doc['quality']['runs'])),
                'ops': pool.submit(envelope, lambda: public_ops(ctx))}
        sections.update({k: future.result() for k, future in jobs.items()})
    doc.update(repo=ctx.repo, repo_url=meta['html_url'], sections=sections,
               config={'artifact_names': ctx.cfg.artifact_names, 'stale_days': ctx.cfg.stale_days,
                       'review_sla_days': ctx.cfg.review_sla_days, 'pr_idle_days': ctx.cfg.pr_idle_days})
    # Build only GitHub-derived defaults; never load .data/board.json into a public export.
    board = BoardStore(ctx.cfg, persist=False)
    doc['board'] = board.payload(doc)
    doc['details'] = {}
    for kind, section, keys in (('issue', doc['issues'] or {}, ('items', 'closed_recent')),
                                ('pr', doc['prs'] or {}, ('items', 'recent_merged', 'recent_closed_unmerged'))):
        for key in keys:
            for item in section.get(key, []):
                doc['details'][f"{kind}:{item['number']}"] = {'body': item.get('body', ''), 'cross_references': []}
