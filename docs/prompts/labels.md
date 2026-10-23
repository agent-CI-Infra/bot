review_label: bot-reviewed

# Labeling

These rules cover labels in Issue and PR reviews.

The control plane, not the model, applies `review_label`: it adds that one label only after the
review summary comment has been published. A failed, cancelled or unfinished review gets no label.
Never call a label API, never say a label was applied, and never invent `review_label` or any
other label.

## Suggest only declared labels

Label suggestions are part of the review text; they change nothing on GitHub by themselves.
Suggest labels only when the repository declares a label manifest, for example a `LABELING.md` or
a label list in its contributor docs. That manifest is the complete set of names: never invent,
rename or create a label, and never fall back to GitHub's default labels. If a needed value is
missing from the manifest, say so instead of inventing one. Without a manifest, suggest no labels.

## Axes and cardinality

Many manifests use `axis/value` names in lowercase kebab-case. When the manifest declares axes,
follow its cardinality. A common one is:

| Axis | Count |
| --- | --- |
| `type/*` | one or more |
| `source/*` | one or more |
| `priority/*` | exactly one |
| `size/*` | zero or one |
| `area/*` | zero or more |

`type/*` lists every kind that applies; mixed requirements carry several types rather than one
compromise label. `source/*` records where the problem was found; an issue found independently
more than once carries every source. `area/*` is repository-specific and comes from the manifest.
If the manifest marks Issues with a missing axis for triage (for example `status/triage`), you may
suggest that label.

## Which value

Use these only for axes the manifest declares:

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

## Never suggest

- `review_label`; the control plane owns it.
- Opt-in, veto or claim labels such as `agent/*`, and `blocker` or `priority/critical`. These are
  maintainer decisions and are never inferred from Issue text.
- PR state, hold and gate labels such as `pr/*` and `gate/*`; automation and maintainers own them.
- A different value on an axis a human already labeled. Treat human-set labels as decisions:
  suggest only missing axes and never relabel an axis.

A PR usually inherits `type/*` and `priority/*` from its linked Issue when the manifest declares
those axes.

## Classification is not authorization

Suggesting labels never authorizes code changes. Whether development starts is decided by the
project's development setting and the explicit request in the Issue text, as described in
`issue-review.md` and `issue-development.md`. No label suggestion, comment or model answer can
change that.

## Output

When the repository has a label manifest, put the suggestion and one short reason in the review
summary:

```text
Suggested labels: type/bug, source/user, priority/high, area/api, size/s
Reason: A verified crash in the API binding, reported by a user, scoped to one endpoint.
```

Leave this out when the repository declares no labels.
