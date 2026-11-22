---
name: feishu-cards
description: Decide when to reply in Feishu with a general-purpose Card JSON 2.0 via set_feishu_card instead of default Markdown post, and design clear static or interactive cards using tables, VChart charts, multi-column layouts, collapsible panels, switchable views, paginated/filterable lists and follow-up actions.
---

# Feishu Rich & Interactive Cards (Card JSON 2.0)

`set_feishu_card` is a general-purpose Feishu presentation capability for any topic or workflow. It is **not** bound to a specific report type or layout, and you are **never** required to send a card.

## When to Use Markdown (`post`) vs `set_feishu_card`

- **Keep default Markdown (`post`)** for short answers, back-and-forth questions, code explanations, error stack traces, and prose where a card frame would only add noise.
- **Choose `set_feishu_card`** when visual hierarchy, structured data, charts, or in-card interaction genuinely improves scanning and usability — for example:
  - Multi-dimensional summaries or status comparisons (`header` + `column_set` + `table`)
  - Structured datasets with status badges, links, numeric/date formatting, or horizontal scroll (`table`)
  - Quantitative trends or distributions (`chart` using VChart)
  - Long or multi-category information that would otherwise flood chat (`collapsible_panel`, `views`, or `paginated_list`)
  - Replies where a quick follow-up trigger (such as refreshing live data or drilling down) is genuinely useful (`actions`)

## Core Design Principles

1. **General-purpose composition**: Pick only the components that serve the content. A concise two-section card beats a cluttered dashboard.
2. **Prefer client-side interaction in group chats**: Feishu Card JSON 2.0 only supports shared cards (`update_multi: true`), so clicking server-managed `views` or `paginated_list` switches the card for **everyone** in a group chat. When group-chat content fits under 28 KB and does not need dropdown filters, prefer pure client-side components — `collapsible_panel` (local expand/collapse), native `table` with `page_size: 5..10` (local client pagination for up to 100 rows), and `chart` — which update locally with zero latency and never disrupt other readers. Use `views` and `paginated_list` for private chats, datasets that exceed the 28 KB single-view budget, or when interactive dropdown filtering or shared view switching is genuinely useful.
3. **Use `width_mode: "fill"` for wide layouts**: Cards with `table`, `chart`, `column_set`, `views` or `paginated_list` automatically default to `"fill"`; keep `"default"` or `"compact"` for narrow summaries.
4. **Respect Feishu Card JSON 2.0 hard limits**:
   - Serialized card payload must stay under **28 KB** (Feishu enforces 30 KB) and **190 elements** (Feishu enforces 200).
   - `table` and `paginated_list` MUST sit at the **root** of `elements` (or top level of a `view.elements`), never nested inside `column_set`, `collapsible_panel`, or `interactive_container`.
   - At most **5 `table`** and **5 `chart`** components per rendered view; container nesting depth at most **5**.
   - Interactive cards remain updatable for **14 days** (Feishu platform limit).
5. **Security & truthfulness**:
   - Only `http(s)` or console relative links are allowed; never invent `img_key` or raw callback payloads.
   - Never fabricate metrics, counts, or statuses to fill out a visual template.
   - Always finish your turn with a concise plain-text summary (used as fallback if Feishu rejects the card and recorded in conversation history).

## Reference Guides

- Component syntax, `table` column types, and mobile-safe VChart `chart` recipes: [Component Reference](references/components.md)
- Switchable `views`, filterable `paginated_list`, and controlled `actions`: [Interactive Patterns](references/interactive-patterns.md)
