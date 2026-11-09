# Project memory (#156)

Project memories supplement task inputs; they never grant tools, change acceptance requirements or prove delivery. Existing project_context remains compatible. Task prompts carry both its sourced facts and a bounded project-memory index; no separate project/queue or Chief approval chain is introduced.

SQLite project_memories holds current entries and project_memory_versions retains full previous data, actor, reason and time. Keys are unique per repository. Revision checks prevent lost updates, identical writes are no-ops, and current/history commit atomically. Human edits adopt human ownership. Agent notes are optional experience/hypothesis, always unverified, cannot replace human entries/repository authorities, and have a three-note per-run budget. No end-of-task model summarizer or background timer is installed.

Kinds: goal, decision, implementation, experience, hypothesis. Status: active, needs_review, conflict, archived, revoked. Verification: human_asserted, observed, unverified. Human classification is an assertion with sources, not automatically independent proof. Sources retain Task/run and repository references. Explicit conflicts retain their evidence and versions; this phase does not perform semantic contradiction discovery.

Repository promotion reads live GitHub PR and file data with the existing account, checks repository identity, default-base merge state, fixed commit and actual Git blob hash. Unmerged/nondefault-base documents remain candidates; SQLite stays canonical. An actual default-base merge switches the body authority to the document and removes the current SQLite body. Older versions remain. Subsequent SQLite body edits are refused; new observations may use separate entries. The API never merges a PR or publishes a document. Direct linkDocument is an internal trusted-proof method; public requests cannot supply their own merged flag or commit proof.

Repository reads verify the document blob at the task's actual baseline/candidate. Identical content on a descendant remains readable; changed/missing content returns source_changed/source_unavailable without asserting a cached body. SQLite implementation entries with a different scoped commit return version_check_required. Explicit module/file/commit scopes are queryable; semantic staleness and automatic contradiction detection are not claimed. Tasks can inspect current repository sources without waiting for memory maintenance or a document PR.

## API

The control-plane API applies current server ActorContext grants:

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

Explicit historical reads include current_revision/current_status and a historical flag so an old active version is not mistaken for a current decision. Body/source/scope edits invalidate inherited verification unless explicitly reclassified. Exact memory sources also resolve through the Task trace source endpoint as project_memories:<id>:<revision>. Native and ordinary request authorized shared memory-use observations are available to independent acceptance, without inheriting executor conversation or Dev-private memories.

模块和来源可通过 `module`（精确匹配 scope.module）、`source`（sources 中不区分大小写的片段）组合过滤；agent 搜索工具也支持这两个参数。`supersedes` 是同项目条目 ID 数组，写入时检查循环和来源项目，并禁止 agent 替代人类事实。读取返回 `superseded_by` 当前生效的反向关系；默认检索排除被生效条目替代的旧条目，`include_superseded=1` 可查询全部。撤销替代条目后原条目重新参与检索。旧版本保持原始替代关系，versions 同时返回 previous_revision、sources 和 supersedes（后两者为 JSON 文本）；previous_revision=0 表示首版。

## Project knowledge directory and authorization (#173)

The console's **项目知识** page is now one free-file browser for existing notes and ProjectMemory content; the legacy 项目笔记 URL redirects there. The `/api/projects/:id/knowledge` facade and `/api/repositories/:id/memories` remain compatibility APIs for existing tools. There is no second body table or file import. Existing JSON and historical versions are left intact; missing index fields are projected at read time. An explicit edit writes the next normal revision. A failed write rolls back current data, history and the agent-note receipt together.

`catalog` is revisioned index metadata: `title`, `tags`, `aliases`, repository-relative `path`, `module`, responsible `owner`, `category`, `audience`, `reviewed_at` and `review_due_at`. This responsible owner does not replace the existing human/agent ownership fence. Suggested categories are goal, decision, convention, operations, experience and hypothesis. No repository layout is mandatory. Query supports path-prefix, module, category and tag filters plus title/alias/error-text keyword lookup. Previews remain distinct from an exact-version read. Review deadlines expose `review_overdue`; no scheduling or semantic truth inference is performed.

All knowledge service operations require an issued, current server ActorContext with project-scoped `knowledge.read`/`knowledge.write`. Task adapters resolve the persisted `task_authorizations` principal and bind the server's active execution role; a missing task identity returns `memory_actor_unavailable`, rather than falling back to administrator authority. Tenant/project grants and credential guards remain live during asynchronous document reads. Neither query `role` nor model `role_scope` grants a role view.

`audience` is `project` or `role:<role-id>`. Legacy `scope.role` remains honored; legacy unscoped agent notes default to Dev-private. Human project administrators holding `knowledge.write` may manage role knowledge. Task roles see shared entries and only their own role entries, even when their initiating principal is an administrator. Only Dev may retain experience/hypothesis notes, always unverified and at most three per run. Reviewer, Test and QA write evaluation work products instead. Agent tools cannot share private candidates, promote documents or review themselves. Human or repository-owned facts still reject agent overwrites/replacements with the existing error codes.

Authorization covers search, IDs/keys, exact old revisions, versions, document readback, trace/source resolution, nested captured knowledge, management reads and export. Both the current audience and the requested historical audience must permit access. A private replacement cannot hide a visible predecessor or expose its ID through reverse lineage. Captured snapshots are filtered using current grants; ordinary JSON strings and file content retain their original bytes when no knowledge is removed. A filtered snapshot explicitly reports `complete:false`/`knowledge_filtered` while retaining its original evidence digest. Raw role run/model input sources are private to that execution role or an authorized knowledge administrator. No permission or body cache extends a revoked grant. Role instances fingerprint their knowledge view; changed authorization/audiences discard persisted transcripts and external native-session bindings before the next assignment, rebuilding from authorized task records. Data already delivered to an actively running model cannot be erased; subsequent knowledge calls still reauthorize.

