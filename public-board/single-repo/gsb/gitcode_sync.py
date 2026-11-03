"""Public GitCode sync records for the dashboard.

The bot's sync queue produces the records; the collect workflow fetches them with
its OIDC identity. Everything published here is rebuilt from an allowlist of
fields, re-validated and re-redacted, so a bot defect cannot put a credential or
an arbitrary URL on Pages. When the bot cannot be read, the previous records stay
and the page says the data is stale.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

MAX_RECORDS = 300
MAX_PULLS = 50
ACTIONS = {"opened", "synchronize", "reopened", "closed", "merged", "codecheck"}
STATUSES = {"success", "error", "skipped"}
SYNC_STATES = {"pending", "retrying", "synced", "diverged", "failed", "closed", "merged", "skipped"}
CHECK_STATES = {"pending", "success", "failure", "timed_out", "cancelled"}
# Stable codes the bot reports when sync is off; missing credentials may come together.
DISABLED_REASONS = ("no_github_app", "no_webhook_secret", "no_token", "off")
SHA = re.compile(r"[0-9a-f]{40}")
REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
CODE = re.compile(r"[a-z][a-z0-9_]{0,40}")
_SECRETS = [
    (re.compile(r"\b([a-z][a-z0-9+.-]*://)[^\s/@]+@", re.I), r"\1[REDACTED]@"),
    (re.compile(r"\b(authorization|proxy-authorization|private-token|access[_-]?token|x-access-token|password|passwd|secret|token)"
                r"(\s*[\"']?\s*[:=]\s*[\"']?)(?:(?:bearer|basic|token)\s+)?[^\s\"'&,;)|]+", re.I), r"\1\2[REDACTED]"),
    (re.compile(r"\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}", re.I), r"\1 [REDACTED]"),
    (re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"), "[REDACTED]"),
    (re.compile(r"[\x00-\x1f\x7f]+"), " "),
]


def scrub(value, limit=400):
    """Redact credential shapes, then shorten; never the other way round."""
    text = str(value or "")
    for pattern, replacement in _SECRETS:
        text = pattern.sub(replacement, text)
    return text[:limit]


def _url(value, hosts=None):
    text = str(value or "")
    match = re.fullmatch(r"https://([A-Za-z0-9.-]+)(?::\d+)?/[^\s\"'<>@?]*(?:#[A-Za-z0-9_-]*)?", text)
    if not match or (hosts and match.group(1).lower() not in hosts):
        return None
    return text


def _record(item, source):
    if not isinstance(item, dict):
        return None
    pr = item.get("pr")
    if not isinstance(pr, int) or pr <= 0 or item.get("action") not in ACTIONS or item.get("status") not in STATUSES:
        return None
    if not SHA.fullmatch(str(item.get("head_sha", ""))) or not re.fullmatch(r"\d{4}-\d\d-\d\dT[0-9:.]+Z", str(item.get("time", ""))):
        return None
    mr = item.get("mr")
    mr = mr if isinstance(mr, int) and mr > 0 else None
    code = item.get("error_code")
    return {
        "id": scrub(item.get("id"), 64), "time": item["time"], "pr": pr,
        "pr_url": _url(item.get("pr_url"), {"github.com"}) or f"https://github.com/{source}/pull/{pr}",
        "title": scrub(item.get("title"), 300), "action": item["action"], "head_sha": item["head_sha"],
        "mr": mr, "mr_url": _url(item.get("mr_url")) if mr else None, "status": item["status"],
        "summary": scrub(item.get("summary")), "error_code": code if isinstance(code, str) and CODE.fullmatch(code) else None,
        "error": scrub(item.get("error")) if item.get("error") else None,
    }


def _pull(item, source):
    if not isinstance(item, dict) or not isinstance(item.get("pr"), int) or item.get("sync_status") not in SYNC_STATES:
        return None
    pr, mr = item["pr"], item.get("mr") if isinstance(item.get("mr"), int) else None
    return {
        "pr": pr, "pr_url": _url(item.get("pr_url"), {"github.com"}) or f"https://github.com/{source}/pull/{pr}",
        "title": scrub(item.get("title"), 300), "base": scrub(item.get("base"), 100),
        "head_sha": item["head_sha"] if SHA.fullmatch(str(item.get("head_sha", ""))) else None,
        "mr": mr, "mr_url": _url(item.get("mr_url")) if mr else None, "sync_status": item["sync_status"],
        "check": item.get("check") if item.get("check") in CHECK_STATES else None,
        "error_code": item["error_code"] if isinstance(item.get("error_code"), str) and CODE.fullmatch(item["error_code"]) else None,
        "error": scrub(item.get("error")) if item.get("error") else None,
        "updated_at": item.get("updated_at") if re.fullmatch(r"\d{4}-\d\d-\d\dT[0-9:.]+Z", str(item.get("updated_at", ""))) else None,
        "pending": bool(item.get("pending")),
    }


def _reasons(payload):
    """Known reason codes, in the bot's order; `reasons` wins over the comma-joined `reason`."""
    raw = payload.get("reasons") if isinstance(payload.get("reasons"), list) else str(payload.get("reason") or "").split(",")
    seen = []
    for code in raw:
        code = code.strip() if isinstance(code, str) else ""
        if code in DISABLED_REASONS and code not in seen:
            seen.append(code)
    return seen


