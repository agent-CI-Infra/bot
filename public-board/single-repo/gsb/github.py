"""Minimal GitHub API client on top of urllib.

Responsibilities:
- token discovery (env var first, then the local ``gh`` CLI);
- REST with Link-header pagination and GraphQL;
- artifact download that follows the signed redirect *without* re-sending the
  bearer token (blob storage rejects requests that carry both);
- turning HTTP failures into ``GitHubError`` with a machine-readable ``kind``
  and a human hint the UI can show verbatim.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime
from typing import Any

API_ROOT = "https://api.github.com"
USER_AGENT = "github-status-board/0.1 (local dashboard)"


class GitHubError(Exception):
    """A failed GitHub call, classified so the UI can explain and suggest a fix."""

    def __init__(self, message: str, *, kind: str = "error", status: int | None = None,
                 hint: str = "", reset_at: float | None = None, url: str = ""):
        super().__init__(message)
        self.message = message
        self.kind = kind          # unauthorized | forbidden | rate_limited | not_found | network | server | error
        self.status = status
        self.hint = hint
        self.reset_at = reset_at
        self.url = url

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "status": self.status,
            "message": self.message,
            "hint": self.hint,
            "reset_at": self.reset_at,
            "url": re.sub(r"[?&]?(access_token|token)=[^&]+", "", self.url),
        }


def discover_token() -> tuple[str | None, str | None]:
    """Return ``(token, source)``. Env vars win; otherwise ask the gh CLI.

    The token value is never logged or written anywhere by this project.
    """
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        value = os.environ.get(name, "").strip()
        if value:
            return value, f"env:{name}"
    try:
        proc = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None, None
    token = proc.stdout.strip()
    if proc.returncode == 0 and token:
        return token, "gh auth token"
    return None, None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


class GitHub:
    """Thin client. One instance per snapshot refresh; counts calls and tracks rate limit."""

    def __init__(self, token: str | None, timeout: int = 60):
        self.token = token
        self.timeout = timeout
        self.calls = 0
        self.rate: dict = {}
        self._no_redirect = urllib.request.build_opener(_NoRedirect)

    # ------------------------------------------------------------------ core
    def _headers(self, accept: str) -> dict:
        headers = {
            "Accept": accept,
            "User-Agent": USER_AGENT,
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers

    def _track_rate(self, headers) -> None:
        if headers is None or not headers.get("x-ratelimit-limit"):
            return
        resource = headers.get("x-ratelimit-resource") or "core"
        try:
            self.rate[resource] = {
                "limit": int(headers.get("x-ratelimit-limit", 0)),
                "remaining": int(headers.get("x-ratelimit-remaining", 0)),
                "reset": int(headers.get("x-ratelimit-reset", 0)),
            }
        except ValueError:
            pass

    def _classify(self, err: urllib.error.HTTPError, url: str) -> GitHubError:
        status = err.code
        try:
            payload = json.loads(err.read().decode("utf-8", "replace") or "{}")
        except (ValueError, OSError):
            payload = {}
        message = payload.get("message") or f"HTTP {status}"
        headers = err.headers
        remaining = headers.get("x-ratelimit-remaining")
        reset = headers.get("x-ratelimit-reset")
        retry_after = headers.get("retry-after")
        kind, hint, reset_at = "error", "", None

        if status == 401:
            kind = "unauthorized"
            hint = "token 无效或已过期：运行 `gh auth login`，或导出有效的 GITHUB_TOKEN 后重启看板。"
        elif status == 403 and (remaining == "0" or "rate limit" in message.lower()):
            kind = "rate_limited"
            reset_at = float(reset) if reset else (time.time() + float(retry_after or 60))
            hint = "GitHub API 限流：等到 reset 时间后点「刷新」。未登录时限额只有 60 次/小时，登录后 5000 次/小时。"
        elif status == 429:
            kind = "rate_limited"
            reset_at = time.time() + float(retry_after or 60)
            hint = "触发二级限流：稍等片刻再刷新。"
        elif status == 403:
            kind = "forbidden"
            scope = self._scope_hint(url)
            hint = f"当前 token 无权访问该接口。{scope}".strip()
        elif status == 404:
            kind = "not_found"
            hint = "资源不存在，或 token 缺少查看它的权限（GitHub 对无权限资源统一返回 404）。"
        elif status >= 500:
            kind = "server"
            hint = "GitHub 服务端错误，稍后重试。"
        return GitHubError(message, kind=kind, status=status, hint=hint, reset_at=reset_at, url=url)

    @staticmethod
    def _scope_hint(url: str) -> str:
        if "/dependabot/" in url:
            return "需要 `security_events` scope：`gh auth refresh -h github.com -s security_events`（还需仓库对该账号开放 Dependabot alerts）。"
        if "/code-scanning/" in url or "/secret-scanning/" in url:
            return "需要 `security_events` scope 且账号有仓库写权限。"
        if "/traffic/" in url:
            return "流量数据只对有 push 权限的账号开放。"
        if "/protection" in url:
            return "读取分支保护规则需要仓库 admin 权限。"
        return "确认 `gh auth status` 的 scopes，必要时 `gh auth refresh -s <scope>`。"

    def _request(self, method: str, url: str, *, body=None, accept="application/vnd.github+json",
                 opener=None, raw=False) -> tuple[Any, Any, int]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(accept), method=method)
        self.calls += 1
        try:
            if opener is not None:
                resp = opener.open(req, timeout=self.timeout)
            else:
                resp = urllib.request.urlopen(req, timeout=self.timeout)
            with resp:
                self._track_rate(resp.headers)
                payload = resp.read()
                if raw:
                    return payload, resp.headers, resp.status
                text = payload.decode("utf-8") if payload else ""
                return (json.loads(text) if text else None), resp.headers, resp.status
        except urllib.error.HTTPError as err:
            self._track_rate(err.headers)
            if opener is not None and err.code in (301, 302, 303, 307, 308):
                return None, err.headers, err.code
            raise self._classify(err, url) from None
        except urllib.error.URLError as err:
            raise GitHubError(f"network error: {err.reason}", kind="network",
                              hint="无法连接 api.github.com：检查网络或代理设置后重试。", url=url) from None
        except TimeoutError:
            raise GitHubError("request timed out", kind="network",
                              hint="请求超时：检查网络后重试。", url=url) from None

    # ------------------------------------------------------------------ public
    def get(self, path: str, params: dict | None = None) -> Any:
        url = self._url(path, params)
        data, _, _ = self._request("GET", url)
        return data

    def get_status(self, path: str, params: dict | None = None) -> int:
        """Return only the HTTP status (for 204/404 boolean endpoints)."""
        url = self._url(path, params)
        _, _, status = self._request("GET", url, raw=True)
        return status

    def paginate(self, path: str, params: dict | None = None, *, max_pages: int = 5, key: str | None = None) -> list:
        """Follow ``Link: rel=next`` up to ``max_pages``. ``key`` unwraps ``{key: [...]}`` bodies."""
        params = dict(params or {})
        params.setdefault("per_page", 100)
        url = self._url(path, params)
        items: list = []
        for _ in range(max_pages):
            data, headers, _ = self._request("GET", url)
            chunk = data.get(key, []) if key else data
            items.extend(chunk or [])
            url = self._next_link(headers.get("Link", ""))
            if not url:
                break
        return items

    def graphql(self, query: str, variables: dict | None = None):
        data, _, _ = self._request("POST", f"{API_ROOT}/graphql", body={"query": query, "variables": variables or {}})
        if data and data.get("errors"):
            first = data["errors"][0]
            kind = "forbidden" if first.get("type") in ("FORBIDDEN", "INSUFFICIENT_SCOPES") else "error"
            raise GitHubError(first.get("message", "GraphQL error"), kind=kind,
                              hint="GraphQL 查询失败；REST 降级路径会接管可用部分。", url="graphql")
        return (data or {}).get("data")

    def download_artifact(self, repo: str, artifact_id: int, *, max_bytes: int) -> bytes:
        """Fetch an artifact zip. First hop is authenticated and returns 302 to a signed URL;
        the second hop must be anonymous, so it is done with a plain request."""
        url = f"{API_ROOT}/repos/{repo}/actions/artifacts/{artifact_id}/zip"
        _, headers, status = self._request("GET", url, opener=self._no_redirect, raw=True)
        location = headers.get("Location") if headers else None
        if status not in (301, 302, 303, 307, 308) or not location:
            raise GitHubError(f"artifact download did not redirect (HTTP {status})", kind="error", url=url)
        req = urllib.request.Request(location, headers={"User-Agent": USER_AGENT})
        deadline = time.monotonic() + self.timeout
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                length = resp.headers.get("Content-Length")
                if length and int(length) > max_bytes:
                    raise GitHubError(f"artifact too large ({int(length)} bytes > {max_bytes})", kind="error",
                                      hint="提高 GSB_ARTIFACT_MAX_MB 或缩小产物。", url=url)
                # Socket timeouts only bound idle reads. A slow, continuously streaming
                # trace archive must not monopolize the publication worker indefinitely.
                data = bytearray()
                while True:
                    if time.monotonic() >= deadline:
                        raise GitHubError("artifact download exceeded time budget", kind="network", url=url)
                    chunk = resp.read1(min(64 * 1024, max_bytes + 1 - len(data)))
                    if not chunk:
                        return bytes(data)
                    data.extend(chunk)
                    if len(data) > max_bytes:
                        raise GitHubError(f"artifact exceeds {max_bytes} bytes", kind="error",
                                          hint="提高 GSB_ARTIFACT_MAX_MB 或缩小产物。", url=url)
        except urllib.error.HTTPError as err:
            raise GitHubError(f"artifact blob download failed: HTTP {err.code}", kind="error", url=url) from None
        except (urllib.error.URLError, TimeoutError) as err:
            raise GitHubError("artifact download unavailable", kind="network", url=url) from None

    def get_text_file(self, repo: str, path: str, ref: str | None = None) -> str | None:
        """Raw file content via the contents API, or ``None`` when it does not exist."""
        params = {"ref": ref} if ref else None
        try:
            data, _, _ = self._request("GET", self._url(f"/repos/{repo}/contents/{path}", params),
                                       accept="application/vnd.github.raw+json", raw=True)
        except GitHubError as err:
            if err.kind == "not_found":
                return None
            raise
        return data.decode("utf-8", "replace")

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _url(path: str, params: dict | None) -> str:
        url = path if path.startswith("http") else f"{API_ROOT}{path}"
        if params:
            sep = "&" if "?" in url else "?"
            url = f"{url}{sep}{urllib.parse.urlencode(params)}"
        return url

    @staticmethod
    def _next_link(link_header: str) -> str | None:
        for part in link_header.split(","):
            match = re.match(r'\s*<([^>]+)>;\s*rel="next"', part)
            if match:
                return match.group(1)
        return None


def http_date_to_ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError):
        return None
