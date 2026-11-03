"""Source-tagged tests: tag dimensions, CI profile combinations and coverage.

Each layer's results artifact from the source CI holds the harness's frozen
files under ``<slice>/tagged/``: ``catalog.json`` lists every collected case
with its tags, ``plan.json`` the selector, targets and profile one slice ran,
and ``summary.json`` how that plan executed. Every profile uses the slice's
own directory, so the profile is read from ``plan.json``.

Selection mirrors the harness: absent groups take the schema default, platform
tags expand into one instance per target, and the selector is evaluated on
that instance. Cases with equal tags are selected alike, so the view works on
tag signatures.
"""
from __future__ import annotations

from collections import Counter
import json
import re

SLICES = ("ut", "st", "e2e")
PROFILES = ("pr", "daily", "release")
PLATFORM = ("os", "arch")
SCHEMA_PATH = "test/support/tagged/schema.json"
PLAN_RE = re.compile(r"(?:^|/)(ut|st|e2e)/tagged/plan\.json$")
TAG_RE = re.compile(r"[a-z]+:[a-z0-9]+\Z")
TOKEN_RE = re.compile(r"\s*(\(|\)|\band\b|\bor\b|\bnot\b|[a-z]+:[a-z0-9]+)")
MAX_FILE = 32 * 1024 * 1024
UNCOVERED_LIMIT = 300


def _read(archive, name):
    try:
        info = archive.getinfo(name)
    except KeyError:
        return None
    if info.file_size > MAX_FILE:
        return None
    try:
        return json.loads(archive.read(info).decode("utf-8"))
    except ValueError:
        return None


def _targets(value):
    targets = []
    for target in value if isinstance(value, list) else []:
        if isinstance(target, dict) and all(isinstance(target.get(k), str) and re.fullmatch(r"[a-z0-9]+", target[k]) for k in PLATFORM):
            targets.append({"os": target["os"], "arch": target["arch"]})
    return targets


def _result(summary):
    if not isinstance(summary, dict):
        return None
    out: dict = {"status": str(summary.get("status") or "")[:20]}
    for key in ("planned", "executed", "passed", "failed", "skipped"):
        value = summary.get(key)
        out[key] = value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None
    return out


def extract(archive):
    """Every profile slice frozen in one results archive; plans without a CI
    profile (ad-hoc tag queries) are skipped."""
    found = []
    for name in archive.namelist():
        match = PLAN_RE.search(name)
        if not match:
            continue
        part = match.group(1)
        base = name[: -len("plan.json")]
        plan, catalog = _read(archive, base + "plan.json"), _read(archive, base + "catalog.json")
        if not isinstance(plan, dict) or not isinstance(catalog, list):
            continue
        profile = plan.get("profile")
        if profile not in PROFILES:
            continue
        signatures, sources, cases = {}, {}, []
        for case in catalog:
            tags = case.get("tags") if isinstance(case, dict) else None
            if not isinstance(case.get("id") if isinstance(case, dict) else None, str) or not isinstance(tags, list) \
                    or not all(isinstance(tag, str) and TAG_RE.match(tag) for tag in tags):
                continue
            signature = signatures.setdefault(tuple(sorted(set(tags))), len(signatures))
            source = sources.setdefault(str(case.get("source") or "")[:300], len(sources))
            cases.append([case["id"][:500], signature, source])
        found.append({"profile": profile, "slice": part, "revision": str(plan.get("revision") or "")[:64],
                      "selector": str(plan.get("selector") or "")[:4000], "targets": _targets(plan.get("targets")),
                      "planned": len(plan.get("entries") or []), "result": _result(_read(archive, base + "summary.json")),
                      "signatures": [list(tags) for tags in signatures], "sources": list(sources), "cases": cases})
    return found


def schema_groups(text):
    """Group rules from the source's closed vocabulary, or None when unreadable."""
    try:
        groups = json.loads(text).get("groups")
    except (ValueError, AttributeError, TypeError):
        return None
    if not isinstance(groups, dict):
        return None
    out = {}
    for name, rule in groups.items():
        if isinstance(rule, dict) and isinstance(rule.get("values"), list):
            out[name] = {"multiple": bool(rule.get("multiple")), "values": [str(v) for v in rule["values"]],
                         "default": rule.get("default")}
    return out or None


def normalize(tags, groups):
    """Apply schema defaults to groups a declaration leaves out, as the harness does."""
    present = {tag.split(":", 1)[0] for tag in tags}
    extra = [f"{name}:{rule['default']}" for name, rule in (groups or {}).items()
             if name not in present and rule.get("default") is not None]
    return tuple(sorted(set(tags) | set(extra)))