def _listed(payload, key):
    value = payload.get(key)
    return value if isinstance(value, list) else []


def public_document(payload, previous, now):
    """Build site/data/gitcode-sync.json from the bot payload (or a fetch failure)."""
    previous = previous if isinstance(previous, dict) else {}
    old_records = [r for r in previous.get("records", []) if isinstance(r, dict)] if previous else []
    base = {"schema_version": 1, "generated_at": now}
    if isinstance(payload, dict) and payload.get("ok") is True and payload.get("enabled") is False:
        return {**base, "available": True, "enabled": False, "reasons": _reasons(payload), "records": [], "pulls": []}
    if not (isinstance(payload, dict) and payload.get("ok") is True and payload.get("enabled") is True
            and REPO.fullmatch(str(payload.get("source", ""))) and REPO.fullmatch(str(payload.get("target", "")))):
        reason = payload.get("error") if isinstance(payload, dict) and payload.get("ok") is False else "invalid response"
        return {**base, "available": False, "enabled": previous.get("enabled", True), "reasons": _reasons(previous), "error": scrub(reason, 120),
                "stale_since": previous.get("generated_at") if previous.get("available") else previous.get("stale_since"),
                "source": previous.get("source"), "target": previous.get("target"), "check_name": previous.get("check_name"),
                "records": old_records[:MAX_RECORDS], "pulls": previous.get("pulls", [])[:MAX_PULLS]}
    source = payload["source"]
    fresh = [r for r in map(lambda item: _record(item, source), _listed(payload, "records")) if r]
    # The bot keeps a bounded window; earlier published records stay until this window evicts them.
    by_id = {r["id"]: r for r in old_records if r.get("id")}
    by_id.update({r["id"]: r for r in fresh if r["id"]})
    records = sorted(by_id.values(), key=lambda r: (r["time"], r["id"]), reverse=True)[:MAX_RECORDS]
    pulls = [p for p in map(lambda item: _pull(item, source), _listed(payload, "pulls")) if p][:MAX_PULLS]
    return {**base, "available": True, "enabled": True, "source": source, "target": payload["target"],
            "check_name": scrub(payload.get("check_name") or "CodeCheck (GitCode)", 100), "records": records, "pulls": pulls}


def encode(document):
    return json.dumps(document, ensure_ascii=False, separators=(",", ":"))


def load(path, previous_path, now):
    """Return the public document for this run, or None when no records were fetched."""
    if not path:
        return None
    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        payload = {"ok": False, "error": "records file unreadable"}
    try:
        previous = json.loads(Path(previous_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = None
    return public_document(payload, previous, now)
