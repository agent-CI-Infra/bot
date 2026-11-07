# Issue #156 acceptance

The feature builds on #155 / PR #157. It stores versioned project knowledge in SQLite, reads repository-owned bodies from fixed Git objects, and records actual use. It does not assess attribution conclusions or claim measured development-success improvement. See project-memory.md for API and limits.

## Automated verification

The full local suite passed 699 tests (691 baseline/trace plus eight project-memory cases). Memory tests exercise actual SQLite close/reopen; revision conflicts, no-op and injected history rollback; human adoption of agent notes; optional three-note budget without task completion changes; refusal of secret/foreign-task sources; explicit conflict/revocation and historical warnings; bounded context with 60 large unrelated entries; exact-version reads; unavailable search/source; project grants; and verification invalidation after text/source/scope changes.

A real local Git repository creates a documentation branch, merges it, advances the default branch and reads old/new document versions. A separate controlled HTTP GitHub API test verifies the public promotion endpoint reads actual PR/file responses, rejects a forged merged flag, verifies the blob hash and distinguishes an actual nondefault-base merge from project-default promotion. These are controlled fixtures, not actual OpenToday product merges.

After the full run, request/evaluator/memory integration was extended: executor memory search/read observations are included in the submitted evidence and factual recovery history. The 25-case focused regression passes; final-head CI reruns the full suite, browser checks and images.

## Actual OpenToday continuation

An isolated SQLite copy of the #155 trial retained the original Tasks and sources. Actual model: deepseek-v4.1-flash-1017; normal TaskEngine, GitHub App, opt-in LocalManager and independent acceptance. Task `7317d607ea5210a611918346cc6849ba2fa79c6ee06a733a` checked the Memory storage-access failure edge on `e816af94bba62d68f599a5676dff64013882474e` without product changes or publication.

The request did not repeat implementation paths/test commands: the project memory supplied them. The executor performed three searches and three versioned reads, then inspected source and ran the actual 31-test product suite plus six isolated scratch probes (Vitest/JSDOM, not a browser run). docs/verification156.md cites IDs/revisions, source, actual output and scope limits. Independent acceptance passed. It used 39 provider requests with 766,030 known input / 28,906 output tokens; prices are unconfigured. All 39 requests contained the knowledge identity in input, which is not counted as 39 explicit reads.

The pilot's detailed keyword search once returned empty under the original all-terms match. The provided bounded index still enabled the three actual reads. Matching was broadened afterward and is regression-tested, with the original miss preserved rather than rewritten. The final executor-evidence forwarding was also added after this pilot and is covered by the controlled request integration. This is iterative integration validation, not a frozen-version unattended benchmark.

## Version, repository and retention evidence

The used entry `5e7a2aa4898c37bd5396a06446778f5541bd50b405e878cb` was read at revision2. SQLite was closed/reopened; a false/unverified getter hypothesis was corrected and revoked while its original unverified version remained queryable and excluded from current search. Execution directory cleanup left the retained report, scratch probes and exact memory source available.

[OpenToday PR #20](https://github.com/zy95-12/OpenToday/pull/20) is a new document generated from that SQLite entry, explicitly recording its ID/revision and PR #16 baseline. The live GitHub read endpoint linked it as a new candidate revision while SQLite remained canonical. The old version used by the completed Task was unchanged and the Task was not reopened. PR #20 targets the existing Memory feature branch, not an integrated default product baseline. It remains unmerged. Full actual-default-merge authority switching is exercised in the authorized local Git + controlled HTTP fixtures; no real OpenToday merge is claimed.

Private evidence indexes, report and scratch artifacts are exported separately. Whole conversations/private reasoning/credentials are excluded from exports; exact sanitized inputs/public outputs remain in the private runtime database. A probe originally selected the last scratch artifact instead of the report; the probe was corrected to select the advertised report path, without rerunning or changing the accepted Task.

## Limits

Keyword retrieval is not semantic search. Explicit version/scope mismatch is surfaced; automatic semantic conflict/staleness detection is not implemented. Human verification labels remain sourced assertions; they do not become independent delivery proof. No automatic conversation mining or mandatory summary/PR occurs. Optional failures do not reopen accepted work. Current task/PR/release state remains derived from original authorities, and project deletion intentionally removes its memory. Native session resume may retain previous context; actual request snapshots establish what was provided. No production deployment, project-wide merge or formal release was performed.

## Parent review integration

The #155 follow-up bounds legacy detail/history and candidate bodies, explicitly binds final decisions to the exact verification event/run, and preserves literal JSON delivery bytes with explicit redaction/conversion hashes. These changes are integrated here. The combined trace/memory/request/evaluator regression passes 31 cases; the final suite contains 701 cases. Existing OpenToday facts remain their original pilot evidence, not retrospectively claimed reruns.
