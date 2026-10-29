/**
 * Lightweight workflow templates for repositories that do not have CI yet.
 * `ci.yml` still comes from the CI-workflow template repository; these files cover
 * the other stages so a new repository starts with build / CI / nightly / e2e / release.
 * Every workflow ends in `gate.mjs run --lane …`, so the board reads one report per lane.
 */
export interface WorkflowSet { [path: string]: string }

function laneWorkflow(name: string, lane: string, trigger: string, description: string, condition?: string): string {
  return `# ${description}
name: ${name}

on:
${trigger}

permissions:
  contents: read

jobs:
  gate:
    name: ${lane}
${condition ? `    if: ${condition}\n` : ''}    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - name: Install
        run: npm ci --no-audit --no-fund
      - name: Gate lane ${lane}
        run: node scripts/gate/gate.mjs run --lane ${lane}
      - name: Upload reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ci-gates-${lane}
          path: gate-reports/
          if-no-files-found: ignore
`;
}

/** Every stage this repository can support, keyed by workflow path. */
export function workflowSet(scripts: Record<string, unknown>): WorkflowSet {
  const has = (name: string) => typeof scripts[name] === 'string' && !!scripts[name];
  const workflows: WorkflowSet = {};
  if (has('build')) {
    workflows['.github/workflows/build.yml'] = laneWorkflow('Build', 'build',
      '  push:\n    branches: [main, master]\n  pull_request:\n  workflow_dispatch:',
      'Compile and package the default branch; the build lane report feeds the dashboard.');
    workflows['.github/workflows/release.yml'] = laneWorkflow('Release', 'release',
      '  push:\n    tags:\n      - "v*"\n      - "[0-9]+.[0-9]+.[0-9]+*"\n  workflow_dispatch:',
      'Build the tagged commit and prove the release lane still passes.');
  }
  if (has('test') || has('build')) {
    workflows['.github/workflows/nightly.yml'] = laneWorkflow('Nightly', 'daily',
      "  schedule:\n    # 16:00 UTC is 00:00 Asia/Shanghai, so the run finishes before the working day.\n    - cron: '0 16 * * *'\n  workflow_dispatch:",
      'Scheduled full run on the default branch: the daily lane keeps the board fresh.');
  }
  if (has('test:e2e') || has('e2e')) {
    workflows['.github/workflows/e2e.yml'] = laneWorkflow('E2E', 'daily',
      '  pull_request:\n    types: [labeled]\n  workflow_dispatch:',
      'Expensive end-to-end journeys. They run when a PR is labelled "e2e" or dispatched by hand;\n# results are filed under the daily lane so they do not gate every PR.',
      "github.event_name != 'pull_request' || github.event.label.name == 'e2e'");
  }
  return workflows;
}
