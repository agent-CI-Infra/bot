---
name: risk-based-testing
description: Use when selecting or reviewing test coverage for a behavior change. Use the acceptance criteria, actual diff, and impact on users or callers to choose unit, integration, API, or end-to-end checks.
---

# Risk-Based Testing

Read the acceptance criteria and actual diff. Identify which outcomes can change for users or callers and where a failure would be observable. Prioritize uncovered outcomes by impact and plausibility.

| Behavior at risk | Evidence to prefer |
| --- | --- |
| Local rules, transformations, or input boundaries | A focused unit test with concrete inputs and expected outputs. |
| API, persistence, or module contracts | An integration or API test at the affected boundary with assertions on the returned result or persisted state. |
| A key user journey or behavior spanning components | An existing E2E or scenario harness that exercises the normal entry point. If unavailable, use the closest available integration boundary and report what remains unverified. |

Reuse the project's runners and fixtures. For assistant behavior, use a fixed model response and controlled tool fixtures where available. If tool execution changed, assert the selected tool, arguments, and observable result through the normal assistant entry point. Cover failure handling or repeated side effects when the change affects those paths.

Run the narrow checks for the affected behavior, then run the checks required by the project. In the delivery evidence, link each material acceptance criterion or regression risk to a check. Distinguish passed, failed, blocked, and not run. Explain any coverage gap that affects confidence in the change.

Adapted from the [LoopForge Test Engineer rules](https://github.com/Tencent/LoopForge/blob/main/local/.codex/rules/tester.mdc).
