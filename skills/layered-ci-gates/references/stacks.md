# Stack recipes

What to read to find the test tooling, and what each layer usually runs. These are defaults to adapt: the repository's own scripts and documents win.

## Node.js / TypeScript

- **Read:** `package.json` scripts (and each workspace's), lockfile (npm, pnpm, yarn, bun), `tsconfig*.json`, ESLint/Biome/Prettier config, test configs (`vitest.config.*`, `jest.config.*`, `playwright.config.*`, `.mocharc*`), `node --test` globs in scripts, `engines` and `.nvmrc`.
- **L1:** `tsc --noEmit`, lint, format check, `npm ci --ignore-scripts` validity, lockfile drift, dependency boundary rules, docs/link checks.
- **L2:** unit tests, in-process integration tests with fakes, build of every package, `npm pack`/publish dry run for libraries; one Node version (the lowest supported).
- **L3:** Playwright/Cypress against a locally started stack, tests with real containers (Testcontainers, Compose), credentialed API journeys.
- **L4:** Node version matrix, other operating systems, browser matrix, `npm audit` or dependency canaries, long journeys.
- **L5:** publish dry run against the registry, provenance, upgrade from the previous published version.
- **Watch for:** `postinstall` scripts needing network; tests that spawn `node --test` children inheriting `NODE_TEST_CONTEXT`; snapshot files updated in CI.

## Python

- **Read:** `pyproject.toml` (tool sections for pytest, ruff, mypy, coverage), `setup.cfg`, `tox.ini`, `noxfile.py`, `requirements*.txt`, `uv.lock`/`poetry.lock`, `conftest.py` markers and fixtures, `Makefile`.
- **L1:** ruff/flake8, format check, mypy/pyright, import-linter, packaging metadata (`python -m build --sdist` is often L2).
- **L2:** pytest without network markers, one Python version, wheel build; `pytest -m "not integration and not slow"` style selection with `--strict-markers`.
- **L3:** integration with real services (databases via containers), notebook execution, credentialed API tests.
- **L4:** Python version and OS matrix, optional extras, long data or model tests, GPU runners.
- **L5:** build and upload to TestPyPI or a dry run, install from the built wheel in a clean environment, upgrade from the previous release.
- **Watch for:** tests that hit the network through default fixtures; markers that are not registered (silently select nothing without `--strict-markers`).

## Go

- **Read:** `go.mod` (Go version, modules), `Makefile`, `magefile.go`, build tags in `_test.go` files, `testing.Short()` uses, `golangci-lint` config, `go generate` directives.
- **L1:** `gofmt -l`, `go vet`, `golangci-lint`, `go mod tidy` diff, generated code up to date.
- **L2:** `go test -short -race ./...`, `go build ./...` for the main targets.
- **L3:** `go test -tags integration` with real dependencies, end-to-end binaries against local services.
- **L4:** GOOS/GOARCH matrix, fuzzing (`go test -fuzz` for a bounded time), long benchmarks for trends.
- **L5:** release builds (for example GoReleaser) for every target, checksums and signing, smoke-run the artifacts.

## Java / JVM

- **Read:** `pom.xml` (Surefire, Failsafe, profiles), `build.gradle*`/`settings.gradle*`, JUnit tags, `src/test` vs `src/integrationTest`, Spotless/Checkstyle/ErrorProne config, wrapper versions.
- **L1:** compile without tests or formatting/static checks (`spotless:check`, Checkstyle), dependency convergence.
- **L2:** unit tests (Surefire / `test`), excluding tagged integration tests; one JDK.
- **L3:** Failsafe / `integrationTest` with Testcontainers, contract tests against real brokers or databases.
- **L4:** JDK matrix, long-running and performance suites, mutation testing.
- **L5:** signed artifacts, staging repository deploy dry run, compatibility checks against the previous release (for example japicmp or revapi).
- **Watch for:** builds that download half the internet per run (cache the dependency directory); tests relying on test order.

## Rust

- **Read:** `Cargo.toml` (workspace, features, MSRV `rust-version`), `rust-toolchain.toml`, `#[ignore]` tests, `tests/` integration targets, `xtask`, `deny.toml`, `clippy.toml`.
- **L1:** `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo deny check`, docs build warnings.
- **L2:** `cargo test --workspace` with default features, MSRV check, `--no-default-features` build if supported.
- **L3:** `cargo test -- --ignored` for tests needing services or credentials, feature combinations that matter.
- **L4:** target and OS matrix, Miri or sanitizers, fuzzing for a bounded time, full feature powerset.
- **L5:** release builds for every target, `cargo publish --dry-run`, semver checks (for example cargo-semver-checks).

## Frontend and desktop applications

- **Read:** bundler config (Vite, webpack, Next), component tests (Vitest, Testing Library, Storybook test runner), Playwright/Cypress configs and tags, Electron/Tauri/Flutter config, installer scripts (NSIS, DMG, AppImage), code signing setup.
- **L1:** types, lint, style lint, i18n key checks, bundle size budget from a cached build when cheap.
- **L2:** unit and component tests, production build, accessibility checks on rendered components.
- **L3:** browser E2E against the built app with mocked backends, visual regression with stable fixtures, journeys against a real backend with test credentials.
- **L4:** browser and viewport matrix, Windows and macOS builds, installer build and smoke start, real-backend journeys.
- **L5:** signed and notarized installers for every platform, auto-update from the previous version, store packaging.
- **Watch for:** screenshots compared across fonts and operating systems; macOS and Windows runners cost more minutes on private repositories.

## Services and containers

- **Read:** `Dockerfile*`, Compose files, Helm charts or Kubernetes manifests, Terraform, migration directories, health checks, `.env.example`, seed data and fixture services, deployment workflows.
- **L1:** `docker compose config --quiet`, hadolint, `helm lint`/`helm template`, `terraform fmt -check` and `validate`, schema and migration lint, workflow lint (actionlint).
- **L2:** unit and in-process integration tests, image builds without pushing (cache layers), migrations against an ephemeral local database when fast.
- **L3:** start the Compose stack or a kind cluster and run API/E2E journeys, migration up/down on a copy of real schema, tests against real external sandboxes with test credentials.
- **L4:** upgrade from the previous image with persisted data, chaos or recovery tests (kill and restart), security scans of images, load tests with trend reporting.
- **L5:** push images by digest, sign them, SBOM, deploy to staging and smoke test; production deploys stay outside CI gates unless a person decides otherwise.
- **Watch for:** tests that need privileged containers or nested namespaces (hosted runners may refuse them); tests that leave containers running; port collisions between parallel jobs.

## Repositories with several stacks

Give each stack its own slices under the same layers and the same aggregate check. Use the changed paths to skip a stack's slices only inside the gate (the policy job), never with workflow-level path filters on required checks.
