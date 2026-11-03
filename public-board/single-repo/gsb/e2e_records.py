"""E2E run records: Playwright case steps and HTML reports for runs on the board.

The incremental history keeps only counts. Records are replaced on every
collection instead. One listing of the newest ``e2e-results`` artifacts (a
single page, no cursor) is matched against the runs the snapshot shows, and the
newest unexpired ones are kept, at most MAX_RECORDS. Case steps are small public
JSON under site/data/e2e/. HTML reports never enter git. A collection writes the
reports it downloaded to a bundle directory, and the workflow keeps that bundle
as an Actions artifact until the source artifacts expire. The Pages deployment
then attaches the reports that have not expired yet (attach()).
"""
from __future__ import annotations

import base64
import binascii
import io
import json
import math
import posixpath
import re
import shutil
import time
import zipfile
from datetime import datetime, timezone
from html import escape, unescape
from html.parser import HTMLParser
from pathlib import Path, PureWindowsPath
from urllib.parse import quote

from .github import GitHubError
from .history import encode, read_json
from .reports import FIELDS, test_outcome, totals

ARTIFACT = "e2e-results"
BUNDLE = "e2e-html"
BUNDLE_WORKFLOW = ".github/workflows/collect.yml"
INDEX = "site/data/e2e/index.json"
VERSION = 3
MAX_RECORDS = 20                  # newest unexpired artifacts that get records
MAX_DOWNLOADS = 2                 # source artifact downloads per collection
ARTIFACT_BYTES = 80 * 1024 * 1024  # one compressed ZIP, including this separate phase
REPORT_BYTES = 40 * 1024 * 1024   # one report, including referenced journey directories
SITE_BYTES = 256 * 1024 * 1024    # all attached reports together
MAX_CASES, MAX_STEPS, STEP_DEPTH = 500, 3000, 8
# Generated slice IDs stay ASCII; report attachments keep their original names.
SLICE = re.compile(r"[A-Za-z0-9_@+=-][A-Za-z0-9._@+=-]{0,127}")
UNSAFE_PATH_CHAR = re.compile(r"[/\\\x00-\x1f\x7f-\x9f\ud800-\udfff]")
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
FRAME = re.compile(r"\s+at\s")
HTML_ATTR = re.compile(r'''([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))''')


def _time(value):
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)


def _text(value, limit=300):
    return ANSI.sub("", str(value or "")).strip()[:limit]


