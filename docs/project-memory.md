# Project memory (#156)

Project memories supplement task inputs; they never grant tools, change acceptance requirements or prove delivery. Existing project_context remains compatible. Task prompts carry both its sourced facts and a bounded project-memory index; no separate project/queue or Chief approval chain is introduced.

SQLite project_memories holds current entries and project_memory_versions retains full previous data, actor, reason and time. Keys are unique per repository. Revision checks prevent lost updates, identical writes are no-ops, and current/history commit atomically. Human edits adopt human ownership. Agent notes are optional experience/hypothesis, always unverified, cannot replace human entries/repository authorities, and have a three-note per-run budget. No end-of-task model summarizer or background timer is installed.

Kinds: goal, decision, implementation, experience, hypothesis. Status: active, needs_review, conflict, archived, revoked. Verification: human_asserted, observed, unverified. Human classification is an assertion with sources, not automatically independent proof. Sources retain Task/run and repository references. Explicit conflicts retain their evidence and versions; this phase does not perform semantic contradiction discovery.

Repository promotion reads live GitHub PR and file data with the existing account, checks repository identity, default-base merge state, fixed commit and actual Git blob hash. Unmerged/nondefault-base documents remain candidates; SQLite stays canonical. An actual default-base merge switches the body authority to the document and removes the current SQLite body. Older versions remain. Subsequent SQLite body edits are refused; new observations may use separate entries. The API never merges a PR or publishes a document. Direct linkDocument is an internal trusted-proof method; public requests cannot supply their own merged flag or commit proof.

Repository reads verify the document blob at the task's actual baseline/candidate. Identical content on a descendant remains readable; changed/missing content returns source_changed/source_unavailable without asserting a cached body. SQLite implementation entries with a different scoped commit return version_check_required. Explicit module/file/commit scopes are queryable; semantic staleness and automatic contradiction detection are not claimed. Tasks can inspect current repository sources without waiting for memory maintenance or a document PR.

## API

Existing authenticated project grants apply through TaskEngine:

- GET/POST `/api/repositories/:id/memories`: query/filter/cursor index or create with key, expected_revision:0, body, kind, sources, scope, verification and reason.
- GET/PATCH `/api/repositories/:id/memories/:memoryId`: read current/explicit revision (`revision`, `baseline` query) or update with expected_revision and reason.
- GET `.../:memoryId/versions`: actor/reason/time history.
- POST `.../:memoryId/document`: expected_revision, pr_number, path. Server verifies actual remote state; does not accept an untrusted merged flag.

Search supports query, kind, status, baseline, after and limit (maximum50). Search is a bounded any-keyword/key/module lookup, not embedding retrieval. Default excludes archived/revoked, preserves explicit needs_review/conflict. Rebuildable indexes never replace authoritative rows or repository documents.

Execution tools: search_project_memory, read_project_memory (exact version, offset, 8000-character pages), remember_project_memory. Native Pi routes them through the existing control-plane mailbox; workspace read/notes-write capabilities apply. Fresh acceptance gets read-only tools when project memory exists. Executor/evaluator memory failures are explicit tool results, not automatic completion failure; task contract and live policy still apply. Input generation failure carries unavailable rather than claiming no knowledge.

Initial context offers at most eight bounded source previews, prioritizing goals/decisions and relevant Memory/Brief scope, with omitted count and retrieval tools. Previews are not complete constraints or claims of reading. Actual prompt/config is retained by #155; memory_search lists returned versions and memory_read records explicitly retrieved version, source, availability, baseline and content digest. Actual provider request captures establish what entered input. Search/read/input are distinct facts. Resume may retain an existing native session's earlier input; actual model captures, not regenerated intended context, establish what was sent.

## Retention and boundaries

Repository files stay versioned with code; SQLite retains unpromoted knowledge, lineage and previous SQLite versions. Cleanup of execution directories does not delete memories. Authorized project removal cascades repository-owned memory data; credentials/private user notes are not automatically imported. Semantic sensitivity cannot be perfectly inferred from prose; known credential/private-key patterns and fields are refused, and the feature performs no automatic conversation mining.

Tests use actual SQLite reopen, a real local Git branch/merge/document edit cycle plus a controlled HTTP GitHub PR/file API, revision races/rollback, optional note limits, human adoption, conflict/revocation, paging, large unrelated memory sets, unavailable query/source, project access and exact versions. These controlled fixtures do not claim an actual OpenToday merge or model quality improvement. The real-model continuation and evidence report are separate.

Explicit historical reads include current_revision/current_status and a historical flag so an old active version is not mistaken for a current decision. Body/source/scope edits invalidate inherited verification unless explicitly reclassified. Exact memory sources also resolve through the Task trace source endpoint as project_memories:<id>:<revision>. Native and ordinary request memory-use observations are available to independent acceptance, without inheriting executor conversation.

模块和来源可通过 `module`（精确匹配 scope.module）、`source`（sources 中不区分大小写的片段）组合过滤；agent 搜索工具也支持这两个参数。`supersedes` 是同项目条目 ID 数组，写入时检查循环和来源项目，并禁止 agent 替代人类事实。读取返回 `superseded_by` 当前生效的反向关系；默认检索排除被生效条目替代的旧条目，`include_superseded=1` 可查询全部。撤销替代条目后原条目重新参与检索。旧版本保持原始替代关系，versions 同时返回 previous_revision、sources 和 supersedes（后两者为 JSON 文本）；previous_revision=0 表示首版。