def parse_selector(expression):
    """AST for the harness grammar: tag, parentheses, not, and, or."""
    tokens, offset = [], 0
    while offset < len(expression) and expression[offset:].strip():
        match = TOKEN_RE.match(expression, offset)
        if not match:
            raise ValueError("invalid selector")
        tokens.append(match.group(1))
        offset = match.end()
    if not tokens:
        return None
    position = 0

    def unary():
        nonlocal position
        token = tokens[position] if position < len(tokens) else None
        position += 1
        if token == "not":
            return ("not", unary())
        if token == "(":
            node = either()
            if position >= len(tokens) or tokens[position] != ")":
                raise ValueError("missing closing parenthesis")
            position += 1
            return node
        if token is None or not TAG_RE.match(token):
            raise ValueError("expected a tag")
        return ("tag", token)

    def both():
        nonlocal position
        node = unary()
        while position < len(tokens) and tokens[position] == "and":
            position += 1
            node = ("and", node, unary())
        return node

    def either():
        nonlocal position
        node = both()
        while position < len(tokens) and tokens[position] == "or":
            position += 1
            node = ("or", node, both())
        return node

    tree = either()
    if position != len(tokens):
        raise ValueError("unexpected selector token")
    return tree


def matches(tree, tags):
    if tree is None:
        return True
    kind = tree[0]
    if kind == "tag":
        return tree[1] in tags
    if kind == "not":
        return not matches(tree[1], tags)
    if kind == "and":
        return matches(tree[1], tags) and matches(tree[2], tags)
    return matches(tree[1], tags) or matches(tree[2], tags)


def instances(tags, targets):
    """One concrete tag set per target the case supports, as the harness plans it."""
    rest = [tag for tag in tags if tag.split(":", 1)[0] not in PLATFORM]
    for target in targets:
        if f"os:{target['os']}" in tags and f"arch:{target['arch']}" in tags:
            yield frozenset([*rest, f"os:{target['os']}", f"arch:{target['arch']}"])


def rules(tree):
    """Disjunctive rows ``{group: values}`` for display; None when a ``not`` is involved."""
    if tree is None:
        return [{}]
    kind = tree[0]
    if kind == "tag":
        group, value = tree[1].split(":", 1)
        return [{group: frozenset([value])}]
    if kind == "not":
        return None
    left, right = rules(tree[1]), rules(tree[2])
    if left is None or right is None:
        return None
    if kind == "or":
        return left + right
    rows = []
    for a in left:
        for b in right:
            row = dict(a)
            for group, values in b.items():
                row[group] = row[group] & values if group in row else values
            if all(row.values()):
                rows.append(row)
    return rows


def merge_rules(rows):
    """Fold rows that differ in one group back into ``group in {a, b}`` form."""
    rows = [dict(row) for row in rows]
    changed = True
    while changed:
        changed = False
        for i in range(len(rows)):
            for j in range(i + 1, len(rows)):
                a, b = rows[i], rows[j]
                if a.keys() != b.keys():
                    continue
                differ = [group for group in a if a[group] != b[group]]
                if len(differ) <= 1:
                    if differ:
                        a[differ[0]] = a[differ[0]] | b[differ[0]]
                    del rows[j]
                    changed = True
                    break
            if changed:
                break
    return rows


PR_EVENTS = ("pull_request", "pull_request_target")