def _ms(value):
    return round(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else None


def error_summary(errors):
    """First lines of the first error message, without colours or stack frames."""
    for error in [errors] if isinstance(errors, dict) else errors or []:
        message = error.get("message") or error.get("value") if isinstance(error, dict) else None
        lines = [line.rstrip() for line in ANSI.sub("", str(message or "")).strip().splitlines() if not FRAME.match(line)]
        summary = "\n".join(lines[:16]).strip()
        if summary:
            return summary[:1200]
    return None


def _steps(rows, depth, budget):
    """Nested test.step records in report order; a step with an error failed."""
    out = []
    for row in rows or []:
        if budget[0] <= 0 or not isinstance(row, dict):
            break
        budget[0] -= 1
        error = error_summary(row.get("error"))
        step = {"title": _text(row.get("title")), "duration_ms": _ms(row.get("duration")), "status": "failed" if error else "passed"}
        if error:
            step["error"] = error
        children = _steps(row.get("steps"), depth + 1, budget) if depth < STEP_DEPTH else []
        if children:
            step["steps"] = children
        out.append(step)
    return out


def playwright_cases(doc, attachment_html=None):
    """Every test instance of a Playwright JSON report, with the steps of its final attempt."""
    cases, budget = [], [MAX_STEPS]

    def walk(suite, path):
        for spec in suite.get("specs", []):
            for test in spec.get("tests", []):
                results = [r for r in test.get("results") or [] if isinstance(r, dict)]
                final = results[-1] if results else {}
                status = test_outcome(test)
                row = {"title": _text(spec.get("title")), "path": path, "file": _text(spec.get("file") or suite.get("file")),
                       "line": spec.get("line") if isinstance(spec.get("line"), int) else None,
                       "project": _text(test.get("projectName"), 100), "status": status,
                       "duration_ms": _ms(final.get("duration")), "attempts": len(results),
                       "steps": _steps(final.get("steps"), 1, budget)}
                # A failure explains itself; a retried pass keeps the failure it recovered from.
                failing = [r for r in results if r.get("status") in ("failed", "timedOut", "interrupted")]
                error = error_summary(failing[-1].get("errors") or failing[-1].get("error")) if failing and status in ("failed", "flaky") else None
                if error:
                    row["error"] = error
                if attachment_html:
                    # Match the final attempt, just like the displayed steps. Never
                    # substitute a retry's earlier report or the slice's index.html.
                    for attachment in final.get("attachments") or []:
                        html_path = attachment_html(attachment)
                        if html_path:
                            row["html"] = html_path
                            break
                cases.append(row)
        for child in suite.get("suites", []):
            walk(child, path + [_text(child.get("title"))])

    for suite in doc.get("suites", []):
        # Top-level suites are files; nested ones are describe blocks.
        walk(suite, [])
    return cases


def _slice(prefix):
    parts = [p for p in prefix.split("/") if p and p not in ("e2e", "test-results", "playwright-report")]
    name = "-".join(parts) or "e2e"
    return name if SLICE.fullmatch(name) else "report"


def _safe_report_path(name):
    """Keep relative Unicode paths verbatim, without traversal or invalid text."""
    return not PureWindowsPath(name).is_absolute() and all(
        1 <= len(part) <= 128 and part not in (".", "..") and not UNSAFE_PATH_CHAR.search(part)
        for part in name.split("/"))


def _attachment_key(path):
    """Locate a ZIP member from Playwright's possibly absolute CI attachment path.

    Only the known report/output subtree is used for lookup, never filesystem IO
    or publication. The emitted link is separately validated against report files.
    """
    if not isinstance(path, str) or "\\" in path or any(part in (".", "..") for part in path.split("/")):
        return None
    if re.search(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]", path):
        return None
    for marker in ("journey-reports/", "test-results/", "playwright-report/"):
        offset = ("/" + path).find("/" + marker)
        if offset >= 0:
            key = path[offset:]
            return key if _safe_report_path(key) else None
    return None


def _case_html_resolver(archive, report, attachments):
    # Use original bytes: journey links are rewritten only after the match.
    by_content = {}
    for rel, item in sorted(report.items()):
        if rel.startswith("data/") and rel.endswith(".html") and _safe_report_path(rel):
            by_content.setdefault(archive.read(item), rel)

    def resolve(attachment):
        if not isinstance(attachment, dict) or str(attachment.get("contentType", "")).split(";")[0] != "text/html":
            return None
        item = attachments.get(_attachment_key(attachment.get("path")))
        if item is not None and item.file_size <= REPORT_BYTES:
            return by_content.get(archive.read(item))
        body = attachment.get("body")
        if isinstance(body, str) and len(body) <= REPORT_BYTES * 4 // 3 + 4:
            try:
                return by_content.get(base64.b64decode(body, validate=True))
            except (ValueError, binascii.Error):
                pass
        return None

    return resolve


class _JourneyLinks(HTMLParser):
    """Rebase actual src/href attributes without serializing scripts or other markup."""

    def __init__(self, source, prefix):
        super().__init__(convert_charrefs=False)
        self.source, self.prefix, self.edits = source, prefix, []
        self.lines = [0] + [m.end() for m in re.finditer("\n", source)]

    def handle_starttag(self, tag, attrs):
        line, column = self.getpos()
        offset = self.lines[line - 1] + column
        for attr in HTML_ATTR.finditer(self.get_starttag_text()):
            if attr[1].lower() not in ("src", "href"):
                continue
            group = next(i for i in (2, 3, 4) if attr[i] is not None)
            value = unescape(attr[group]).strip()
            if not value or value.startswith(("/", "\\", "#", "?")) or re.match(r"[A-Za-z][A-Za-z0-9+.-]*:", value):
                continue
            value = escape(self.prefix + value, quote=True)
            if group == 4:  # the new directory name may contain spaces
                value = '"' + value + '"'
            self.edits.append((offset + attr.start(group), offset + attr.end(group), value))

    def rewrite(self):
        self.feed(self.source)
        self.close()
        result = self.source
        for start, end, value in reversed(self.edits):
            result = result[:start] + value + result[end:]
        return result.encode("utf-8")


def _include_journeys(archive, report, journeys):
    """Match attached HTML by its bytes and retain only the matching journey directories."""
    by_content = {}
    for rel, item in sorted(journeys.items()):
        if rel.endswith("/report.html") and item.file_size <= REPORT_BYTES:
            by_content.setdefault(archive.read(item), posixpath.dirname(rel))
    selected, rewritten = set(), {}
    for rel, item in report.items():
        if not rel.startswith("data/") or not rel.endswith(".html") or item.file_size > REPORT_BYTES:
            continue
        content = archive.read(item)
        directory = by_content.get(content)
        if directory is None:
            continue
        prefix = quote(posixpath.relpath(directory, posixpath.dirname(rel)) + "/", safe="/")
        rewritten[rel] = _JourneyLinks(content.decode("utf-8"), prefix).rewrite()
        selected.add(directory)
    files = {**report, **{rel: item for rel, item in journeys.items()
                         if any(rel.startswith(directory + "/") for directory in selected)}}
    return files, rewritten


def read_artifact(blob, *, html=True, room=SITE_BYTES):
    """Cases and steps of each slice, and the report files that fit the budgets.

    Returns (slices, files): files maps slice -> {relative path: bytes} for the
    reports kept; each slice's report entry says why HTML was left out."""
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        entries = [e for e in archive.infolist() if not e.is_dir()]
        if len(entries) > 3000 or sum(e.file_size for e in entries) > 160 * 1024 * 1024:
            raise ValueError("report archive exceeds extraction budget")
        docs, reports, journeys, attachments = {}, {}, {}, {}
        for item in entries:
            # ZipInfo.filename can truncate NULs; validate before any normalization.
            name = item.orig_filename
            if not _safe_report_path(name):
                continue
            attachment_key = _attachment_key(name)
            if attachment_key and name.endswith(".html"):
                prefix = name[:-len(attachment_key)]
                attachments.setdefault(_slice(prefix), {})[attachment_key] = item
            marker = ("/" + name).find("/playwright-report/")
            if marker >= 0:
                rel = name[marker + len("playwright-report/"):]
                reports.setdefault(_slice(name[:marker]), {})[rel] = item
            elif (marker := ("/" + name).find("/journey-reports/")) >= 0:
                # Mount beside data/, keeping spec/case directories and filenames intact.
                rel = name[marker:]
                journeys.setdefault(_slice(name[:marker]), {})[rel] = item
            elif name.lower().endswith(("results.json", "report.json")) and item.file_size <= 40 * 1024 * 1024:
                key = _slice(name.rsplit("/", 1)[0] if "/" in name else "")
                if key in docs:
                    continue
                try:
                    doc = json.loads(archive.read(item).decode("utf-8", "replace"))
                except ValueError:
                    continue
                # Harness copies without suites (tagged summaries) are not Playwright reports.
                if isinstance(doc, dict) and isinstance(doc.get("suites"), list):
                    docs[key] = doc
        slices, files = [], {}
        for key in sorted(set(docs) | set(reports)):
            report = reports.get(key, {})
            rewritten = {}
            if html:
                report, rewritten = _include_journeys(archive, report, journeys.get(key, {}))
            size = sum(len(rewritten[rel]) if rel in rewritten else item.file_size for rel, item in report.items())
            entry = {"slice": key, "report": {"files": len(report), "bytes": size, "html": None, "reason": None}}
            safe = {rel: item for rel, item in report.items() if _safe_report_path(rel)}
            if not report:
                entry["report"]["reason"] = "missing"
            elif not html:
                entry["report"]["reason"] = "untrusted"
            elif "index.html" not in safe:
                entry["report"]["reason"] = "missing"
            elif size > REPORT_BYTES:
                entry["report"]["reason"] = "over_budget"
            elif size > room:
                entry["report"]["reason"] = "site_budget"
            else:
                room -= size
                files[key] = {rel: rewritten[rel] if rel in rewritten else archive.read(item) for rel, item in safe.items()}
            resolver = _case_html_resolver(archive, safe, attachments.get(key, {})) if key in files else None
            cases = playwright_cases(docs[key], resolver) if key in docs else []
            entry.update(cases=cases, totals=totals(cases) if key in docs else None)
            slices.append(entry)
    return slices, files


def window_runs(snapshot):
    """Runs the published board shows: CI lanes of every line and the recent runs."""
    runs = {}

    def lanes(section):
        for lane in (((section or {}).get("data") or {}).get("lanes") or {}).get("lanes", []):
            for day in lane.get("days", []):
                for cell in day or []:
                    if isinstance(cell, dict) and isinstance(cell.get("id"), int):
                        runs.setdefault(cell["id"], cell)

    lanes((snapshot.get("sections") or {}).get("ci"))
    for view in (snapshot.get("line_sections") or {}).values():
        lanes((view or {}).get("ci"))
    for row in (snapshot.get("quality") or {}).get("runs", []):
        if isinstance(row, dict) and isinstance(row.get("id"), int):
            runs.setdefault(row["id"], row)
    return runs


def _meta(artifact, run, repo):
    source = artifact.get("workflow_run") or {}
    run_id = source.get("id")
    return {"artifact_id": artifact["id"], "run_id": run_id, "branch": run.get("branch") or source.get("head_branch"),
            "sha": source.get("head_sha") or run.get("sha"), "event": run.get("event"), "title": run.get("title"),
            "created_at": artifact.get("created_at"), "expires_at": artifact.get("expires_at"),
            "run_url": f"https://github.com/{repo}/actions/runs/{run_id}",
            "artifact_url": f"https://github.com/{repo}/actions/runs/{run_id}/artifacts/{artifact['id']}",
            # Fork pull requests upload artifacts too; their HTML is never served from the board.
            "trusted": bool(source.get("repository_id")) and source.get("head_repository_id") == source.get("repository_id")}


class Records:
    """Result of one replacement: repository files, new HTML and a public summary."""

    def __init__(self):
        self.files, self.html, self.expires, self.summary = {}, {}, {}, {}

    def write_bundle(self, directory):
        """Hand new reports to the workflow; bundle.json names their expiry."""
        directory = Path(directory)
        shutil.rmtree(directory, ignore_errors=True)
        if not self.html:
            return
        for (artifact_id, key), files in self.html.items():
            for rel, data in files.items():
                target = directory / str(artifact_id) / key / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        (directory / "bundle.json").write_text(json.dumps({"expires_at": sorted(set(self.expires.values()))}))

    def write_preview(self, site):
        """Local output: steps, index and HTML side by side, as Pages serves them."""
        site = Path(site)
        for path, content in self.files.items():
            target = site / path.removeprefix("site/")
            if content is None:
                target.unlink(missing_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
        for (artifact_id, key), files in self.html.items():
            for rel, data in files.items():
                target = site / "e2e" / str(artifact_id) / key / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)


def refresh(gh, repo, root, snapshot, now, *, bundle=None, downloads=MAX_DOWNLOADS, max_bytes=ARTIFACT_BYTES):
    """Replace the record set for this collection. GitHub and artifact failures
    keep previously ready records; new records degrade without failing collection."""
    from .sync import BudgetExhausted

    root, out = Path(root), Records()
    max_bytes = min(max_bytes, ARTIFACT_BYTES)
    previous = read_json(root / INDEX, {}) or {}
    old = {r["artifact_id"]: r for r in previous.get("records", []) if isinstance(r, dict) and isinstance(r.get("artifact_id"), int)}
    window = window_runs(snapshot)
    listing = "ok"
    try:
        # One page, newest first, and no stored position: older history is never walked.
        rows = gh.get(f"/repos/{repo}/actions/artifacts", {"name": ARTIFACT, "per_page": 100})["artifacts"]
    except (GitHubError, BudgetExhausted, KeyError, TypeError) as err:
        listing = getattr(err, "kind", type(err).__name__)
        # Without a listing only the stored expiry can retire records.
        rows = [{"id": r["artifact_id"], "name": ARTIFACT, "expires_at": r.get("expires_at"), "created_at": r.get("created_at"),
                 "workflow_run": {"id": r.get("run_id")}, "stored": r} for r in old.values()]
    candidates = [a for a in rows if isinstance(a, dict) and isinstance(a.get("id"), int) and a.get("name") == ARTIFACT
                  and not a.get("expired") and _time(a.get("expires_at")) > now and (a.get("workflow_run") or {}).get("id") in window]
    candidates = sorted(candidates, key=lambda a: (a.get("created_at") or "", a["id"]), reverse=True)[:MAX_RECORDS]
    kept = {a["id"] for a in candidates}
    room = SITE_BYTES - sum(rep.get("bytes") or 0 for aid, r in old.items() if aid in kept for rep in r.get("reports", []) if rep.get("html"))
    records, fetched, downloaded = [], 0, 0
    for artifact in candidates:
        prior = old.get(artifact["id"])
        if artifact.get("stored") or (prior and prior.get("version") == VERSION and prior.get("status") in ("ready", "unreadable", "empty", "too_large")):
            if prior:
                records.append({**prior, "expires_at": artifact.get("expires_at") or prior.get("expires_at")})
            continue
        record = {**_meta(artifact, window[artifact["workflow_run"]["id"]], repo), "version": VERSION, "status": "pending",
                  "totals": None, "steps": None, "bundle": None, "reports": []}
        # Replace only after a usable record is built. Preserve the old version
        # and bundle even for records waiting behind this collection's two slots.
        records.append({**prior, "expires_at": artifact.get("expires_at") or prior.get("expires_at")}
                       if prior and prior.get("status") == "ready" else record)
        if (artifact.get("size_in_bytes") or 0) > max_bytes:
            record["status"] = "too_large"
            continue
        if fetched >= downloads:
            continue  # the next collection downloads it
        fetched += 1
        try:
            blob = gh.download_artifact(repo, artifact["id"], max_bytes=max_bytes)
        except (GitHubError, BudgetExhausted):
            continue
        downloaded += 1
        prior_bytes = sum(rep.get("bytes") or 0 for rep in (prior or {}).get("reports", []) if rep.get("html"))
        try:
            slices, html = read_artifact(blob, html=record["trusted"], room=room + prior_bytes)
        except (ValueError, zipfile.BadZipFile, OSError):
            record["status"] = "unreadable"
            continue
        if not any(s["totals"] for s in slices):
            record["status"] = "empty"
            continue
        records[-1] = record
        room += prior_bytes  # release the space reserved for the replaced HTML
        record["status"] = "ready"
        record["totals"] = {k: sum((s["totals"] or {}).get(k, 0) for s in slices) for k in ("tests", *FIELDS)}
        record["steps"] = f"data/e2e/{artifact['id']}.json"
        for s in slices:
            report = s["report"]
            if s["slice"] in html:
                report["html"] = f"e2e/{artifact['id']}/{s['slice']}/index.html"
                room -= report["bytes"]
                out.html[(artifact["id"], s["slice"])] = html[s["slice"]]
                out.expires[artifact["id"]] = artifact.get("expires_at")
            record["reports"].append({"slice": s["slice"], "totals": s["totals"], **report})
        if html:
            record["bundle"] = bundle
        # Cases beyond the cap still count; only their details are omitted.
        shown, detail = MAX_CASES, []
        for s in slices:
            detail.append({"slice": s["slice"], "totals": s["totals"], "cases": s["cases"][:max(shown, 0)],
                           "truncated": len(s["cases"]) > max(shown, 0)})
            shown -= len(s["cases"])
        out.files["site/" + record["steps"]] = encode({"artifact_id": artifact["id"], "run_id": record["run_id"], "slices": detail})
    ids = {r["artifact_id"] for r in records}
    # Bounded replacement: steps of records that left the set are deleted, with any stray file.
    for aid, r in old.items():
        if aid not in ids and r.get("steps"):
            out.files["site/" + r["steps"]] = None
    folder = root / "site/data/e2e"
    for path in folder.glob("*.json") if folder.is_dir() else []:
        rel = f"site/data/e2e/{path.name}"
        if path.name != "index.json" and rel not in out.files and not any(r.get("steps") == rel[5:] for r in records):
            out.files[rel] = None
    index = {"version": VERSION, "artifact": ARTIFACT, "records": records,
             "limits": {"records": MAX_RECORDS, "downloads": downloads, "report_bytes": REPORT_BYTES, "site_bytes": SITE_BYTES}}
    out.files[INDEX] = encode(index)
    out.summary = {"listing": listing, "records": len(records), "downloaded": downloaded, "attempted": fetched,
                   "retained": sum(r.get("status") == "ready" and r.get("version") != VERSION for r in records),
                   "pending": sum(r["status"] == "pending" for r in records),
                   "html": sum(1 for r in records for rep in r.get("reports", []) if rep.get("html"))}
    return out


def retention_days(directory, now):
    """Days an HTML bundle must outlive its collection: until its last source artifact expires."""
    doc = read_json(Path(directory) / "bundle.json", None)
    if not doc or not doc.get("expires_at"):
        return None
    last = max(_time(value) for value in doc["expires_at"])
    return max(1, min(90, math.ceil((last - now).total_seconds() / 86400) + 1))


def attach(gh, repository, site, now, *, wait=300, sleep=time.sleep, clock=time.monotonic):
    """Put the unexpired HTML reports into a Pages site before it is uploaded.

    Reports come from the collect runs named in the committed index. A report
    that cannot be fetched is marked unavailable, so the page links to GitHub;
    the deployment itself never fails here."""
    site = Path(site)
    path = site / "data/e2e/index.json"
    doc = read_json(path, None)
    if not isinstance(doc, dict):
        return {"records": 0, "attached": 0}
    records = [r for r in doc.get("records", []) if isinstance(r, dict) and _time(r.get("expires_at")) > now]
    for r in doc.get("records", []):
        if r not in records and isinstance(r, dict) and re.fullmatch(r"data/e2e/[0-9]{1,20}\.json", str(r.get("steps"))):
            (site / r["steps"]).unlink(missing_ok=True)
    shutil.rmtree(site / "e2e", ignore_errors=True)
    wanted = {}
    for r in records:
        for report in r.get("reports", []):
            if report.get("html") and isinstance(r.get("bundle"), int) and isinstance(r.get("artifact_id"), int):
                wanted.setdefault(r["bundle"], set()).add((r["artifact_id"], report["slice"]))
    found, errors, deadline = set(), [], clock() + wait
    for run_id in sorted(wanted, reverse=True)[:MAX_RECORDS]:
        try:
            found |= _fetch_bundle(gh, repository, run_id, wanted[run_id], site, deadline, sleep, clock)
        except (GitHubError, ValueError, KeyError, TypeError, zipfile.BadZipFile, OSError) as err:
            errors.append(getattr(err, "kind", type(err).__name__))
    for r in records:
        for report in r.get("reports", []):
            if report.get("html") and (r.get("artifact_id"), report.get("slice")) not in found:
                report.update(html=None, reason="unavailable")
    doc["records"] = records
    path.write_text(encode(doc), encoding="utf-8")
    return {"records": len(records), "attached": len(found), "errors": errors}


def withdraw(site):
    """Link every report to GitHub when attaching failed half way."""
    site = Path(site)
    path = site / "data/e2e/index.json"
    shutil.rmtree(site / "e2e", ignore_errors=True)
    doc = read_json(path, None)
    if isinstance(doc, dict):
        for record in doc.get("records", []):
            for report in record.get("reports", []):
                if report.get("html"):
                    report.update(html=None, reason="unavailable")
        path.write_text(encode(doc), encoding="utf-8")


def _fetch_bundle(gh, repository, run_id, pairs, site, deadline, sleep, clock):
    base = f"/repos/{repository}/actions/runs/{run_id}"
    run = gh.get(base)
    # Only the collector's own runs on main may supply HTML; pull request checks cannot.
    if run.get("path") != BUNDLE_WORKFLOW or run.get("head_branch") != "main":
        raise ValueError("bundle run is not a collection on main")
    while True:
        artifact = next((a for a in gh.get(base + "/artifacts", {"name": BUNDLE, "per_page": 10}).get("artifacts", [])
                         if a.get("name") == BUNDLE and not a.get("expired")), None)
        # The collection commits before it uploads; wait for that same run to finish.
        if artifact or run.get("status") == "completed" or clock() >= deadline:
            break
        sleep(10)
        run = gh.get(base)
    if not artifact:
        return set()
    blob = gh.download_artifact(repository, artifact["id"], max_bytes=SITE_BYTES + 16 * 1024 * 1024)
    found, written = set(), 0
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        for item in archive.infolist():
            if not _safe_report_path(item.orig_filename):
                continue
            parts = item.orig_filename.split("/")
            if item.is_dir() or len(parts) < 3 or not parts[0].isdigit() or (int(parts[0]), parts[1]) not in pairs:
                continue
            written += item.file_size
            if written > SITE_BYTES:
                raise ValueError("bundle exceeds site budget")
            target = site.joinpath("e2e", *parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.read(item))
            if parts[2:] == ["index.html"]:
                found.add((int(parts[0]), parts[1]))
    return found
