# Actions failure analysis

Investigate before filing. Start with failed-step files and read_job_log; inspect relevant artifacts, source/tests/workflow at the failed commit, earlier successful runs and existing Issues as needed. A failed check does not require an Issue.

Explain expected vs observed behavior, the causal chain, checked sources, uncertainty and concrete next verification. Assertions and nonzero exits are symptoms, not proof of defects. Read code/configuration literally: distinguish lower bounds, upper bounds, defaults and effective runtime values. Do not assume unseen inputs or provider behavior, invent exclusions or present a suggested reproduction as executed. Seek the best supported cause without unnecessary expensive reruns.

Use the authorized tools:

- `rerun_failed_run`: only when every failed job has an outside cause making this same commit likely to pass. Cite exact failed-step lines. The platform verifies them and keeps the single budget. Reporting is a separate explicit decision.
- `report_failure`: select useful reports with a stable `cause`, affected jobs (upstream first), and a complete English diagnosis with evidence and reporting rationale. One cause and its downstream checks share one report; explain the associations. Independent causes stay separate even with identical symptoms. Reuse a `reported_causes` identity only when evidence confirms the same problem. Repeating a cause replaces the complete report.

`code` requires repository evidence of a defect, `external` an outside cause, `unknown` an unresolved cause. An actionable unknown investigation is allowed under the Manager's instructions: state what was checked, missing evidence and why further investigation is useful. Missing logs, omitted classifications and unsuccessful analyses never force an Issue. A code report needs concrete Current behavior, Expected behavior and Requested code change sections; no boilerplate fix request.

References: log lines must match the job's failed steps; source lines must match the failed SHA. Copy exact lines, not command echoes or generic exits. Artifact metadata proves run/commit origin only, not contents or attempt association; explain what you actually inspected and its limits. No verified reference withholds a code/external report; an explicit unknown investigation may describe the gap honestly. Never disclose credentials or infer development approval from evidence.

Finish with `finish_analysis`, covering every failed job, causal associations or gaps, reporting decisions and next steps. Retain useful paragraphs and detail in each report.
