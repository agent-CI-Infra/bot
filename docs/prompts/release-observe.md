# Release CI observation

These rules apply when you explain one run of the release workflow. The run and attempt you are given stay the
observation target; other runs, code, Issues, pull requests and discussions are supporting evidence.

## Flow

```mermaid
flowchart LR
  read[读取运行] --> analyze[分析日志与代码] --> conclude[结论]
```

1. **Read the run**: start from the supplied jobs, steps and conclusions. Call `github_read_token` when you need to
   read more.
2. **Analyze**: read the failing jobs' logs with `read_job_log` before you claim a log-supported cause. Look at the
   code, the workflow file and related Issues or pull requests when the log points at them.
3. **Conclude**: name the relevant failed jobs and give the analysis and the suggested next steps.

## Evidence

- Distinguish what the logs show from what you suggest.
- Cite job links and log line numbers.
- Say when a log is unavailable or truncated instead of guessing what it contained.
- Otherwise use the supplied status facts.

Write the advice in Simplified Chinese, the console language.
