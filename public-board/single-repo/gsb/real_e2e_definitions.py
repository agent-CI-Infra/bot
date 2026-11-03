"""Public Real E2E case descriptions from ScienceDiscovery test E2E-META.

The run's journey report wins when available. These definitions cover older
score artifacts that lack an attached report; they describe the test contract,
not what happened in one execution. Checked against the ScienceDiscovery
test sources at 5de0ff59 and the release test definitions at fd8c919e.
"""

CASES = {
    "deepresearchbench": {
        "spec": "test/deepresearchbench-swarm.spec.ts",
        "preconditions": ["live generator", "isolated Swarm stack", "configured judges and source access"],
        "metadata": {
            "type": "real",
            "model": "Live generator plus independently configurable cleaner/RACE/FACT judges.",
            "credentials": "E2E_API_TOKEN; E2E_LLM_MODEL_ID or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN; Judge credentials and JINA_API_KEY.",
            "cost_side_effects": "Billable research and Judge calls; temporary application records deleted, local evaluation artifacts retained.",
        },
    },
    "biomnibench": {
        "spec": "test/biomnibench-da-swarm.spec.ts",
        "preconditions": ["isolated Swarm", "pinned input data", "Python scientific stack"],
        "metadata": {
            "type": "real",
            "model": "Real configured generator and optional separately configured rubric judge.",
            "credentials": "E2E_API_TOKEN; E2E_LLM_MODEL_ID or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN; optional BIOMNI_JUDGE_API_KEY.",
            "cost_side_effects": "Billable model calls; temporary projects and sessions; retained test diagnostics and reports. Not a PR gate.",
        },
    },
    "research-team": {
        "spec": "test/science-research-team-real.spec.ts",
        "goal": "Complete dual-domain research through the built-in team plus a custom delivery reviewer",
        "preconditions": ["Real LLM and Swarm", "Five built-in roles", "Live literature MCP", "Local HTTP signoff tool"],
        "metadata": {
            "type": "real",
            "model": "Configured real generator for main and children, plus independent read-only rubric Judge.",
            "credentials": "E2E_API_TOKEN and E2E_LLM_MODEL_ID or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN.",
            "cost_side_effects": "Billable LLM calls; isolated temporary project, model, Specialist, skill and MCP server; private traces retained.",
        },
    },
    "evolve-compression": {
        "spec": "test/evolve-compression-real.spec.ts",
        "goal": "Complete the documented PUCT compression task and report its own final score",
        "preconditions": ["Real model", "Working sandbox, Python environment and evolve sidecar"],
        "metadata": {
            "type": "real",
            "model": "Real configured model designs the evaluator and generates search candidates.",
            "credentials": "E2E_API_TOKEN and E2E_LLM_MODEL_ID or E2E_LLM_BASE_URL/E2E_LLM_MODEL/E2E_LLM_TOKEN.",
            "cost_side_effects": "Billable model calls and sandbox evaluations; temporary project, session and model; retained score and artifacts.",
        },
    },
}


def definition(case, family):
    if not isinstance(case, str):
        return None
    item = CASES.get(family)
    if not item:
        return None
    if family == "deepresearchbench" and case.startswith("DRB-") and case[4:].isdigit():
        goal = f"Research {case} and evaluate both delivery and report quality."
    elif family == "biomnibench" and case.startswith("BiomniBench-"):
        goal = f"Execute {case.removeprefix('BiomniBench-')} with real data and a real LLM."
    elif family == "research-team" and case == "TC-E2E-01":
        goal = item["goal"]
    elif family == "evolve-compression" and case == "PUCT-COMPRESS":
        goal = item["goal"]
    else:
        return None
    return {"source": "source-definition", "spec": item["spec"], "goal": goal,
            "preconditions": list(item["preconditions"]),
            "step_summary": "当前没有读取到该次运行的独立用户步骤记录。", "steps": [],
            "metadata": dict(item["metadata"])}


def combine(case, family, report):
    fallback = definition(case, family)
    if not report:
        return fallback
    if not fallback:
        return report
    metadata = {**fallback["metadata"], **report.get("metadata", {})}
    used_fallback = any(not report.get(key) for key in ("goal", "preconditions")) or metadata != report.get("metadata", {})
    return {**fallback, **report,
            "goal": report.get("goal") or fallback["goal"],
            "preconditions": report.get("preconditions") or fallback["preconditions"],
            "metadata": metadata,
            "source": "run-report+source-definition" if used_fallback else "run-report"}
