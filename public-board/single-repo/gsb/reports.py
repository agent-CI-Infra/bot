"""Public test summaries: parse structured reports without publishing logs or traces."""
from __future__ import annotations

import io
import json
import math
import re
import zipfile
from datetime import datetime
from html.parser import HTMLParser
from xml.etree import ElementTree as ET

from .tagged import extract as extract_tagged
from .testparse import parse_run_log, COVERAGE_FILE_RE, parse_coverage_file
from .real_e2e_definitions import combine

FIELDS = ("passed", "failed", "skipped", "flaky")
SCORE_FILE_RE = re.compile(r"(?:^|/)(benchmark-metrics|team-metrics|evolve-metrics)\.json$", re.I)
JOURNEY_CASE_RE = re.compile(r"\b(?:DRB-[0-9]+|BiomniBench-[A-Za-z0-9-]+|TC-E2E-01|PUCT-COMPRESS)\b")


def _short(value, limit=300):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


class _JourneySummary(HTMLParser):
    """Read only the report header, scenario, steps and declared metadata."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.section = None
        self.capture = None
        self.parts = []
        self.row = None
        self.title = ""
        self.goal = ""
        self.preconditions = []
        self.step_summary = ""
        self.steps = []
        self.metadata = {}

    def handle_starttag(self, tag, attrs):
        if tag in ("h1", "h2") or tag in ("p", "li") and self.section in ("场景目标", "前置条件", "步骤总览"):
            self.capture, self.parts = tag, []
        elif tag == "tr":
            self.row = []
        elif tag in ("th", "td") and self.row is not None:
            self.capture, self.parts = tag, []

    def handle_data(self, data):
        if self.capture:
            self.parts.append(data)

    def handle_endtag(self, tag):
        if tag == self.capture:
            value = _short("".join(self.parts), 400)
            if tag == "h1":
                self.title = value
            elif tag == "h2":
                self.section = value
            elif tag == "p" and self.section == "场景目标":
                self.goal = value
            elif tag == "p" and self.section == "步骤总览":
                self.step_summary = value
            elif tag == "li" and self.section == "前置条件" and len(self.preconditions) < 8:
                self.preconditions.append(value[:200])
            elif tag in ("th", "td") and self.row is not None:
                self.row.append(value)
            self.capture, self.parts = None, []
        if tag == "tr" and self.row:
            if self.section is None and self.row[0] == "用例" and len(self.row) > 1:
                self.title = self.row[1]
            elif self.section == "步骤总览" and self.row[0].isdigit() and len(self.row) >= 5 and len(self.steps) < 12:
                self.steps.append({"title": self.row[1][:160], "expected": self.row[2][:200],
                                   "result": self.row[3][:80], "duration": self.row[4][:40]})
            elif self.section and self.section.startswith("运行元数据") and len(self.row) > 1:
                names = {"类型": "type", "模型": "model", "凭据": "credentials", "成本与副作用": "cost_side_effects"}
                if self.row[0] in names and self.row[1] not in ("-", "—", ""):
                    self.metadata[names[self.row[0]]] = self.row[1][:300]
            self.row = None


def journey_summary(html):
    parser = _JourneySummary()
    parser.feed(html)
    case = JOURNEY_CASE_RE.search(parser.title)
    if not case:
        return None
    return case.group(0), {"source": "run-report", "goal": parser.goal[:300], "preconditions": parser.preconditions,
                           "step_summary": parser.step_summary[:300], "steps": parser.steps,
                           "metadata": parser.metadata}


def _number(value):
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else None


def _status(value, fallback="unknown"):
    value = str(value or fallback).strip().lower()
    return value[:40] if re.fullmatch(r"[a-z0-9_-]+", value) else fallback


def _duration_ms(doc):
    duration = _number(doc.get("generation_duration_ms"))
    if duration is not None and duration >= 0:
        return duration
    try:
        start = datetime.fromisoformat(str(doc["started_at"]).replace("Z", "+00:00"))
        finish = datetime.fromisoformat(str(doc["finished_at"]).replace("Z", "+00:00"))
        return max(0, (finish - start).total_seconds() * 1000)
    except (KeyError, TypeError, ValueError):
        return None


def _metric(label, value, unit, status=None):
    value = _number(value)
    if value is None and status is None:
        return None
    row = {"label": label[:60], "value": value, "unit": unit}
    if status is not None:
        row["status"] = _status(status, "unavailable")
    return row


def research_score(doc, source_path=""):
    """Return only public, bounded score fields from one real-E2E metrics document."""
    if not isinstance(doc, dict):
        return None
    evaluation = doc.get("evaluation") if isinstance(doc.get("evaluation"), dict) else {}
    metrics = []
    case = doc.get("case")
    family = None
    delivery = doc.get("integration_status") or doc.get("integration")
    failed = _status(delivery) == "failed"
    fallback_status = evaluation.get("status") or ("failed" if failed else None)

    if case == "TC-E2E-01":
        family = "research-team"
        metrics.append(_metric("Judge total", evaluation.get("total_score"), "score100", fallback_status))
    elif case == "PUCT-COMPRESS":
        family = "evolve-compression"
        metrics.extend([
            _metric("Held-out test", evaluation.get("score"), "ratio", fallback_status),
            _metric("Baseline gate", evaluation.get("baseline_gate_score"), "ratio"),
            _metric("Best gate", evaluation.get("best_gate_score"), "ratio"),
        ])
        llm = doc.get("llm_evaluation")
        if isinstance(llm, dict):
            metrics.append(_metric("LLM judge", llm.get("total_score"), "score100", llm.get("status")))
    elif "case_id" in doc and ("race" in evaluation or "fact" in evaluation or "deepresearchbench" in source_path.lower()):
        family = "deepresearchbench"
        case = f"DRB-{str(doc.get('case_id'))[:80]}"
        race = evaluation.get("race") if isinstance(evaluation.get("race"), dict) else {}
        fact = evaluation.get("fact") if isinstance(evaluation.get("fact"), dict) else {}
        metrics.extend([
            _metric("RACE", race.get("overall_score"), "ratio", race.get("status") or fallback_status),
            _metric("Citation accuracy", fact.get("citation_accuracy"), "percent", fact.get("status") or fallback_status),
            _metric("Verification coverage", fact.get("verification_coverage"), "percent", fact.get("status") or fallback_status),
            _metric("Effective citations", fact.get("effective_citations"), "count"),
        ])
    elif "case_id" in doc and ("score" in evaluation or "biomnibench" in source_path.lower()):
        family = "biomnibench"
        case = f"BiomniBench-{str(doc.get('case_id'))[:80]}"
        metrics.append(_metric("Rubric", evaluation.get("score"), "score100", fallback_status))
    if not family or not isinstance(case, str) or not case.strip():
        return None
    metrics = [metric for metric in metrics if metric is not None]
    result = {"case": case.strip()[:100], "family": family, "delivery": _status(delivery),
            "quality_status": _status(evaluation.get("status"), "not_scored"),
            "duration_ms": _duration_ms(doc), "metrics": metrics}
    model = doc.get("generator_model")
    if isinstance(model, str) and model.strip():
        result["model"] = _short(model, 120)
    return result


def totals(cases):
    out = {key: sum(c["status"] == key for c in cases) for key in FIELDS}
    return {"tests": len(cases), **out}


def test_outcome(test):
    """One Playwright test's final outcome: passed, failed, skipped or flaky."""
    states = [r.get("status") for r in test.get("results", [])]
    status = test.get("status")
    # Playwright's outcome accounts for expected failures and retries.
    if status in ("expected", "unexpected", "flaky", "skipped"):
        return {"expected": "passed", "unexpected": "failed"}.get(status, status)
    if not states or states[-1] == "skipped":
        return "skipped"
    if states[-1] == "passed":
        return "flaky" if any(s in ("failed", "timedOut") for s in states[:-1]) else "passed"
    return "failed"


