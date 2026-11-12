---
name: systematic-debugging
description: Use when a bug, test failure, or unexpected behavior has an unclear cause, crosses component boundaries, or persists after an attempted fix. Reproduce it and isolate the cause before changing production code.
---

# Systematic Debugging

1. Record the smallest reproduction you can run, its expected behavior, and the actual error or assertion output. If a check fails during development, rerun the same check on the starting snapshot when practical to distinguish an existing failure from a regression. For intermittent failures, record the inputs and conditions you observed.
2. Trace the failing input or state through the relevant boundaries. Use existing logs or a focused diagnostic to find the first point where actual behavior diverges. Compare a working case through the same path if one exists.
3. State one causal hypothesis and what observation would support or disprove it. Run the smallest check that isolates that variable. Update the hypothesis from the result before trying another production change.
4. Apply a focused fix where the divergence originates. Re-run the original reproduction and the nearby regression checks. Record the cause, the evidence supporting it, and the verification result. If reproduction is blocked, record the missing input or dependency and the checks already attempted.

Adapted from [Superpowers Systematic Debugging](https://github.com/obra/superpowers/blob/main/skills/systematic-debugging/SKILL.md).
