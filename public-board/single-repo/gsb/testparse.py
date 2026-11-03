"""Parsers for the test side of the board.

Two independent sources are covered:

1. the repository tree, from which test files are classified into layers
   (unit / e2e / st / ci-self / tooling) and grouped by package;
2. CI artifacts, from which executed test-case counts are recovered. Supported
   formats: node ``--test`` TAP summaries (bare and pnpm-prefixed), Python
   ``unittest`` and ``pytest`` summaries, Playwright ``results.json``, JUnit XML,
   and the layer ``summary.json`` written by the CI scripts.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from collections import defaultdict
from xml.etree import ElementTree

# Bump when parser output changes so cached artifact parses are redone.
PARSER_VERSION = 5

# ---------------------------------------------------------------------- tree
TEST_FILE_RE = re.compile(
    r"(^|/)(test|tests|__tests__|e2e|spec|specs)(/|$)"
    r"|\.(test|spec)\.[cm]?[jt]sx?$"
    r"|(^|/)test_[^/]+\.py$|_test\.py$"
)
SOURCE_EXT = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".py"}
SKIP_DIRS = ("node_modules/", "dist/", "build/", ".venv/", "coverage/", "__pycache__/")
PACKAGE_ROOTS = ("packages", "services", "apps")
LAYER_ORDER = ["unit", "e2e", "st", "ci-self", "tooling", "other"]


def is_test_path(path: str) -> bool:
    if any(seg in path for seg in SKIP_DIRS):
        return False
    return bool(TEST_FILE_RE.search(path))


def language_of(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return {
        "ts": "TypeScript", "tsx": "TypeScript", "mts": "TypeScript", "cts": "TypeScript",
        "js": "JavaScript", "mjs": "JavaScript", "cjs": "JavaScript", "jsx": "JavaScript",
        "py": "Python", "sh": "Shell", "json": "JSON",
    }.get(ext, ext or "other")


def package_of(path: str) -> str:
    parts = path.split("/")
    if parts[0] in PACKAGE_ROOTS and len(parts) > 2:
        return "/".join(parts[:2])
    return parts[0] if len(parts) > 1 else "."


def layer_of(path: str) -> str:
    """Map a test file to a layer. Rules are ordered from most to least specific."""
    lower = path.lower()
    if lower.startswith(".ci/"):
        return "ci-self"
    if lower.startswith("scripts/"):
        return "tooling"
    if "/e2e/" in f"/{lower}" or ".e2e." in lower:
        return "e2e"
    if lower.startswith("test/api/") or "smoke" in lower:
        return "st"
    if lower.startswith("test/") and lower.endswith((".spec.ts", ".spec.js", ".spec.tsx")):
        return "e2e"  # Playwright specs live in the top-level test/ tree
    if lower.endswith((".test.ts", ".test.tsx", ".test.js", ".test.mjs", ".test.cjs", ".test.jsx")):
        return "unit"
    if re.search(r"(^|/)test_[^/]+\.py$|_test\.py$", lower):
        return "unit"
    if lower.startswith("test/") and lower.endswith((".ts", ".mjs", ".js", ".sh")):
        return "e2e"  # helpers/fixtures beside the specs
    if any(seg in lower for seg in ("/tests/", "/__tests__/", "/test/")):
        return "unit" if lower.endswith(tuple(SOURCE_EXT)) else "other"
    return "other"


def summarize_tree(paths: list[str]) -> dict:
    """Classify every blob path; return distribution by layer, language and package
    plus a per-package source/test file inventory used as the structural coverage proxy."""
    tests = []
    by_layer = defaultdict(int)
    by_language = defaultdict(int)
    by_package = defaultdict(lambda: {"files": 0, "layers": defaultdict(int)})
    inventory = defaultdict(lambda: {"source_files": 0, "test_files": 0, "layers": defaultdict(int)})

    for path in paths:
        if any(seg in path for seg in SKIP_DIRS):
            continue
        pkg = package_of(path)
        ext = "." + path.rsplit(".", 1)[-1] if "." in path.rsplit("/", 1)[-1] else ""
        if is_test_path(path):
            layer = layer_of(path)
            tests.append({"path": path, "layer": layer, "language": language_of(path), "package": pkg})
            by_layer[layer] += 1
            by_language[language_of(path)] += 1
            by_package[pkg]["files"] += 1
            by_package[pkg]["layers"][layer] += 1
            if path.split("/")[0] in PACKAGE_ROOTS:
                inventory[pkg]["test_files"] += 1
                inventory[pkg]["layers"][layer] += 1
        elif ext in SOURCE_EXT and path.split("/")[0] in PACKAGE_ROOTS and not path.endswith(".d.ts"):
            inventory[pkg]["source_files"] += 1

    packages = [
        {"package": k, "files": v["files"], "layers": dict(v["layers"])}
        for k, v in sorted(by_package.items(), key=lambda kv: -kv[1]["files"])
    ]
    inv = []
    for pkg, v in sorted(inventory.items()):
        src, tst = v["source_files"], v["test_files"]
        inv.append({
            "package": pkg, "source_files": src, "test_files": tst,
            "ratio": round(tst / src, 2) if src else None,
            "tested": tst > 0, "layers": dict(v["layers"]),
        })
    return {
        "total": len(tests),
        "by_layer": {k: by_layer.get(k, 0) for k in LAYER_ORDER if by_layer.get(k)},
        "by_language": dict(sorted(by_language.items(), key=lambda kv: -kv[1])),
        "by_package": packages,
        "inventory": inv,
        "files": tests,
    }


# ------------------------------------------------------------- CI run logs
CMD_RE = re.compile(r"^\$ (.+)$")
PKG_TAP_RE = re.compile(r"^(\S+) test: # (tests|suites|pass|fail|skipped|todo|cancelled) (\d+)$")
BARE_TAP_RE = re.compile(r"^# (tests|suites|pass|fail|skipped|todo|cancelled) (\d+)$")
UNITTEST_RAN_RE = re.compile(r"^Ran (\d+) tests? in ([\d.]+)s$")
UNITTEST_RESULT_RE = re.compile(r"^(OK|FAILED)(?: \((.*)\))?$")
PYTEST_RE = re.compile(r"^=+ (.*?) in ([\d.]+)s(?: \([^)]*\))? =+$")
PNPM_SCRIPT_RE = re.compile(r"^pnpm ([A-Za-z0-9:_-]+)$")
PNPM_FILTER_RE = re.compile(r"^pnpm --filter (\S+) ([A-Za-z0-9:_-]+)$")


def parse_run_log(text: str) -> dict:
    """Recover executed test counts from a CI ``run.log``.

    Returns ``{"commands": [...], "packages": [...], "totals": {...}}`` where every
    entry carries ``tests / passed / failed / skipped`` and a ``framework`` label.
    """
    commands: list[dict] = []
    packages: dict[str, dict] = {}
    current: dict | None = None
    pending_label: str | None = None
    pending_filter: str | None = None
    pending_unittest: dict | None = None

    def open_segment(command: str) -> dict:
        # pnpm prints `$ pnpm <script>` and then `$ <actual command>`; results appear under the
        # second line, so the script name (and any --filter package) is carried over to it.
        nonlocal pending_label, pending_filter
        seg = {"command": command, "label": None, "framework": None, "filter": None,
               "tests": 0, "passed": 0, "failed": 0, "skipped": 0, "seen": False}
        script = PNPM_SCRIPT_RE.match(command)
        filtered = PNPM_FILTER_RE.match(command)
        if script:
            pending_label, pending_filter = script.group(1), None
            seg["label"] = pending_label
        elif filtered:
            # `pnpm --filter @scope/name test` → label "name:test"; the filter lets the caller
            # map executed cases back to the workspace package.
            pending_label = f"{filtered.group(1).split('/')[-1]}:{filtered.group(2)}"
            pending_filter = filtered.group(1)
            seg["label"], seg["filter"] = pending_label, pending_filter
        else:
            seg["label"] = pending_label or command
            seg["filter"] = pending_filter
            pending_label, pending_filter = None, None
        commands.append(seg)
        return seg

    for raw in text.splitlines():
        line = raw.rstrip()
        m = CMD_RE.match(line)
        if m:
            current = open_segment(m.group(1))
            pending_unittest = None
            continue
        m = PKG_TAP_RE.match(line)
        if m:
            pkg, field, num = m.group(1), m.group(2), int(m.group(3))
            entry = packages.setdefault(pkg, {"package": pkg, "framework": "node:test",
                                              "tests": 0, "passed": 0, "failed": 0, "skipped": 0})
            _apply_tap(entry, field, num)
            continue
        m = BARE_TAP_RE.match(line)
        if m and current is not None:
            current["framework"] = current["framework"] or "node:test"
            current["seen"] = True
            _apply_tap(current, m.group(1), int(m.group(2)))
            continue
        m = UNITTEST_RAN_RE.match(line)
        if m and current is not None:
            pending_unittest = {"tests": int(m.group(1))}
            continue
        m = UNITTEST_RESULT_RE.match(line)
        if m and pending_unittest is not None and current is not None:
            detail = m.group(2) or ""
            failed = sum(int(x) for x in re.findall(r"(?:failures|errors)=(\d+)", detail))
            skipped = sum(int(x) for x in re.findall(r"skipped=(\d+)", detail))
            current["framework"] = "unittest"
            current["seen"] = True
            current["tests"] += pending_unittest["tests"]
            current["failed"] += failed
            current["skipped"] += skipped
            current["passed"] += pending_unittest["tests"] - failed - skipped
            pending_unittest = None
            continue
        m = PYTEST_RE.match(line)
        if m and current is not None:
            counts = {k: int(v) for v, k in re.findall(r"(\d+) (passed|failed|error|errors|skipped|xfailed|xpassed)", m.group(1))}
            current["framework"] = "pytest"
            current["seen"] = True
            current["passed"] += counts.get("passed", 0) + counts.get("xpassed", 0)
            current["failed"] += counts.get("failed", 0) + counts.get("error", 0) + counts.get("errors", 0)
            current["skipped"] += counts.get("skipped", 0) + counts.get("xfailed", 0)
            current["tests"] += sum(counts.values())
            continue

    commands = [c for c in commands if c.pop("seen", False)]
    pkg_list = sorted(packages.values(), key=lambda p: -p["tests"])
    # The pnpm recursive block reports per package; its parent command has no bare TAP block,
    # so package numbers and command numbers do not overlap and can simply be summed.
    totals = {"tests": 0, "passed": 0, "failed": 0, "skipped": 0}
    for entry in commands + pkg_list:
        for key in totals:
            totals[key] += entry[key]
    return {"commands": commands, "packages": pkg_list, "totals": totals}


def _apply_tap(entry: dict, field: str, num: int) -> None:
    if field == "tests":
        entry["tests"] += num
    elif field == "pass":
        entry["passed"] += num
    elif field in ("fail", "cancelled"):
        entry["failed"] += num
    elif field in ("skipped", "todo"):
        entry["skipped"] += num


# --------------------------------------------------------------- playwright
def parse_playwright_json(doc: dict) -> dict:
    stats = doc.get("stats", {}) or {}
    files: dict[str, dict] = {}
    failures: list[dict] = []

    def walk(suite: dict, file_hint: str | None):
        file = suite.get("file") or file_hint
        for spec in suite.get("specs", []) or []:
            spec_file = spec.get("file") or file or "?"
            entry = files.setdefault(spec_file, {"file": spec_file, "specs": 0, "passed": 0, "failed": 0,
                                                 "timedOut": 0, "skipped": 0, "flaky": 0, "duration_ms": 0})
            entry["specs"] += 1
            for test in spec.get("tests", []) or []:
                results = test.get("results", []) or []
                statuses = [r.get("status") for r in results]
                final = statuses[-1] if statuses else ("skipped" if not spec.get("ok", True) else "skipped")
                if final in ("passed", "failed", "timedOut", "skipped"):
                    entry[final] += 1
                if final == "passed" and any(s in ("failed", "timedOut") for s in statuses[:-1]):
                    entry["flaky"] += 1
                entry["duration_ms"] += sum(r.get("duration", 0) or 0 for r in results)
                if final in ("failed", "timedOut"):
                    err = (results[-1].get("error") or {}).get("message", "") if results else ""
                    failures.append({"file": spec_file, "title": spec.get("title", ""),
                                     "status": final, "error": _strip_ansi(err)[:400]})
        for child in suite.get("suites", []) or []:
            walk(child, file)

    for suite in doc.get("suites", []) or []:
        walk(suite, None)
    file_list = sorted(files.values(), key=lambda f: f["file"])
    return {
        "framework": "playwright",
        "stats": {
            "expected": stats.get("expected", 0), "unexpected": stats.get("unexpected", 0),
            "skipped": stats.get("skipped", 0), "flaky": stats.get("flaky", 0),
            "duration_ms": stats.get("duration", 0), "start_time": stats.get("startTime"),
        },
        "projects": [p.get("name") for p in (doc.get("config", {}) or {}).get("projects", [])],
        "files": file_list,
        "failures": failures,
        "totals": {
            "tests": sum(f["passed"] + f["failed"] + f["timedOut"] + f["skipped"] for f in file_list),
            "passed": sum(f["passed"] for f in file_list),
            "failed": sum(f["failed"] + f["timedOut"] for f in file_list),
            "skipped": sum(f["skipped"] for f in file_list),
        },
    }


ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def _strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text or "")


# -------------------------------------------------------------------- junit
def parse_junit_xml(text: str) -> dict | None:
    try:
        root = ElementTree.fromstring(text)
    except ElementTree.ParseError:
        return None
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    if not suites:
        return None
    totals = {"tests": 0, "passed": 0, "failed": 0, "skipped": 0}
    names = []
    for s in suites:
        tests = int(s.get("tests", 0) or 0)
        failed = int(s.get("failures", 0) or 0) + int(s.get("errors", 0) or 0)
        skipped = int(s.get("skipped", 0) or 0)
        totals["tests"] += tests
        totals["failed"] += failed
        totals["skipped"] += skipped
        totals["passed"] += max(tests - failed - skipped, 0)
        if s.get("name"):
            names.append(s.get("name"))
    return {"framework": "junit", "suites": names[:50], "totals": totals}


# ----------------------------------------------------------------- coverage
COVERAGE_FILE_RE = re.compile(r"(coverage-summary\.json|coverage-final\.json|lcov\.info|coverage\.xml|cobertura.*\.xml|clover\.xml|\.coverage\.json)$", re.I)


def parse_coverage_file(name: str, data: bytes) -> dict | None:
    """Best-effort coverage percentages from common formats."""
    lower = name.lower()
    try:
        if lower.endswith("coverage-summary.json"):
            doc = json.loads(data)
            total = doc.get("total", {})
            lines = total.get("lines", {})
            return {"format": "istanbul-summary", "lines_pct": lines.get("pct"), "statements_pct": total.get("statements", {}).get("pct"),
                    "branches_pct": total.get("branches", {}).get("pct"), "functions_pct": total.get("functions", {}).get("pct")}
        if lower.endswith("lcov.info"):
            text = data.decode("utf-8", "replace")
            metrics = {}
            for label, found_key, hit_key in (
                ("lines", "LF", "LH"),
                ("branches", "BRF", "BRH"),
                ("functions", "FNF", "FNH"),
            ):
                found = sum(int(x) for x in re.findall(rf"^{found_key}:(\d+)", text, re.M))
                hit = sum(int(x) for x in re.findall(rf"^{hit_key}:(\d+)", text, re.M))
                metrics[f"{label}_pct"] = round(hit * 100 / found, 2) if found else None
                metrics[f"{label}_found"] = found
                metrics[f"{label}_hit"] = hit
            return {"format": "lcov", **metrics}
        if lower.endswith(".xml"):
            root = ElementTree.fromstring(data)
            if root.tag == "coverage" and root.get("line-rate") is not None:
                return {"format": "cobertura", "lines_pct": round(float(root.get("line-rate")) * 100, 2),
                        "branches_pct": round(float(root.get("branch-rate", 0)) * 100, 2)}
            metrics = root.find(".//project/metrics")
            if metrics is not None and metrics.get("statements"):
                total, covered = int(metrics.get("statements")), int(metrics.get("coveredstatements", 0))
                return {"format": "clover", "lines_pct": round(covered * 100 / total, 2) if total else None}
    except (ValueError, ElementTree.ParseError):
        return None
    return None


# ------------------------------------------------------------ artifact zips
def parse_artifact_zip(name: str, blob: bytes) -> dict:
    """Open an artifact and run every parser that applies. Never raises on content errors."""
    result = {"name": name, "bytes": len(blob), "entries": 0, "summary": None,
              "coverage_manifest": None, "run_log": None, "playwright": None,
              "junit": [], "coverage": [], "journeys": 0}
    try:
        zf = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        result["error"] = "not a zip file"
        return result
    names = zf.namelist()
    result["entries"] = len(names)
    result["journeys"] = len({n.split("/")[1] for n in names if n.startswith("journey-reports/") and n.count("/") >= 2})
    for entry in names:
        base = entry.rsplit("/", 1)[-1]
        try:
            if base == "summary.json":
                doc = json.loads(zf.read(entry))
                if (isinstance(doc, dict) and doc.get("schema_version") == 1
                        and isinstance(doc.get("groups"), list)):
                    # The root coverage manifest owns the aggregate and group rows. Per-group
                    # summary.json files deliberately do not replace it.
                    result["coverage_manifest"] = doc
                elif result["summary"] is None:
                    # Only CI layer summaries belong in the executed-test rollup.
                    result["summary"] = _slim_summary(doc)
            elif base == "run.log" and result["run_log"] is None:
                result["run_log"] = parse_run_log(zf.read(entry).decode("utf-8", "replace"))
            elif (entry.endswith("test-results/results.json") or base == "results.json") and result["playwright"] is None:
                doc = json.loads(zf.read(entry))
                if isinstance(doc, dict) and "suites" in doc:
                    result["playwright"] = parse_playwright_json(doc)
            elif base.endswith(".xml") and ("junit" in entry.lower() or "test" in entry.lower()):
                parsed = parse_junit_xml(zf.read(entry).decode("utf-8", "replace"))
                if parsed:
                    parsed["file"] = entry
                    result["junit"].append(parsed)
            elif COVERAGE_FILE_RE.search(base):
                parsed = parse_coverage_file(base, zf.read(entry))
                if parsed:
                    parsed["file"] = entry
                    result["coverage"].append(parsed)
        except (ValueError, KeyError, zipfile.BadZipFile):
            continue
    return result


def _slim_summary(doc: dict) -> dict | None:
    if not isinstance(doc, dict) or not any(key in doc for key in ("layer", "status", "exitCode", "outcomes")):
        return None
    return {
        "layer": doc.get("layer"), "status": doc.get("status"), "exit_code": doc.get("exitCode"),
        "duration_ms": doc.get("durationMs"), "started_at": doc.get("startedAt"), "finished_at": doc.get("finishedAt"),
        "outcomes": [{"command": o.get("command"), "exit_code": o.get("exitCode"), "duration_ms": o.get("durationMs")}
                     for o in doc.get("outcomes", []) or []],
    }
