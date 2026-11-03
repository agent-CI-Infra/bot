"""Build a public, read-only project management snapshot from GitHub evidence."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import re
import zipfile
from urllib.parse import quote

from .ci_lanes import build_lanes
from .ci_gates import parse_artifact as parse_gate_artifact, summary as gate_summary
from .tagged import TaggedStore
from .collectors import Context, collect_issues, collect_prs
from .config import Config
from .github import GitHubError
from .reports import artifact_layer, parse_report_zip

REPO_RE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")


def channel(run, rules):
    for kind in ("release", "daily"):
        if any(re.search(pattern, run.get("name", ""), re.I) for pattern in rules.get(kind, [])):
            return kind
    if run.get("event") == "release" or re.search(r"release|version|版本|发布", run.get("name", ""), re.I):
        return "release"
    if run.get("event") == "schedule" or re.search(r"nightly|daily|每日|夜间", run.get("name", ""), re.I):
        return "daily"
    return "gate"


COVERAGE_SUMMARY = re.compile(r"(node|python)-coverage-summary-")
GATE_REPORT = re.compile(r"ci-gates-reports", re.I)
REPORT_NAME = re.compile(r"results|junit|playwright|test.report|dashboard", re.I)
RAW_COVERAGE = re.compile(r"coverage|lcov|codecov", re.I)


def slim_run(run, rules):
    return {"id": run["id"], "name": run.get("name"), "workflow_id": run.get("workflow_id"),
            "channel": channel(run, rules), "event": run.get("event"), "status": run.get("status"),
            "conclusion": run.get("conclusion"), "branch": run.get("head_branch"), "sha": run.get("head_sha"),
            "attempt": run.get("run_attempt", 1), "created_at": run.get("created_at"),
            "started_at": run.get("run_started_at"), "updated_at": run.get("updated_at"), "url": run.get("html_url"),
            "pull_requests": [p["number"] for p in run.get("pull_requests", [])],
            # Fork PR runs carry no pull_requests; the head repository lets the
            # CI lanes match them to the right PR.
            "head_repo": (run.get("head_repository") or {}).get("full_name"),
            # The branch a same-repository PR run targets; fork PRs are matched later.
            "base_branch": ((run.get("pull_requests") or [{}])[0].get("base") or {}).get("ref"), "tests": [], "jobs": [],
            "reports_status": "not_inspected"}


def run_details(gh, cfg, run, *, cache=None, parser_version=None):
    base = f"/repos/{cfg.repo}/actions/runs/{run['id']}"
    try:
        jobs = gh.paginate(base + f"/attempts/{run['attempt']}/jobs", key="jobs", max_pages=2)
        run["jobs"] = [{"name": j.get("name"), "status": j.get("status"), "conclusion": j.get("conclusion"),
                        "url": j.get("html_url"), "failed_steps": [s["name"] for s in j.get("steps", []) if s.get("conclusion") == "failure"]}
                       for j in jobs]
        run["jobs_status"] = "available"
    except GitHubError:
        run["jobs_status"] = "unavailable"
    try:
        artifacts = gh.paginate(base + "/artifacts", key="artifacts", max_pages=3)
    except GitHubError:
        run["reports_status"] = "unavailable"
        return run
    run["reports_status"] = "missing"
    cached = {str(t["artifact_id"]): t for t in (cache or {}).get("tests", [])}
    # Artifacts already read that held no test counts; the same artifact is not downloaded again.
    inspected = dict((cache or {}).get("inspected") or {})
    run["tests"] = []
    # A run that publishes coverage summaries needs none of its raw coverage data.
    summarized = any(COVERAGE_SUMMARY.match(artifact["name"]) for artifact in artifacts)
    for artifact in artifacts:
        name = artifact["name"]
        if GATE_REPORT.search(name):
            if artifact.get("expired") or artifact.get("size_in_bytes", 0) > cfg.artifact_max_bytes:
                continue
            try:
                parsed = parse_gate_artifact(gh.download_artifact(cfg.repo, artifact["id"], max_bytes=cfg.artifact_max_bytes))
                if parsed:
                    run["gates"] = parsed
            except (GitHubError, ValueError):
                pass
            continue
        if not (REPORT_NAME.search(name) or RAW_COVERAGE.search(name)):
            continue
        # Coverage summaries hold no test reports; the coverage view reads them once through its store.
        if COVERAGE_SUMMARY.match(name) or (summarized and not REPORT_NAME.search(name)):
            continue
        if run.get("next_started_at") and artifact.get("created_at", "") >= run["next_started_at"]:
            continue
        association = artifact.get("workflow_run") or {}
        if association.get("head_sha") and association["head_sha"] != run["sha"]:
            continue
        # Artifacts survive reruns. Never attribute an earlier attempt to this one.
        if run["attempt"] > 1 and artifact.get("created_at", "") < (run.get("started_at") or ""):
            continue
        previous = cached.get(str(artifact["id"]))
        identity = [run["id"], run["attempt"], artifact["id"], artifact.get("digest"), artifact.get("updated_at"), parser_version]
        if previous and previous.get("counts") is not None and (previous.get("cache_key") == identity or artifact.get("expired")):
            run["tests"].append(previous)
            continue
        if inspected.get(str(artifact["id"])) == identity:
            if previous:
                run["tests"].append(previous)
            continue
        entry = {"cache_key": identity, "name": name, "layer": artifact_layer(name), "artifact_id": artifact["id"],
                 "created_at": artifact.get("created_at"), "url": run["url"] + f"/artifacts/{artifact['id']}",
                 "status": "expired" if artifact.get("expired") else "unavailable", "counts": None, "cases": []}
        if not artifact.get("expired"):
            try:
                if artifact.get("size_in_bytes", 0) > cfg.artifact_max_bytes:
                    raise ValueError("artifact over budget")
                parsed = parse_report_zip(gh.download_artifact(cfg.repo, artifact["id"], max_bytes=cfg.artifact_max_bytes))
                if parsed:
                    # Frozen test catalogs are large; callers move them out of the run record.
                    run.setdefault("tagged", []).extend(parsed.get("tagged") or [])
                    if parsed.get("coverage"):
                        # A new parser version reads the artifact again; replace, never duplicate.
                        run["coverage"] = [c for c in run.get("coverage", []) if c.get("artifact") != name]
                    for coverage in parsed.get("coverage", []):
                        run.setdefault("coverage", []).append({**coverage, "artifact": name, "run_id": run["id"], "sha": run["sha"], "attempt": run["attempt"], "url": run["url"]})
                    if parsed.get("scores"):
                        entry["scores"] = parsed["scores"]
                    if parsed.get("tests") is None:
                        if parsed.get("scores"):
                            entry.update(status="available", format="scores")
                            run["tests"].append(entry)
                        inspected[str(artifact["id"])] = identity
                        continue
                    entry.update(status="available", counts={k: parsed[k] for k in ("tests", "passed", "failed", "skipped", "flaky")},
                                 cases=parsed["cases"], format=parsed["format"])
                    for key in ("commands", "packages"):
                        if key in parsed:
                            entry[key] = parsed[key]
                else:
                    entry["status"] = "no_counts"
                    inspected[str(artifact["id"])] = identity
            except (ValueError, zipfile.BadZipFile) as error:
                # Over budget or malformed: the same artifact fails the same way, so it is not read again.
                entry.update(status="unreadable", error=type(error).__name__)
                inspected[str(artifact["id"])] = identity
            except (GitHubError, OSError, RuntimeError) as error:
                entry["error"] = getattr(error, "kind", type(error).__name__)
        run["tests"].append(entry)
    # Deleting/expiring an artifact must not erase previously observed counts.
    for key, previous in cached.items():
        if previous.get("counts") is not None and not any(str(t["artifact_id"]) == key for t in run["tests"]):
            run["tests"].append(previous)
    if inspected:
        run["inspected"] = inspected
    if run["tests"]:
        run["reports_status"] = "available" if all(t["counts"] is not None for t in run["tests"]) else "partial"
    return run


def build_project(gh, repo, settings=None):
    if not REPO_RE.fullmatch(repo):
        raise ValueError("expected owner/repository")
    settings = settings or {}
    meta = gh.get(f"/repos/{repo}")
    cfg = Config.from_env(repo=repo, review_sla_days=int(settings.get("review_sla_days", 3)),
                          stale_days=int(settings.get("stale_days", 30)))
    if (meta.get("private") or meta.get("visibility", "public") != "public") and not cfg.allow_private:
        raise ValueError("public dashboard export only accepts public source repositories")
    now = datetime.now(timezone.utc)
    context = Context(gh, cfg, now, meta)
    doc = {"schema_version": 1, "generated_at": now.isoformat(), "repository": {
        "name": repo, "url": meta["html_url"], "description": meta.get("description"),
        "default_branch": meta["default_branch"], "stars": meta.get("stargazers_count", 0)},
        "issues": None, "prs": None, "quality": {"runs": [], "workflows": [], "required_checks": None},
        "releases": [], "notices": [], "limits": {"open_issues": 500, "open_prs": 200, "runs": 100, "detailed_runs": 12}}
    # Reuse the existing metadata collectors. No private ops, traffic, auth or security data is exported.
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = {"issues": pool.submit(collect_issues, context), "prs": pool.submit(collect_prs, context)}
        for section, future in pending.items():
            try:
                value = future.result()
                notes = value.pop("notes", [])
                doc[section] = value
                if notes:
                    doc["notices"].append({"section": section, "message": "部分补充信息不可读取，请以 GitHub 原页面为准。"})
            except GitHubError:
                doc["notices"].append({"section": section, "message": "GitHub 数据读取失败；未将缺失数据计为零。"})
    rules = settings.get("workflows", {})
    tagged = TaggedStore()
    try:
        raw_runs = gh.get(f"/repos/{repo}/actions/runs", {"per_page": 100}).get("workflow_runs", [])
        runs = sorted([slim_run(r, rules) for r in raw_runs], key=lambda r: r.get("created_at") or "", reverse=True)
        workflows = gh.get(f"/repos/{repo}/actions/workflows").get("workflows", [])
        doc["quality"]["workflows"] = [{k: w.get(k) for k in ("id", "name", "path", "state", "html_url")} for w in workflows]
        # Inspect latest per lane/workflow first, then fill remaining slots with recent runs.
        selected, seen = [], set()
        for run in runs:
            key = (run["workflow_id"], run["channel"])
            if key not in seen:
                seen.add(key)
                selected.append(run)
        selected = (selected + [r for r in runs if r not in selected])[:12]
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda r: run_details(gh, cfg, r), selected))
        for run in runs:
            tagged.observe(run, run.pop("tagged", None) or [], meta["default_branch"])
        doc["quality"]["runs"] = runs
        doc["quality"]["status"] = "available"
    except GitHubError:
        doc["quality"]["status"] = "unavailable"
        doc["notices"].append({"section": "quality", "message": "Actions 数据不可读取，构建与测试结果未知。"})
    try:
        branch = quote(meta["default_branch"], safe="")
        branch_meta = gh.get(f"/repos/{repo}/branches/{branch}")
        doc["quality"]["branch_protected"] = branch_meta.get("protected")
        if branch_meta.get("protected"):
            protection = gh.get(f"/repos/{repo}/branches/{branch}/protection")
            checks = protection.get("required_status_checks") or {}
            doc["quality"]["required_checks"] = list(dict.fromkeys(checks.get("contexts", []) + [c["context"] for c in checks.get("checks", [])]))
    except GitHubError:
        pass
    try:
        for release in gh.get(f"/repos/{repo}/releases", {"per_page": 15}):
            if release.get("draft"):
                continue
            tag = release["tag_name"]
            try:
                sha = gh.get(f"/repos/{repo}/commits/{quote(tag, safe='')}")["sha"]
            except GitHubError:
                sha = None
            matched = [r for r in doc["quality"]["runs"] if sha and r["sha"] == sha and r["channel"] == "release"]
            doc["releases"].append({"tag": tag, "name": release.get("name") or tag, "prerelease": release.get("prerelease"),
                                    "published_at": release.get("published_at"), "url": release["html_url"], "sha": sha,
                                    "validation_run_ids": [r["id"] for r in matched]})
    except GitHubError:
        doc["notices"].append({"section": "releases", "message": "版本列表读取失败。"})
    # Never accidentally include the collector credential in public output.
    from .public_sections import extend_project
    extend_project(doc, context)
    ci = doc["sections"]["ci"].get("data")
    if ci is not None:
        runs = doc["quality"]["runs"]
        # This export reads a single page of runs; earlier days are marked uncollected.
        ci["lanes"] = build_lanes(runs, default_branch=meta["default_branch"], now=now, rules=rules,
                                  prs=[pr for key in ("items", "recent_merged", "recent_closed_unmerged") for pr in (doc["prs"] or {}).get(key, [])],
                                  collected_since=runs[-1]["created_at"] if len(runs) >= 100 else None)
        ci["gates"] = gate_summary(runs)
    try:
        # The vocabulary only fills defaults; an unreadable copy must not hide Actions data.
        tagged.refresh_schema(gh.get_text_file, repo)
    except GitHubError:
        pass
    tests = doc["sections"]["tests"].get("data")
    if isinstance(tests, dict):
        tests["tagged"] = tagged.view(meta["default_branch"])
    if gh.token and gh.token in json.dumps(doc, ensure_ascii=False):
        raise ValueError("credential detected in export")
    return doc