def playwright(doc):
    cases = []

    def walk(suite):
        for spec in suite.get("specs", []):
            for test in spec.get("tests", []):
                cases.append({"name": str(spec.get("title", ""))[:300], "file": str(spec.get("file", suite.get("file", "")))[:300],
                              "project": str(test.get("projectName", ""))[:100], "status": test_outcome(test)})
        for child in suite.get("suites", []):
            walk(child)

    for suite in doc.get("suites", []):
        walk(suite)
    if not cases:
        stats = doc.get("stats", {})
        if not all(isinstance(stats.get(k), int) and stats[k] >= 0 for k in ("expected", "unexpected", "skipped", "flaky")):
            return None
        counts = dict(zip(FIELDS, (stats[k] for k in ("expected", "unexpected", "skipped", "flaky"))))
        return {"tests": sum(counts.values()), **counts, "cases": [], "format": "playwright"}
    return {**totals(cases), "cases": cases[:500], "format": "playwright"}


def junit(text):
    root = ET.fromstring(text)
    cases = []
    for item in root.iter("testcase"):
        status = ("skipped" if item.find("skipped") is not None else
                  "failed" if item.find("failure") is not None or item.find("error") is not None else
                  "flaky" if item.find("flakyFailure") is not None or item.find("flakyError") is not None else "passed")
        cases.append({"name": str(item.get("name", ""))[:300], "file": str(item.get("file") or item.get("classname", ""))[:300], "status": status})
    if cases:
        return {**totals(cases), "cases": cases[:500], "format": "junit"}
    # Count leaf suites only: parent aggregates must not double-count children.
    counts = {key: 0 for key in ("tests", *FIELDS)}
    suites = [s for s in root.iter("testsuite") if not list(s.iter("testsuite"))[1:]]
    for suite in suites:
        n = int(suite.get("tests", 0))
        failed = int(suite.get("failures", 0)) + int(suite.get("errors", 0))
        skipped = int(suite.get("skipped", 0))
        if min(n, failed, skipped) < 0 or failed + skipped > n:
            raise ValueError("inconsistent JUnit counts")
        counts["tests"] += n
        counts["failed"] += failed
        counts["skipped"] += skipped
        counts["passed"] += n - failed - skipped
    return {**counts, "cases": [], "format": "junit"} if suites else None