class TaggedStore:
    """Per branch: latest profile runs and the latest catalog, kept in ``.sync/tagged.json``.

    Only pushes, dispatches and schedules on a configured branch state what that
    branch's policy and catalog are; a PR branch may edit its own policy. Version
    tags are held to the default branch's release profile.
    """

    def __init__(self, state=None):
        state = state or {}
        self.changed = False
        if "lines" not in state:
            # Version 1 held the default branch only; its catalog or non-release
            # profile runs name that branch.
            runs = [(state.get("catalog") or {}).get("run")] + [
                entry.get("run") for name, entry in (state.get("profiles") or {}).items() if name != "release"]
            branch = next((run["branch"] for run in runs if run and run.get("branch")), None)
            lines = {branch: {key: state.get(key) for key in ("profiles", "catalog", "schema")}} if branch else {}
            state, self.changed = {"version": 2, "lines": lines}, bool(state)
        self.state = state

    def _line(self, ref):
        return self.state["lines"].setdefault(ref, {"profiles": {}, "catalog": None, "schema": None})

    def observe(self, run, slices, default_branch, refs=()):
        """Record one run's slices; later calls for the same run add slices it lacked."""
        meta = {key: run.get(key) for key in ("id", "attempt", "url", "created_at", "branch", "event")}
        for slice_ in slices:
            profile = slice_["profile"]
            if profile == "release":
                ref = default_branch
            elif run.get("event") not in PR_EVENTS and run.get("branch") in {default_branch, *refs}:
                ref = run["branch"]
            else:
                continue
            line = self._line(ref)
            plan = {k: slice_[k] for k in ("revision", "selector", "targets", "planned", "result")}
            self._put(line["profiles"], profile, meta, slice_["slice"], plan)
            if profile != "release":
                self._put(line, "catalog", meta, slice_["slice"],
                          {**plan, **{k: slice_[k] for k in ("signatures", "sources", "cases")}})

    def _put(self, holder, key, meta, part, value):
        current = holder.get(key)
        newer = not current or (meta["created_at"] or "", meta["id"] or 0) > (current["run"]["created_at"] or "", current["run"]["id"] or 0)
        if not newer and current["run"]["id"] != meta["id"]:
            return
        if newer and (not current or current["run"]["id"] != meta["id"]):
            current = holder[key] = {"run": meta, "slices": {}}
        if current["slices"].get(part) != value or current["run"] != meta:
            current["run"] = meta
            current["slices"][part] = value
            self.changed = True

    def refresh_schema(self, fetch, repo):
        """Read each branch's vocabulary at its catalog revision once; keep the last good copy on failure."""
        for line in self.state["lines"].values():
            revisions = {part["revision"] for part in (line.get("catalog") or {}).get("slices", {}).values() if part.get("revision")}
            if not revisions:
                continue
            revision = sorted(revisions)[0]
            if (line.get("schema") or {}).get("revision") == revision:
                continue
            groups = schema_groups(fetch(repo, SCHEMA_PATH, revision) or "")
            if groups:
                line["schema"] = {"revision": revision, "groups": groups}
                self.changed = True

    def view(self, ref):
        return build_view(self.state["lines"].get(ref) or {})


def _label(groups, group, values):
    return "/".join(sorted(values, key=lambda v: (groups.get(group, {}).get("values", []) + [v]).index(v)))


