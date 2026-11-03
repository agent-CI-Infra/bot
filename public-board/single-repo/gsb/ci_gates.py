"""Public, bounded summaries from ci-gates report artifacts.

The source workflow uploads ``gate-reports/*.json`` as ``ci-gates-reports``.
Only lane verdicts, command status and case-catalog counts are exposed; the
full command output and repository content stay in the source artifact.
"""
from __future__ import annotations

import io
import json
import zipfile

MAX_FILE = 1024 * 1024
MAX_FILES = 20
LANE_ORDER = ("build", "pr-ready", "pr-merge", "daily", "release")
VERDICTS = {"pass", "fail", "not_applicable", "waived", "observe_fail", "error"}


def _text(value, limit=120):
    return str(value or "").replace("\x00", "")[:limit]


def _status(value):
    value = _text(value, 40).lower()
    return value if value in {"pass", "fail", "not_applicable", "waived", "observe_fail", "error", "not_run"} else "unknown"


def parse_artifact(data: bytes):
    """Return a compact gate summary, or ``None`` when the zip is not ci-gates."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError):
        return None
    lanes, catalog, stage = {}, None, None
    with archive:
        for info in archive.infolist()[:MAX_FILES]:
            if (info.is_dir() or not info.filename.endswith(".json") or
                    info.filename.startswith("/") or ".." in info.filename.split("/") or
                    info.file_size > MAX_FILE):
                continue
            try:
                doc = json.loads(archive.read(info))
            except (KeyError, ValueError, UnicodeDecodeError):
                continue
            if not isinstance(doc, dict) or doc.get("schema") != "ci-gates/gate-report@1":
                continue
            lane = _text(doc.get("lane"), 40)
            if lane not in LANE_ORDER:
                continue
            results = []
            for result in (doc.get("results") or [])[:30]:
                if not isinstance(result, dict):
                    continue
                results.append({
                    "name": _text(result.get("name"), 120),
                    "status": _status(result.get("status")),
                    "exitCode": result.get("exitCode") if isinstance(result.get("exitCode"), int) else None,
                    "durationMs": result.get("durationMs") if isinstance(result.get("durationMs"), (int, float)) else None,
                })
            cases = doc.get("cases") if isinstance(doc.get("cases"), dict) else {}
            counts = cases.get("catalog") if isinstance(cases.get("catalog"), dict) else None
            if counts:
                catalog = {key: counts.get(key) for key in ("total", "ready", "todo", "skipped") if isinstance(counts.get(key), int)}
            onboarding = doc.get("onboarding") if isinstance(doc.get("onboarding"), dict) else {}
            if onboarding.get("stage"):
                stage = _text(onboarding["stage"], 40)
            lanes[lane] = {
                "lane": lane,
                "verdict": _status(doc.get("verdict")),
                "event": _text(doc.get("event"), 40),
                "sha": _text(doc.get("sha"), 40),
                "level": _text(doc.get("level"), 8),
                "results": results,
            }
    if not lanes:
        return None
    ordered = [lanes[key] for key in LANE_ORDER if key in lanes]
    verdicts = {lane["verdict"] for lane in ordered}
    overall = "fail" if verdicts & {"fail", "error"} else "observe_fail" if "observe_fail" in verdicts else "pass"
    return {"lanes": ordered, "cases": catalog or {}, "stage": stage, "verdict": overall}


def summary(runs):
    """Latest run carrying a parsed gate artifact, with a small run header."""
    for run in sorted(runs or [], key=lambda item: item.get("created_at") or "", reverse=True):
        gates = run.get("gates")
        if not gates:
            continue
        return {
            **gates,
            "run": {
                "id": run.get("id"),
                "url": run.get("url"),
                "event": run.get("event"),
                "conclusion": run.get("conclusion"),
                "branch": run.get("branch"),
                "sha": run.get("sha"),
                "created_at": run.get("created_at"),
            },
        }
    return None