def artifact_layer(name):
    name = name.lower()
    if re.search(r"e2e|playwright|end.to.end", name):
        return "e2e"
    if re.search(r"(^|[-_])(st|integration|system)([-_]|$)", name):
        return "st"
    if re.search(r"(^|[-_])(ut|unit)([-_]|$)", name):
        return "unit"
    return "other"


def parse_report_zip(blob):
    """Choose one report family per artifact, avoiding JSON/XML/log double counts."""
    with zipfile.ZipFile(io.BytesIO(blob)) as archive:
        entries = archive.infolist()
        if len(entries) > 3000 or sum(e.file_size for e in entries) > 160 * 1024 * 1024:
            raise ValueError("report archive exceeds extraction budget")
        reports = {"playwright": [], "tagged": [], "junit": [], "summary": [], "log": []}
        coverage, scores, journeys = [], [], {}
        for item in entries:
            name = item.filename.lower()
            if item.is_dir() or item.file_size > 20 * 1024 * 1024:
                continue
            if "/journey-reports/" in "/" + name and name.endswith("/report.html") and item.file_size <= 256 * 1024:
                try:
                    summary = journey_summary(archive.read(item).decode("utf-8", "replace"))
                    if summary:
                        journeys[summary[0]] = summary[1]
                except (ValueError, TypeError):
                    pass
                continue
            if not (name.endswith(("results.json", "report.json", ".xml", "run.log", "dashboard-summary.json")) or COVERAGE_FILE_RE.search(name) or SCORE_FILE_RE.search(name)):
                continue
            text = archive.read(item).decode("utf-8", "replace")
            try:
                if SCORE_FILE_RE.search(name):
                    score = research_score(json.loads(text), item.filename)
                    if score:
                        scores.append(score)
                    continue
                if COVERAGE_FILE_RE.search(name):
                    cov = parse_coverage_file(name, text.encode())
                    if cov and isinstance(cov.get("lines_pct"), (int, float)) and 0 <= cov["lines_pct"] <= 100:
                        coverage.append({"file": item.filename.replace("\\", "/").rsplit("/", 1)[-1], **cov})
                    continue
                result = None
                family = ""
                if name.endswith(".json"):
                    doc = json.loads(text)
                    if isinstance(doc, dict) and "suites" in doc:
                        result, family = playwright(doc), "playwright"
                    elif name.endswith("dashboard-summary.json"):
                        counts = {k: doc.get(k) for k in ("tests", *FIELDS)}
                        if not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in counts.values()):
                            raise ValueError("invalid counts")
                        if counts["tests"] != sum(counts[k] for k in FIELDS):
                            raise ValueError("inconsistent counts")
                        result, family = {**counts, "cases": [], "format": "summary"}, "summary"
                elif name.endswith(".xml"):
                    result, family = junit(text), "junit"
                elif name.endswith("run.log"):
                    parsed = parse_run_log(text)
                    if parsed['totals'].get('tests'):
                        # Retain numeric breakdowns, never command lines or raw output.
                        keys = ('tests', 'passed', 'failed', 'skipped', 'framework')
                        commands = [{**{k: c.get(k) for k in keys}, 'label': f'命令 {i+1}'} for i, c in enumerate(parsed['commands'])]
                        packages = [{**{k: c.get(k) for k in keys}, 'package': c['package']} for c in parsed['packages']]
                        result, family = {**parsed['totals'], "flaky": 0, "cases": [], "format": "log", 'commands': commands, 'packages': packages}, "log"
                if result:
                    reports[family].append(result)
            except (ValueError, TypeError, AttributeError, ET.ParseError):
                continue
        # The tagged harness reconciles every planned case, so its summary is a
        # count source; a planned case without a pass or skip counts as failed.
        tagged = extract_tagged(archive)
        for part in tagged:
            result = part["result"] or {}
            planned, passed, skipped = result.get("planned"), result.get("passed"), result.get("skipped") or 0
            if planned is not None and passed is not None and passed + skipped <= planned:
                reports["tagged"].append({"tests": planned, "passed": passed, "failed": planned - passed - skipped,
                                          "skipped": skipped, "flaky": 0, "cases": []})
        for score in scores:
            details = combine(score["case"], score["family"], journeys.get(score["case"]))
            if details:
                score["journey"] = details
        for family in ("summary", "playwright", "tagged", "junit", "log"):
            if reports[family]:
                counts = {k: sum(r.get(k, 0) for r in reports[family]) for k in ("tests", *FIELDS)}
                return {**counts, "format": family, "cases": [c for r in reports[family] for c in r["cases"]][:500], "coverage": coverage, "tagged": tagged, "scores": scores[:100], **({k: [v for r in reports[family] for v in r[k]] for k in ("commands", "packages")} if family == "log" else {})}
        if coverage or tagged or scores:
            return {"tests": None, "coverage": coverage, "tagged": tagged, "scores": scores[:100]}
    return None
