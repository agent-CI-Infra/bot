# Component Reference

All examples below are passed inside the `card` argument of `set_feishu_card`.

## Header and Metrics Row

```json
{
  "config": { "width_mode": "fill" },
  "header": {
    "title": "Section Title",
    "subtitle": "Optional concise context",
    "template": "blue",
    "text_tag_list": [{ "text": "Live", "color": "turquoise" }]
  },
  "elements": [
    {
      "tag": "column_set",
      "flex_mode": "bisect",
      "horizontal_spacing": "small",
      "columns": [
        {
          "tag": "column",
          "width": "weighted",
          "weight": 1,
          "background_style": "grey-100",
          "padding": "8px",
          "elements": [{ "tag": "markdown", "content": "**Metric A**\n12" }]
        },
        {
          "tag": "column",
          "width": "weighted",
          "weight": 1,
          "background_style": "grey-100",
          "padding": "8px",
          "elements": [{ "tag": "markdown", "content": "**Metric B**\n98.5%" }]
        }
      ]
    }
  ]
}
```

## Native Scrollable/Paginated Table (`table`)

Place `table` directly in root `elements` or top-level `view.elements` (never inside `column_set` or `collapsible_panel`).

- `page_size`: integer `1..10` (default `5`). When `rows.length > page_size`, Feishu renders native client-side pagination/scrolling.
- `row_height`: `"low"` (default), `"middle"`, `"high"`, `"auto"`, or pixel height in `"32px"`..`"124px"`.
- `freeze_first_column`: `true` freezes the first column when columns scroll horizontally.
- `columns[].width`: `"auto"`, pixel width in `"80px"`..`"600px"`, or percentage `"1%"`..`"100%"` (values outside range are clamped).
- `header_style`: `background_style` accepts `"none"` or `"grey"`; `text_size` accepts `"normal"` or `"heading"`; `text_color` accepts `"default"` or `"grey"`.
- `data_type`: `"text"`, `"lark_md"` (links & inline formatting), `"options"` (colored badges; use `"neutral"` for gray pills), `"number"`, or `"date"` (ms timestamp or ISO string).

```json
{
  "tag": "table",
  "page_size": 5,
  "row_height": "low",
  "freeze_first_column": true,
  "columns": [
    { "name": "item", "display_name": "Item", "data_type": "lark_md", "width": "auto" },
    { "name": "state", "display_name": "State", "data_type": "options", "width": "100px" },
    { "name": "count", "display_name": "Count", "data_type": "number", "width": "80px" }
  ],
  "rows": [
    { "item": "[Example](https://github.com/org/repo)", "state": [{ "text": "Active", "color": "green" }], "count": 4 }
  ]
}
```

## VChart Visualization (`chart`)

Use `tag: "chart"` with a valid VChart `chart_spec` (supported types include `bar`, `line`, `area`, `pie`, `scatter`, `radar`, `funnel`, `linearProgress`, `circularProgress`).

Mobile compatibility rules enforced by the control plane:
- Do **not** use `texture`, `gradient: "conical"`, `layoutMode: "grid"`, `repeatX`, `repeatY`, SVG strings, or JS callbacks.
- Keep datasets concise so the rendered card stays under 28 KB.

```json
{
  "tag": "chart",
  "aspect_ratio": "16:9",
  "color_theme": "brand",
  "preview": true,
  "chart_spec": {
    "type": "bar",
    "title": { "text": "Distribution" },
    "data": { "values": [{ "category": "A", "value": 14 }, { "category": "B", "value": 9 }] },
    "xField": "category",
    "yField": "value"
  }
}
```

## Collapsible Details and Link Buttons

- Use `collapsible_panel` (`expanded: false` by default) to tuck away secondary details, caveats, or verbose explanations.
- Use `button` with `url` (or `behaviors: [{ type: "open_url", default_url }]`) for safe `http(s)` links. Raw `callback` payloads and `img_key` are rejected.