def build_view(state):
    """Dimensions, profile rules and coverage on the latest default-branch catalog."""
    catalog = (state or {}).get("catalog")
    if not catalog or not catalog.get("slices"):
        return None
    groups = ((state.get("schema") or {}).get("groups")) or {}
    cases = {}
    for part in catalog["slices"].values():
        for ident, signature, source in part["cases"]:
            if ident not in cases:
                cases[ident] = (normalize(part["signatures"][signature], groups), part["sources"][source])
    by_tags = {}
    for ident, (tags, source) in cases.items():
        by_tags.setdefault(tags, []).append((ident, source))
    order = list(groups) + sorted({tag.split(":", 1)[0] for tags in by_tags for tag in tags} - set(groups))

    rank = lambda group, value: (groups.get(group, {}).get("values", []) + [value]).index(value)
    profiles, covered_by, rows_of = [], {}, {}
    for name in PROFILES:
        run = (state.get("profiles") or {}).get(name)
        if not run:
            profiles.append({"name": name, "run": None})
            continue
        try:
            parsed = [(parse_selector(part["selector"]), part["targets"]) for part in run["slices"].values()]
        except ValueError:
            profiles.append({"name": name, "run": run["run"], "error": "selector"})
            continue
        rows = [rules(tree) for tree, _ in parsed]
        merged = merge_rules([row for part in rows for row in part]) if all(r is not None for r in rows) else None
        chosen = {tags for tags in by_tags
                  if any(matches(tree, instance) for tree, targets in parsed for instance in instances(tags, targets))}
        covered_by[name] = chosen
        if merged is not None:
            rows_of[name] = merged
        profiles.append({
            "name": name, "run": run["run"], "slices": sorted(run["slices"]),
            "revisions": sorted({part["revision"] for part in run["slices"].values() if part.get("revision")}),
            # Ordered [group, values] pairs: published JSON sorts object keys.
            "rules": None if merged is None else [[[g, sorted(v, key=lambda x, g=g: rank(g, x))]
                                                   for g, v in sorted(row.items(), key=lambda kv: order.index(kv[0]) if kv[0] in order else len(order))]
                                                  for row in merged],
            "selectors": {part: value["selector"] for part, value in run["slices"].items()},
            "targets": sorted({f"{t['os']}/{t['arch']}" for part in run["slices"].values() for t in part["targets"]}),
            "results": {part: value.get("result") for part, value in run["slices"].items()},
            "covered": sum(len(by_tags[tags]) for tags in chosen)})
    for profile in profiles:
        # Identical rule rows are one policy, as release is defined as daily today.
        same = next((p["name"] for p in profiles if p is not profile and p.get("rules") and p.get("rules") == profile.get("rules")
                     and PROFILES.index(p["name"]) < PROFILES.index(profile["name"])), None)
        if same:
            profile["same_as"] = same
    union = set().union(*covered_by.values()) if covered_by else set()

    def blocking(tags):
        # The fewest groups that keep this signature out of any profile row.
        best = None
        values = {}
        for tag in tags:
            group, value = tag.split(":", 1)
            values.setdefault(group, set()).add(value)
        for rows in rows_of.values():
            for row in rows:
                missing = [g for g, allowed in row.items() if not values.get(g, set()) & set(allowed)]
                if best is None or len(missing) < len(best):
                    best = missing
        if not best:
            return "未命中任何组合"
        return "；".join(f"{g}={_label(groups, g, values.get(g, {'—'}))}" for g in best)

    dimensions = []
    for group in order:
        rule = groups.get(group, {})
        seen = sorted({tag.split(":", 1)[1] for tags in by_tags for tag in tags if tag.startswith(group + ":")})
        values = rule.get("values", []) + [v for v in seen if v not in rule.get("values", [])]
        rows = []
        for value in values:
            tag = f"{group}:{value}"
            total = sum(len(v) for tags, v in by_tags.items() if tag in tags)
            reached = sum(len(v) for tags, v in by_tags.items() if tag in tags and tags in union)
            takes = {}
            for profile in profiles:
                # "any" is a group the profile leaves unconstrained, not a value it names.
                chosen = rows_of.get(profile["name"])
                takes[profile["name"]] = None if chosen is None else "yes" if any(value in row.get(group, ()) for row in chosen) \
                    else "any" if any(group not in row for row in chosen) else "no"
            rows.append({"value": value, "cases": total, "covered": reached, "profiles": takes})
        dimensions.append({"group": group, "multiple": rule.get("multiple"), "default": rule.get("default"),
                           "vocabulary": len(rule.get("values", [])) or None, "used": sum(1 for r in rows if r["cases"]),
                           "values": rows})

    combos = []
    for tags, members in sorted(by_tags.items(), key=lambda item: (-len(item[1]), item[0])):
        combos.append({"tags": list(tags), "cases": len(members),
                       "profiles": {p["name"]: (tags in covered_by[p["name"]]) if p["name"] in covered_by else None for p in profiles},
                       "reason": None if tags in union else blocking(tags)})
    reasons = Counter()
    uncovered = []
    for combo in combos:
        if combo["reason"] is None:
            continue
        reasons[combo["reason"]] += combo["cases"]
        for ident, source in sorted(by_tags[tuple(combo["tags"])]):
            uncovered.append({"id": ident, "source": source, "reason": combo["reason"]})
    uncovered.sort(key=lambda row: (-reasons[row["reason"]], row["reason"], row["id"]))

    # The frozen plans are the harness's own answer; flag any drift from ours.
    checks = []
    for part_name, part in sorted(catalog["slices"].items()):
        try:
            tree = parse_selector(part["selector"])
        except ValueError:
            checks.append({"slice": part_name, "planned": part["planned"], "computed": None})
            continue
        own = {ident: normalize(part["signatures"][sig], groups) for ident, sig, _ in part["cases"]}
        computed = sum(1 for tags in own.values() for instance in instances(tags, part["targets"]) if matches(tree, instance))
        checks.append({"slice": part_name, "planned": part["planned"], "computed": computed})
    return {"catalog": {"run": catalog["run"], "slices": sorted(catalog["slices"]),
                        "revision": sorted({p["revision"] for p in catalog["slices"].values() if p.get("revision")}),
                        "missing": [s for s in SLICES if s not in catalog["slices"]]},
            "schema": {"revision": (state.get("schema") or {}).get("revision"), "known": bool(groups)},
            "cases": len(cases), "signatures": len(by_tags), "profiles": profiles, "dimensions": dimensions,
            "covered": sum(len(by_tags[tags]) for tags in union),
            "uncovered": {"cases": len(cases) - sum(len(by_tags[tags]) for tags in union),
                          "reasons": [{"reason": r, "cases": n} for r, n in reasons.most_common()],
                          "items": uncovered[:UNCOVERED_LIMIT]},
            "combinations": combos, "checks": checks}