Additional API operations:

- `POST .../:memoryId/review`: `expected_revision`, `action`, `evidence` (nonempty reference list), `reason`; optional `catalog`, `supersedes` for merge, `run_id` for an independent process. Actions are accept, reject, conflict, archive, revoke, restore and merge. The state change, review actor/time/evidence and index review time form one revision. Restore returns to needs_review. Original sources and prior verdicts remain addressable; stale revisions fail with `memory_revision_changed`.
- `GET .../memories?export=1` (or `.../knowledge?export=1`): exports only authorized current entries and resolves repository bodies through the same reader. This is an authenticated export, never a raw SQLite dump.
- Management queries `search_knowledge`, `read_knowledge` and `knowledge_versions`, and command `knowledge.revise`, call the same service. Management writes retain the existing command idempotency and approval policy. `revision` remains a required knowledge-write fence in addition to the management command's own target revision.

A human review records an explicit assertion with cited evidence. A separately delegated service needs **additional** `knowledge.review`, a succeeded independent Reviewer/Test/QA run in the same repository, an actual `memory_read` of the exact candidate revision in that run, and retained raw observation references from that run. A producer run cannot review its own candidate. Service review preserves the entry's existing owner and records the service principal in `review.actor`; human review still adopts human ownership. This is the small #168 integration contract; it does not implement an independent-review scheduler.

`knowledge.review` is an explicit-delegation capability, separate from `projectCapabilities`. It is never added by GitHub-derived grants, legacy projection or creation of a default project service principal. A grant manager with `grants.manage` in the target scope can configure this capability without personally holding `knowledge.review`; ordinary capability delegation still requires the grantor's own effective permission, and self-delegation remains forbidden.

After creating the service through `POST /api/identity/service-principals` (with `project_id` and `maintenance`), the grant manager explicitly calls `POST /api/identity/grants`, for example:

```json
{"principal_id":"<service-principal-id>","tenant_id":"github.com:10","project_id":"101","capabilities":["knowledge.review"]}
```

This adds a separate auditable grant; it does not broaden the default capability set. The service still needs its project `knowledge.read`/`knowledge.write` grants and the independent-run evidence above. Resolve a fresh service ActorContext after granting: `resolveServiceActor` presents the currently effective, project-bounded capabilities, including the explicit review grant. `DELETE /api/identity/grants/:grant_id` revokes it and invalidates previously issued actors; a fresh actor again lacks review permission.

Document promotion accepts only server-observed PR/file data. A default-base merged PR must also have its merge commit as an ancestor of the repository's live default branch, checked through the GitHub compare response; a missing/wrong repository, forged merged flag, unreachable merge commit or corrupt blob cannot become repository authority. Nondefault/unmerged documents remain candidates. Fixed historical reads still indicate current status, and source_changed/source_unavailable/version_check_required remain explicit.

Pi uses its existing control-plane mailbox and ACP uses its existing run-local MCP tools. Both invoke `memoryTool` and ProjectMemory with the same task actor and role checks; changing backend adds no database/file permissions. Reads trace the actual revision, source reference, baseline, offset, returned character count and content digest. A failure is an explicit result and never completes or reopens a task. The future #169 broker is not required by these two existing transports and is not implemented here. Work-directory pruning does not delete database knowledge; explicit project removal retains the existing lifecycle. Legacy notes and memories appear in the same file browser without copying private content into the shared volume, and no private chat or credential import is installed.

Acceptance includes the existing SQLite/Git compatibility tests, `test/knowledge.test.mjs`, the real Pi SDK plus ACP protocol/MCP fixture in `test/knowledge-backends.test.mjs`, and `e2e/knowledge.spec.mjs`. These tests assert source, revision and authorization behavior; they do not claim a real external model run, a live GitHub merge, or improved model quality.

## Free files and version history

The project console offers one 项目知识 entry with filenames, a plain-text editor and version history. Creation needs only `name` and `content`; empty text, Unicode and arbitrary single-segment filenames/extensions are supported. Classification, sources, review fields and document-promotion forms are not part of the file editor. Existing ProjectMemory metadata, ownership and role visibility remain intact for compatibility. Repository-authoritative documents remain read-only here; their source still changes through a repository PR.

`/api/repositories/:id/knowledge-files` provides the unified contract:

- GET lists current files; `include_deleted=1` also includes deleted files; `query` filters filenames. POST `{name,content}` creates a shared project file. Use the returned opaque file `id` for later requests.
- GET `/:id` reads current text; `?revision=N` reads a historical version. GET `/:id/versions` lists revision metadata.
- PUT `/:id` takes `{content,expected_revision}`. DELETE takes `{expected_revision}` and retains history. POST `/:id/restore` takes `{revision,expected_revision}` and restores the selected content while retaining later history. Stale writes return `note_revision_changed`; identical saves keep their revision.

All reads and writes use current server ActorContext knowledge permissions, including after an asynchronous manager response. Legacy memory revisions also retain their current/historical audience checks. Old entries are addressed in place as text files; no second body copy or automatic private-note import is created. A file edit records the actual principal and retains prior provenance/audience without requiring the old directory form.

Workspace notes continue using `../notes/` and the existing notes API. Managed workspace and console writes use the same filesystem lock and create content-addressed snapshots with an atomic revision index in the pre-existing reserved `.write-` namespace. Old files are snapshotted on first managed access; direct shell edits/deletions are captured when next observed by managed reads or the file browser. Intermediate shell writes that are never observed are not claimed as distinct saved versions. History is excluded from normal file listings and publication trees. Computer cleanup/reset keeps both files and history; authorized project removal retains its existing lifecycle.
