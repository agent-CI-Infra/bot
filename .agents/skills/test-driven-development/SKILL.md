---
name: test-driven-development
description: Use when implementing new behavior or fixing a bug that can be exercised with the project's existing tests. Establish an expected failure before editing production code, then verify that the same test passes after the change.
---

# Test-Driven Development

1. Turn one acceptance criterion or reported symptom into an observable assertion at the closest existing behavior boundary. Reuse the project's test runner and fixtures. Exercise the public function, API, or assistant entry point that owns the behavior.
2. Add or update the test before editing production code. Run the focused test and inspect the failure. A useful RED reaches the intended assertion and fails for the expected missing behavior or bug. Fix any setup, import, or fixture failure first. If the assertion already passes, inspect whether the behavior already exists or whether the test misses the scenario.
3. Implement the smallest change that satisfies the assertion and rerun the same test. Keep the assertion tied to the expected result. If the test itself was wrong, correct it and establish the expected failure against the original behavior before relying on it.
4. Repeat for additional behavior as needed. Keep the focused tests green through any in-scope refactoring and run the checks required by the project. Record the test command, what failed before the change, and the result after it. State any part of the cycle that could not be observed.

For behavior-preserving refactors, capture the current behavior with a passing characterization test when coverage is missing. Use RED → GREEN for changes that are meant to alter behavior.

Adapted from [Superpowers Test-Driven Development](https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md).
