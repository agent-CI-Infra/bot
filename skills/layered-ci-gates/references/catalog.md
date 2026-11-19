# Case catalog, tags and per-layer commands

## One catalog

Every case declares the first layer that needs it. Workflows select cases through the repository's own commands and never keep lists of test names or files. The catalog can be:

- **tags in the tests themselves** (markers, annotations, name tags), selected by the test runner; best when the runner supports it;
- **a small catalog file** (for example `ci/cases.json`, `ci/catalog.mjs`, `ci/cases.py`) mapping each entry point to its layer and environment tags, when cases are whole commands or several runners are involved;
- **directories or file globs** per layer (`test/unit`, `test/e2e`), when the layout already separates them.

Choose what the repository already half-uses. Start coarse: one entry per command is enough for L1 + L2.

## Tag dimensions

Keep dimensions independent:

| Dimension | Values | Meaning |
|---|---|---|
| `tier` | `l1` … `l5` | first layer that runs the case (default `l2`) |
| category | `unit`, `system`, `e2e`, `static`, `build` | what kind of test it is |
| cost | `free`, `paid` | whether running it spends money (model calls, cloud resources) |
| needs | `none`, `docker`, `browser`, `db`, `network`, `gpu`, `credentials:<name>`, `os:<name>` | environment it requires |

A case that needs a capability the runner lacks fails its preflight; it is never silently dropped. A skipped case is not a pass: count planned, executed and passed, and fail the layer when they differ.

## Tag syntax by runner

| Runner | Tag a case | Select |
|---|---|---|
| pytest | `@pytest.mark.l3` (register markers in `pyproject.toml`/`pytest.ini`, `--strict-markers`) | `pytest -m "not l3 and not l4"` |
| Go | build tag `//go:build integration` in a separate file, or `testing.Short()` | `go test -short ./...`, `go test -tags integration ./...` |
| JUnit 5 | `@Tag("l3")` | Maven Surefire/Failsafe `groups`/`excludedGroups`; Gradle `useJUnitPlatform { includeTags 'l3' }` |
| Rust | `#[ignore = "l4: needs network"]`, or Cargo features / separate test targets | `cargo test`, `cargo test -- --ignored`, `cargo test --features integration` |
| node:test | name prefix (`'[l3] ...'`) with `--test-name-pattern`, or file globs per layer | `node --test --test-name-pattern='^\[l3\]'` |
| Jest / Vitest | file globs or projects per layer; Vitest `--project`, Jest `--selectProjects`, or `describe` name tags with `-t` | `vitest run --project unit` |
| Playwright | `test('...', { tag: '@l3' })` or `@l3` in the title | `playwright test --grep @l3`, `--grep-invert @l4` |
| Cypress, Robot, Behave | tags or plugins (`@cypress/grep`, `--include`, `--tags`) | runner's tag filter |
| Shell or make targets | one catalog entry per target | the catalog command |

## One local command per layer

Each layer, and each slice inside it, has a command anyone can run locally with the same result as CI:

```text
ci:l1        static checks
ci:l2        L1 + hermetic unit/system tests and builds (the PR profile)
ci:unit      one slice of L2, for sharding or local focus
ci:e2e       the L3 browser slice with local fakes
ci:e2e:real  the L3/L4 slice that needs credentials; refuses to run without an explicit opt-in such as CI_ALLOW_REAL=1
ci:daily     the L4 additions
ci:release   the L5 additions
```

Use the repository's own runner for the names: `npm run ci:l1`, `make ci-l1`, `just ci-l1`, `nox -s ci_l1`, `./gradlew ciL1`, `cargo xtask ci-l1`. A command for a paid or credentialed slice must check its opt-in and required variables before running anything and name what is missing.

Slices are disjoint and their union is the cumulative profile. Workflows shard a slice by passing a shard argument to the same command, not by listing files.

## Catalog check

Add an L1 check that fails when:

- a test file sits outside every slice's collection pattern (it would never run);
- a case has no tier, an unknown tag or a missing environment tag;
- a workflow job runs a command that is not a catalog command;
- a slice selects zero cases.

## Results

Each layer writes a summary (planned, executed, passed, failed, skipped, duration) and its logs to a results directory that the workflow uploads with `if: always()`, keeping the test command's exit code. Upload diagnostics after a failure without turning it into a success.
