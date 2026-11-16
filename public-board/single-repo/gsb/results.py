"""Structured results of scheduled CI runs (#938): what a run reports about itself, as named numbers.

Sources are tried in order, and the first that yields metrics is the run's result:

1. check run output: Markdown tables in the summary or text of the check runs in the run's check suite. A job's step
   summary ($GITHUB_STEP_SUMMARY) is not one of them: GitHub's API does not return it, and the job's own check run
   has no output.
2. artifacts: JUnit XML files (a testsuites or testsuite root) and simple JSON files
   ({"metrics": [{"name": "tests", "value": 120, "unit": "count"}, ...]}) inside small artifacts of the run.
3. otherwise the run's jobs, which the board always has, are its only data: their conclusions and durations.

Parsing is deterministic and names no repository, workflow or artifact: table columns, JUnit totals and JSON names
become the metrics. Nothing here scores a run.
"""
from __future__ import annotations

import io
import json
import re
import zipfile
from xml.etree import ElementTree

from .github import GitHubError

RESULTS_VERSION = 1
MAX_METRICS = 60
MAX_ARTIFACTS = 3                       # downloads per run
MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
MAX_FILE_BYTES = 5 * 1024 * 1024        # one XML or JSON file inside an artifact
MAX_FILES = 20

# A GFM table's delimiter row: cells of hyphens, each optionally starting or ending with a colon.
DELIMITER = re.compile(r"^\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$")
NUMBER = re.compile(r"^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$")


def _metric(name, value, unit=""):
    return {"name": re.sub(r"\s+", " ", str(name)).strip()[:80], "value": round(float(value), 4), "unit": str(unit or "")[:12]}


def _cell_text(cell):
    # Markdown emphasis, code and links are presentation; the text inside is the value.
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", cell)
    return re.sub(r"[`*_]", "", text).strip()


def _number(text):
    """A table cell as (value, unit), or None: 1,234 · 98.5% · 12.3s · 450 ms."""
    match = re.match(r"^(.*?)\s*(%|ms|s|sec|min)?$", text.strip(), re.I)
    raw, unit = (match.group(1), (match.group(2) or "").lower()) if match else (text, "")
    if not NUMBER.match(raw):
        return None
    unit = {"sec": "s"}.get(unit, unit)
    return float(raw.replace(",", "")), unit


def table_metrics(markdown):
    """Every numeric cell of the Markdown tables in a text. A table with one data row gives one metric per column
    (named by its header); with more rows, each is named "<first cell> · <header>"."""
    out = []
    lines = [line.strip() for line in str(markdown or "").splitlines()]
    i = 0
    while i < len(lines):
        if not (lines[i].startswith("|") and i + 1 < len(lines) and DELIMITER.match(lines[i + 1])):
            i += 1
            continue
        split = lambda line: [_cell_text(c) for c in line.strip().strip("|").split("|")]
        header, rows, i = split(lines[i]), [], i + 2
        while i < len(lines) and lines[i].startswith("|"):
            rows.append(split(lines[i]))
            i += 1
        for row in rows:
            for column, cell in enumerate(row):
                parsed = _number(cell) if column < len(header) else None
                if parsed is None or (len(rows) > 1 and column == 0):
                    continue
                label = header[column] or f"column {column + 1}"
                name = label if len(rows) == 1 else f"{row[0]} · {label}"
                out.append(_metric(name, parsed[0], parsed[1]))
    return out


def junit_metrics(data):
    """Totals of a JUnit XML document: tests, failures, errors, skipped and time (seconds)."""
    root = ElementTree.fromstring(data)
    if root.tag not in ("testsuites", "testsuite"):
        return []
    suites = [root] if root.tag == "testsuite" or root.get("tests") is not None else root.findall("testsuite")
    totals = {"tests": 0.0, "failures": 0.0, "errors": 0.0, "skipped": 0.0, "time": 0.0}
    for suite in suites:
        for key in totals:
            try:
                totals[key] += float(suite.get(key) or 0)
            except ValueError:
                pass
    return [_metric(key, value, "s" if key == "time" else "count") for key, value in totals.items()]


def json_metrics(data):
    """The simple JSON format: {"metrics": [{"name": str, "value": number, "unit": str?}]}."""
    doc = json.loads(data)
    items = doc.get("metrics") if isinstance(doc, dict) else None
    if not isinstance(items, list):
        return []
    return [_metric(item["name"], item["value"], item.get("unit", "")) for item in items
            if isinstance(item, dict) and isinstance(item.get("name"), str) and item["name"].strip()
            and isinstance(item.get("value"), (int, float)) and not isinstance(item.get("value"), bool)]


def _prefixed(groups):
    """Metrics of several files: each name gets its file's stem, so two files' "tests" stay apart."""
    if len(groups) == 1:
        return groups[0][1]
    return [{**m, "name": f"{stem} · {m['name']}"[:80]} for stem, metrics in groups for m in metrics]


def artifact_metrics(blob):
    junit, simple = [], []
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        entries = sorted((e for e in archive.infolist() if not e.is_dir() and e.file_size <= MAX_FILE_BYTES
                          and e.filename.lower().endswith((".xml", ".json"))), key=lambda e: e.filename)[:MAX_FILES]
        for entry in entries:
            stem = re.sub(r"\.(xml|json)$", "", entry.filename.rsplit("/", 1)[-1], flags=re.I)
            try:
                data = archive.read(entry)
                metrics = junit_metrics(data) if entry.filename.lower().endswith(".xml") else json_metrics(data)
            except (ElementTree.ParseError, ValueError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError):
                continue
            if metrics:
                (junit if entry.filename.lower().endswith(".xml") else simple).append((stem, metrics))
    return _prefixed(junit + simple) if junit or simple else []


def extract(gh, repo, run):
    """The run's structured result: {"source", "metrics", "version"}. GitHub errors are raised to the caller."""
    metrics = []
    if run.get("check_suite_id"):
        try:
            runs = gh.paginate(f"/repos/{repo}/check-suites/{run['check_suite_id']}/check-runs", {"per_page": 100},
                               key="check_runs", max_pages=1)
        except GitHubError as error:
            # An installation without Checks read, or a suite GitHub no longer has: the artifacts may still tell.
            if error.kind not in ("forbidden", "not_found"):
                raise
            runs = []
        for check in sorted(runs, key=lambda c: (c.get("name") or "", c.get("id") or 0)):
            output = check.get("output") or {}
            metrics += table_metrics(output.get("summary")) + table_metrics(output.get("text"))
        if metrics:
            return {"source": "check_run", "metrics": metrics[:MAX_METRICS], "version": RESULTS_VERSION}
    artifacts = gh.paginate(f"/repos/{repo}/actions/runs/{run['id']}/artifacts", key="artifacts", max_pages=1)
    readable = sorted((a for a in artifacts if not a.get("expired") and 0 < (a.get("size_in_bytes") or 0) <= MAX_ARTIFACT_BYTES),
                      key=lambda a: a.get("name") or "")[:MAX_ARTIFACTS]
    groups = []
    for artifact in readable:
        try:
            found = artifact_metrics(gh.download_artifact(repo, artifact["id"], max_bytes=MAX_ARTIFACT_BYTES))
        except (zipfile.BadZipFile, ValueError):
            continue
        if found:
            groups.append((artifact.get("name") or str(artifact["id"]), found))
    if groups:
        return {"source": "artifact", "metrics": _prefixed(groups)[:MAX_METRICS], "version": RESULTS_VERSION}
    return {"source": "jobs", "metrics": [], "version": RESULTS_VERSION}
