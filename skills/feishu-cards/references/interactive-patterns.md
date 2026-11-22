# Interactive Patterns

The control plane manages all interactive callbacks with opaque server-issued tokens and re-checks chat and authorization fences on every click. Never write raw `callback` behaviors on buttons.

> **Shared-card note (Feishu Card JSON 2.0)**: Card JSON 2.0 enforces `update_multi: true`, meaning `views` and `paginated_list` updates apply to **all viewers** in a group chat. In group chats, prefer client-side `collapsible_panel` and native `table` pagination (`page_size: 5..10`) whenever the data fits under 28 KB and does not require dropdown filtering; use `views` and `paginated_list` for private chats, larger multi-section payloads, or interactive filtering.

## 1. Switchable Views (`views`)

Use `views` (2–10 named views) whenever information naturally splits into sections or perspectives (for example overview vs details, per-category tabs, or table vs chart). Shared `elements` appear above the switcher; each view gets its own 28 KB / 190-element budget.

```json
{
  "header": { "title": "Multi-view Summary", "template": "indigo" },
  "elements": [{ "tag": "markdown", "content": "Shared context visible in every view." }],
  "default_view": "summary",
  "views": [
    {
      "id": "summary",
      "label": "Overview",
      "elements": [{ "tag": "markdown", "content": "Key highlights here." }]
    },
    {
      "id": "chart",
      "label": "Trend",
      "elements": [
        {
          "tag": "chart",
          "aspect_ratio": "16:9",
          "chart_spec": {
            "type": "line",
            "data": { "values": [{ "x": "D1", "y": 3 }, { "x": "D2", "y": 7 }] },
            "xField": "x",
            "yField": "y"
          }
        }
      ]
    }
  ]
}
```

## 2. Paginated and Filterable Lists (`paginated_list`)

When you have more items than fit comfortably in one static table (up to 200 items) or want interactive dropdown filters, use a root-level `paginated_list` block. The server stores all items and renders only the active page plus filter dropdowns and Previous/Next controls.

- `display: "table"` renders each page as a Feishu `table` using `columns`.
- `display: "items"` renders each entry as formatted markdown with optional `title`, `badges`, and a link button (`url` + `link_label`).
- `filters` accepts up to 3 filter dimensions (`{ field, label, options? }`).

```json
{
  "tag": "paginated_list",
  "id": "entries",
  "title": "Detailed Entries",
  "display": "table",
  "page_size": 5,
  "freeze_first_column": true,
  "filters": [{ "field": "status", "label": "Status" }],
  "columns": [
    { "name": "name", "display_name": "Name", "data_type": "lark_md" },
    { "name": "status", "display_name": "Status", "data_type": "options", "width": "100px" }
  ],
  "items": [
    { "name": "[Item 1](https://github.com/org/repo/issues/1)", "status": [{ "text": "Open", "color": "blue" }] },
    { "name": "[Item 2](https://github.com/org/repo/issues/2)", "status": [{ "text": "Done", "color": "green" }] }
  ]
}
```

## 3. Controlled Follow-up Actions (`actions`)

Use `actions` (up to 4 buttons) to offer explicit follow-up triggers such as refreshing live data or requesting a drill-down. Each action carries a short, transparent `prompt` (at most 300 characters) and optional `confirm` dialog; clicking runs a standard turn attributed to the clicking user under current permissions.

```json
{
  "actions": [
    {
      "id": "refresh",
      "label": "Refresh latest data",
      "type": "primary",
      "prompt": "Re-query the latest live data for the previous summary and send an updated card."
    }
  ]
}
```
