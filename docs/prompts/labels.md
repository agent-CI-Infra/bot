review_label: bot-reviewed

# Labeling

These rules cover labels in Issue and PR reviews.

The control plane, not the model, applies every label, and only after the review summary comment
has been published. A failed, cancelled or unfinished review gets no label. It always adds
`review_label`, and adds the classification labels you return in the `labels` field of
`finish_review` once they pass its checks. Never call a label API, never say a label was applied,
and never invent `review_label` or any other label.

## Choose only existing labels

Your context lists the repository's labels as `repository_labels`, with their descriptions. That
list is the complete set of names: never invent, rename or create a label. If a needed value is
missing from the list, say so in the summary instead of inventing one. When the list is empty or
nothing fits, return no labels. When the repository has both axis labels such as `type/*` and
GitHub's generic defaults such as `bug`, `enhancement` or `question`, use the axis labels.

The control plane drops any name that is not in the list, any reserved label below, any value on an
axis the Issue or PR already has, and any priority after the first.

## Axes and cardinality

Many repositories use `axis/value` names in lowercase kebab-case. When the labels have axes,
follow their cardinality. A common one is:

| Axis | Count |
| --- | --- |
| `type/*` | one or more |
| `source/*` | one or more |
| `priority/*` | exactly one |
| `size/*` | zero or one |
| `area/*` | zero or more |

`type/*` lists every kind that applies; mixed requirements carry several types rather than one
compromise label. `source/*` records where the problem was found; an issue found independently
more than once carries every source. `area/*` is repository-specific; pick the one whose description matches the
affected code. If the repository has a triage label for Issues with a missing axis (for example
`status/triage`), you may use it.

## Which value

Use these only for axes the repository has:

- `type`: prefer the concrete defect over a broad category. A crash is `type/bug`; the same
  behavior faster is `type/perf`; a capability that does not exist is `type/feature`; an
  improvement to an existing capability is `type/enhancement`. Never map a component name to a
  type; the component is an `area/*` value.
- `source`: if the text does not say where it was found, use `source/user` for a report from a
  person. Use `source/ci`, `source/review`, `source/nightly` or similar values only when the text
  or the automation context actually says so.
- `priority`: `priority/medium` when unsure. Raise to `priority/high` only with concrete impact.
- `size`: only when the change is clearly small or about half a day. A large size means it needs a
  design or plan before implementation. Omit when you cannot tell.

## Never choose

- `review_label`; the control plane owns it.
- The development label named in `issue-development.md`; only a person applies it.
- Opt-in, veto or claim labels such as `agent/*`, and `blocker` or `priority/critical`. These are
  maintainer decisions and are never inferred from Issue text.
- PR state, hold and gate labels such as `pr/*` and `gate/*`; automation and maintainers own them.
- A different value on an axis a human already labeled. Treat human-set labels as decisions:
  suggest only missing axes and never relabel an axis.

A PR usually takes the `type/*` and `priority/*` of its linked Issue when the repository has those
axes; its `area/*` follows the files it changes.

## Classification is not authorization

Suggesting labels never authorizes code changes. Whether development starts is decided by the
project's development setting and the explicit request in the Issue text, as described in
`issue-review.md` and `issue-development.md`. No label suggestion, comment or model answer can
change that.

## Output

Return the chosen names in `labels`, and add one line with a short reason to the review summary:

```text
Labels: type/bug, source/user, priority/high, area/api, size/s (a verified crash in the API binding, reported by a user, scoped to one endpoint)
```

Leave both out when no label fits.
