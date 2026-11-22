import type { Row, Store } from '../storage/database.js';
import { fail, HttpError, randomId, type Json } from '../core/security.js';
import { cardText } from './format.js';

export const feishuCardToolName = 'set_feishu_card';
export const feishuCardMaxBytes = 28_000;
export const feishuCardMaxElements = 190;
export const feishuCardMaxSpecBytes = 256 * 1024;
export const feishuCardTtlMs = 14 * 24 * 3600_000;

const headerTemplates = new Set([
  'blue', 'wathet', 'turquoise', 'green', 'yellow', 'orange', 'red', 'carmine',
  'violet', 'purple', 'indigo', 'grey', 'default',
]);
const tagColors = new Set([
  'neutral', 'blue', 'turquoise', 'lime', 'orange', 'violet', 'indigo', 'wathet',
  'green', 'yellow', 'red', 'purple', 'carmine', 'grey',
]);
const widthModes = new Set(['default', 'fill', 'compact']);
const buttonTypes = new Set([
  'default', 'primary', 'danger', 'primary_filled', 'danger_filled',
  'primary_text', 'danger_text', 'laser', 'text',
]);
const buttonSizes = new Set(['tiny', 'small', 'medium', 'large']);
const flexModes = new Set(['none', 'stretch', 'flow', 'bisect', 'trisect']);
const alignValues = new Set(['left', 'center', 'right']);
const vAlignValues = new Set(['top', 'center', 'bottom']);
const spacingValues = new Set(['small', 'medium', 'large', 'extra_large', 'default']);
const textSizes = new Set(['normal', 'heading', 'heading-0', 'heading-1', 'heading-2', 'heading-3', 'heading-4', 'notation', 'normal_v2', 'xx_large', 'x_large', 'large', 'medium', 'small', 'x_small']);
const bgStyles = new Set(['default', 'grey', 'grey-100', 'grey-200', 'grey-300', 'blue', 'blue-50', 'blue-100', 'wathet', 'wathet-50', 'turquoise', 'turquoise-50', 'green', 'green-50', 'yellow', 'yellow-50', 'orange', 'orange-50', 'red', 'red-50', 'carmine', 'carmine-50', 'violet', 'violet-50', 'purple', 'purple-50', 'indigo', 'indigo-50', 'none']);
const tableDataTypes = new Set(['text', 'lark_md', 'markdown', 'options', 'number', 'date']);
const aspectRatios = new Set(['1:1', '2:1', '4:3', '16:9']);
const chartThemes = new Set(['brand', 'rainbow', 'complementary', 'converse', 'primary']);
const chartTypes = new Set([
  'bar', 'line', 'area', 'pie', 'scatter', 'radar', 'funnel', 'wordCloud',
  'linearProgress', 'circularProgress', 'common', 'rose', 'waterfall',
  'histogram', 'boxPlot', 'gauge', 'heatmap', 'sankey', 'treemap', 'sunburst',
  'circlePacking', 'rangeColumn', 'rangeArea', 'dot', 'map',
]);

const idPattern = /^[a-zA-Z0-9_-]{1,40}$/;
const iconTokenPattern = /^[a-z0-9_]{1,64}$/;
const pxPattern = /^\d{1,3}px$/;
const spacingPxPattern = /^-?\d{1,3}px(?:\s+-?\d{1,3}px){0,3}$/;
const forbiddenKeys = new Set(['__proto__', 'constructor', 'prototype']);

export const feishuCardInstructions = ` Your default Feishu reply is native Markdown (post), which remains best for ordinary Q&A, short answers, code explanations and prose. When structured layout, tables, charts, collapsible sections, multi-view tabs, paginated/filterable lists, or follow-up action buttons genuinely make a reply clearer or easier to browse, you may call ${feishuCardToolName} on demand for any topic. Never force every reply into a card, and never tie cards to one fixed use case. Read feishu-cards/SKILL.md via read_skill when you want component syntax, VChart rules or interactive layout patterns. Calling ${feishuCardToolName} validates and stages the card for your final reply (calling it again replaces the staged card; { clear: true } reverts to Markdown; ending a turn silently discards it). After staging a card, finish with a brief plain-text summary as a fallback.`;

export const feishuCardTool = {
  type: 'function',
  function: {
    name: feishuCardToolName,
    description: 'Stage a validated Feishu Card JSON 2.0 (static or interactive) as this turn\'s Feishu reply instead of default Markdown post. General-purpose: use on demand whenever structured layout, tables, VChart charts, collapsible panels, switchable views, paginated/filterable lists or follow-up action buttons genuinely improve clarity. Supports header, markdown, div, plain_text, hr, note, column_set, collapsible_panel, root-level table (native page_size 1-10 & freeze_first_column), chart (VChart chart_spec), open_url button/interactive_container, plus platform-managed interactive views, paginated_list and actions. Calling again replaces the staged card; pass { clear: true } to revert to normal Markdown. Validation errors are returned so you can fix and retry.',
    parameters: {
      type: 'object',
      properties: {
        clear: { type: 'boolean', description: 'Set true to cancel any previously staged Feishu card in this turn and reply with normal Markdown.' },
        fallback_text: { type: 'string', maxLength: 8000, description: 'Optional concise Markdown fallback if Feishu rejects the card; auto-derived from the card when omitted.' },
        card: {
          type: 'object',
          description: 'Card JSON 2.0 definition plus optional platform-managed interactive fields (views, paginated_list blocks, actions).',
          properties: {
            schema: { type: 'string', enum: ['2.0'] },
            config: {
              type: 'object',
              properties: {
                width_mode: { type: 'string', enum: ['default', 'fill', 'compact'], description: 'Use "fill" for wide tables, multi-column layouts or charts.' },
                enable_forward: { type: 'boolean' },
              },
              additionalProperties: false,
            },
            header: {
              type: 'object',
              properties: {
                title: { description: 'Title string or { tag: "plain_text", content: "..." }.' },
                subtitle: { description: 'Optional subtitle string or { tag: "plain_text", content: "..." }.' },
                template: { type: 'string', enum: [...headerTemplates] },
                text_tag_list: { type: 'array', maxItems: 3, items: { type: 'object' } },
                icon: { type: 'object', description: 'Only { tag: "standard_icon", token, color? }.' },
              },
              additionalProperties: false,
            },
            elements: { type: 'array', description: 'Top-level body elements (shared above views when views is also set).' },
            body: { type: 'object', properties: { elements: { type: 'array' } }, additionalProperties: false, description: 'Alias for elements matching raw Card JSON 2.0.' },
            views: {
              type: 'array', minItems: 2, maxItems: 10,
              description: 'Optional switchable named views/tabs. Each view has { id, label, elements } and gets its own 30 KB / 200-element render budget.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  elements: { type: 'array' },
                },
                required: ['id', 'label', 'elements'],
                additionalProperties: false,
              },
            },
            default_view: { type: 'string', description: 'Initial view id when views is provided.' },
            view_switcher: { type: 'string', enum: ['buttons', 'select'] },
            actions: {
              type: 'array', maxItems: 4,
              description: 'Optional controlled follow-up buttons. Clicking triggers a normal turn attributed to the clicking user with the visible prompt.',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  prompt: { type: 'string', maxLength: 300 },
                  type: { type: 'string', enum: [...buttonTypes] },
                  confirm: {
                    type: 'object',
                    properties: { title: { type: 'string' }, text: { type: 'string' } },
                    required: ['title', 'text'],
                    additionalProperties: false,
                  },
                },
                required: ['id', 'label', 'prompt'],
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
};

export interface SanitizedPaginatedList {
  tag: 'paginated_list';
  id: string;
  title?: string;
  display: 'table' | 'items';
  page_size: number;
  empty_text: string;
  columns?: Json[];
  freeze_first_column?: boolean;
  row_height?: string;
  header_style?: Json;
  filters: { field: string; label: string; options: string[] }[];
  items: Json[];
}

export interface SanitizedCardView {
  id: string;
  label: string;
  elements: Json[];
}

export interface SanitizedCardAction {
  id: string;
  label: string;
  prompt: string;
  type: string;
  confirm?: { title: string; text: string };
}

export interface SanitizedCardSpec {
  config: { width_mode: 'default' | 'fill' | 'compact'; update_multi: true; enable_forward: boolean };
  header?: Json;
  elements: Json[];
  views: SanitizedCardView[];
  default_view: string | null;
  view_switcher: 'buttons' | 'select';
  actions: SanitizedCardAction[];
  interactive: boolean;
}

export interface InteractiveCardState {
  view: string | null;
  lists: Record<string, { page: number; filters: Record<string, string> }>;
}

export interface CardActionDescriptor {
  kind: 'view' | 'view_select' | 'page' | 'filter' | 'reset' | 'followup';
  target: string;
  label: string;
  delta?: number;
  field?: string;
  options?: string[];
  prompt?: string;
}

export interface StagedFeishuCard {
  spec: SanitizedCardSpec;
  state: InteractiveCardState;
  rendered: Json;
  fallback_text: string;
  interactive: boolean;
  bytes: number;
  element_count: number;
  summary: string;
}

function cardFail(code: string, detail: string): never {
  throw Object.assign(new HttpError(400, code), { detail });
}

function asObject(value: unknown, path: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) cardFail('card_invalid', `${path} must be a JSON object.`);
  return value as Json;
}

function checkNoForbiddenKeys(value: unknown, path: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => checkNoForbiddenKeys(item, `${path}[${i}]`));
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (forbiddenKeys.has(key)) cardFail('card_invalid', `Forbidden key "${key}" at ${path}.`);
    checkNoForbiddenKeys((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

export function safeCardUrl(value: unknown, origin = ''): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('//')) return undefined;
  try {
    const url = trimmed.startsWith('/') ? (origin ? new URL(trimmed, origin) : null) : new URL(trimmed);
    if (!url) return undefined;
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Non-web URLs are rejected. */ }
  return undefined;
}

function requireSafeUrl(value: unknown, origin: string, path: string): string {
  const url = safeCardUrl(value, origin);
  if (!url) cardFail('card_url_not_allowed', `${path} must be a safe http(s) or console relative URL without credentials.`);
  return url;
}

/** Sanitize Markdown used inside Card JSON 2.0: allow only safe http(s) links, block raw img_key and unsafe HTML tags. */
export function sanitizeCardMarkdown(raw: string, origin = '', clean: (s: string) => string = s => s): string {
  let out = clean(raw);
  // Block Markdown image syntax (prevents forged img_key like ![x](img_v2_...) with or without optional title) and turn web images into safe links.
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, target: string) => {
    const href = target.trim().split(/\s+/)[0] ?? '';
    const url = safeCardUrl(href, origin);
    const label = alt.trim() || '图片';
    return url ? `[图片：${label}](${url})` : `[图片：${label}]`;
  });
  // Sanitize Markdown links: drop javascript:, data:, file:, feishu custom schemes, etc.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, target: string) => {
    const href = target.trim().split(/\s+/)[0] ?? '';
    const url = safeCardUrl(href, origin);
    return url ? `[${label}](${url})` : label;
  });
  // Block raw HTML <img>, <at>, <script> and unsafe <link> tags; allow only harmless Feishu <font color='...'> and <text_tag color='...'>.
  out = out.replace(/<(\/?)([a-zA-Z][a-zA-Z0-9_-]*)([^>]*)>/g, (full, slash: string, tag: string, attrs: string) => {
    const lower = tag.toLowerCase();
    if (lower === 'font' || lower === 'text_tag') {
      if (slash) return `</${lower}>`;
      const color = /\bcolor\s*=\s*['"]([a-z0-9_-]{1,24})['"]/i.exec(attrs)?.[1];
      return color ? `<${lower} color='${color}'>` : `<${lower}>`;
    }
    if (lower === 'br') return '\n';
    return full.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
  return out;
}

/** Sanitize plain fragments interpolated inside markdown wrappers (**title**, <text_tag>...</text_tag>): no raw tags, no forged img_key. */
function sanitizeCardInlineFragment(raw: string, origin = '', clean: (s: string) => string = s => s): string {
  let out = clean(raw);
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string) => `[图片：${alt.trim() || '图片'}]`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, target: string) => {
    const href = target.trim().split(/\s+/)[0] ?? '';
    const url = safeCardUrl(href, origin);
    return url ? `[${label}](${url})` : label;
  });
  return out.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cleanText(value: unknown, clean: (s: string) => string, maxLen: number, path: string, allowEmpty = false): string {
  if (typeof value !== 'string') cardFail('card_invalid', `${path} must be a string.`);
  const result = clean(value).trim();
  if (!allowEmpty && !result) cardFail('card_invalid', `${path} must not be empty.`);
  if (result.length > maxLen) cardFail('card_invalid', `${path} exceeds maximum length of ${maxLen} characters.`);
  return result;
}

function plainTextNode(value: unknown, clean: (s: string) => string, maxLen: number, path: string): Json {
  if (typeof value === 'string') return { tag: 'plain_text', content: cleanText(value, clean, maxLen, path) };
  const obj = asObject(value, path);
  if (obj.tag !== undefined && obj.tag !== 'plain_text') cardFail('card_invalid', `${path}.tag must be "plain_text".`);
  const content = cleanText(obj.content, clean, maxLen, `${path}.content`);
  const out: Json = { tag: 'plain_text', content };
  if (obj.lines !== undefined) {
    if (!Number.isSafeInteger(obj.lines) || Number(obj.lines) < 1 || Number(obj.lines) > 20) cardFail('card_invalid', `${path}.lines must be an integer between 1 and 20.`);
    out.lines = Number(obj.lines);
  }
  return out;
}

function textOrMarkdownNode(value: unknown, origin: string, clean: (s: string) => string, maxLen: number, path: string): Json {
  if (typeof value === 'string') return { tag: 'plain_text', content: cleanText(value, clean, maxLen, path) };
  const obj = asObject(value, path);
  const tag = obj.tag === 'lark_md' || obj.tag === 'markdown' ? 'lark_md' : obj.tag === 'plain_text' || obj.tag === undefined ? 'plain_text' : '';
  if (!tag) cardFail('card_invalid', `${path}.tag must be "plain_text" or "lark_md".`);
  const raw = cleanText(obj.content, clean, maxLen, `${path}.content`);
  const content = tag === 'lark_md' ? sanitizeCardMarkdown(raw, origin, s => s) : raw;
  const out: Json = { tag, content };
  if (obj.lines !== undefined) {
    if (!Number.isSafeInteger(obj.lines) || Number(obj.lines) < 1 || Number(obj.lines) > 20) cardFail('card_invalid', `${path}.lines must be an integer between 1 and 20.`);
    out.lines = Number(obj.lines);
  }
  return out;
}

function sanitizeStandardIcon(value: unknown, path: string): Json {
  const obj = asObject(value, path);
  if (obj.tag === 'custom_icon' || obj.img_key !== undefined) cardFail('card_img_key_forbidden', `${path} must use standard_icon; custom_icon and img_key are not allowed.`);
  if (obj.tag !== 'standard_icon') cardFail('card_invalid', `${path}.tag must be "standard_icon".`);
  if (typeof obj.token !== 'string' || !iconTokenPattern.test(obj.token)) cardFail('card_invalid', `${path}.token must be a valid standard_icon token.`);
  const out: Json = { tag: 'standard_icon', token: obj.token };
  if (obj.color !== undefined) {
    if (typeof obj.color !== 'string' || !tagColors.has(obj.color)) cardFail('card_invalid', `${path}.color is not a supported color.`);
    out.color = obj.color;
  }
  return out;
}

function sanitizeMargin(value: unknown, path: string): string {
  if (typeof value !== 'string' || !spacingPxPattern.test(value.trim())) cardFail('card_invalid', `${path} must be pixel spacing such as "0px" or "8px 0px".`);
  return value.trim();
}

function sanitizeOpenUrlBehaviors(value: unknown, origin: string, path: string): Json[] {
  if (!Array.isArray(value) || !value.length || value.length > 1) cardFail('card_invalid', `${path} must contain exactly one open_url behavior.`);
  const item = asObject(value[0], `${path}[0]`);
  if (item.type === 'callback') cardFail('card_callback_not_allowed', `${path}[0]: raw callback behaviors are forbidden; use card.views, paginated_list, or card.actions instead.`);
  if (item.type !== 'open_url') cardFail('card_invalid', `${path}[0].type must be "open_url".`);
  const defaultUrl = requireSafeUrl(item.default_url ?? item.url, origin, `${path}[0].default_url`);
  const out: Json = { type: 'open_url', default_url: defaultUrl };
  for (const k of ['pc_url', 'android_url', 'ios_url'] as const) {
    if (item[k] !== undefined) out[k] = requireSafeUrl(item[k], origin, `${path}[0].${k}`);
  }
  return [out];
}

function sanitizeHeader(value: unknown, clean: (s: string) => string): Json {
  const obj = asObject(value, 'card.header');
  if (obj.title === undefined) cardFail('card_invalid', 'card.header.title is required.');
  const out: Json = { title: plainTextNode(obj.title, clean, 200, 'card.header.title') };
  if (obj.subtitle !== undefined) out.subtitle = plainTextNode(obj.subtitle, clean, 200, 'card.header.subtitle');
  if (obj.template !== undefined) {
    if (typeof obj.template !== 'string' || !headerTemplates.has(obj.template)) cardFail('card_invalid', `card.header.template must be one of: ${[...headerTemplates].join(', ')}.`);
    out.template = obj.template;
  }
  if (obj.icon !== undefined) out.icon = sanitizeStandardIcon(obj.icon, 'card.header.icon');
  if (obj.text_tag_list !== undefined) {
    if (!Array.isArray(obj.text_tag_list) || obj.text_tag_list.length > 3) cardFail('card_invalid', 'card.header.text_tag_list allows at most 3 tags.');
    out.text_tag_list = obj.text_tag_list.map((tag, i) => {
      const t = asObject(tag, `card.header.text_tag_list[${i}]`);
      const color = t.color === undefined ? 'neutral' : String(t.color);
      if (!tagColors.has(color)) cardFail('card_invalid', `card.header.text_tag_list[${i}].color is invalid.`);
      return { tag: 'text_tag', text: plainTextNode(t.text, clean, 40, `card.header.text_tag_list[${i}].text`), color };
    });
  }
  return out;
}

function sanitizeTableColumns(value: unknown, clean: (s: string) => string, path: string): Json[] {
  if (!Array.isArray(value) || !value.length || value.length > 50) cardFail('card_invalid', `${path} must have between 1 and 50 columns.`);
  const names = new Set<string>();
  return value.map((col, i) => {
    const c = asObject(col, `${path}[${i}]`);
    const name = cleanText(c.name, clean, 60, `${path}[${i}].name`);
    if (names.has(name)) cardFail('card_invalid', `Duplicate column name "${name}" in ${path}.`);
    names.add(name);
    const dataType = c.data_type === undefined ? 'text' : String(c.data_type);
    if (!tableDataTypes.has(dataType)) cardFail('card_invalid', `${path}[${i}].data_type must be one of: ${[...tableDataTypes].join(', ')}.`);
    const out: Json = {
      name,
      display_name: c.display_name === undefined ? name : cleanText(c.display_name, clean, 80, `${path}[${i}].display_name`),
      data_type: dataType,
    };
    if (c.width !== undefined) {
      const w = String(c.width);
      if (w !== 'auto' && !pxPattern.test(w)) cardFail('card_invalid', `${path}[${i}].width must be "auto" or pixel width (e.g. "120px").`);
      out.width = w;
    }
    if (c.horizontal_align !== undefined) {
      if (!alignValues.has(String(c.horizontal_align))) cardFail('card_invalid', `${path}[${i}].horizontal_align is invalid.`);
      out.horizontal_align = String(c.horizontal_align);
    }
    if (c.vertical_align !== undefined) {
      if (!vAlignValues.has(String(c.vertical_align))) cardFail('card_invalid', `${path}[${i}].vertical_align is invalid.`);
      out.vertical_align = String(c.vertical_align);
    }
    if (dataType === 'number' && c.format !== undefined) {
      const fmt = asObject(c.format, `${path}[${i}].format`);
      const outFmt: Json = {};
      if (fmt.precision !== undefined) {
        if (!Number.isSafeInteger(fmt.precision) || Number(fmt.precision) < 0 || Number(fmt.precision) > 6) cardFail('card_invalid', `${path}[${i}].format.precision must be 0..6.`);
        outFmt.precision = Number(fmt.precision);
      }
      if (fmt.symbol !== undefined) outFmt.symbol = cleanText(fmt.symbol, clean, 12, `${path}[${i}].format.symbol`, true);
      if (fmt.separator !== undefined) outFmt.separator = !!fmt.separator;
      out.format = outFmt;
    }
    if (dataType === 'date' && c.date_format !== undefined) {
      out.date_format = cleanText(c.date_format, clean, 40, `${path}[${i}].date_format`);
    }
    return out;
  });
}

function sanitizeTableCell(value: unknown, dataType: string, origin: string, clean: (s: string) => string, path: string): unknown {
  if (value === null || value === undefined) return '';
  if (dataType === 'options') {
    const list = Array.isArray(value) ? value : [value];
    if (list.length > 8) cardFail('card_invalid', `${path} allows at most 8 option tags.`);
    return list.map((item, idx) => {
      if (typeof item === 'string') return { text: cleanText(item, clean, 40, `${path}[${idx}]`), color: 'neutral' };
      const o = asObject(item, `${path}[${idx}]`);
      const color = o.color === undefined ? 'neutral' : String(o.color);
      if (!tagColors.has(color)) cardFail('card_invalid', `${path}[${idx}].color is invalid.`);
      return { text: cleanText(o.text, clean, 40, `${path}[${idx}].text`), color };
    });
  }
  if (dataType === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) cardFail('card_invalid', `${path} must be a finite number.`);
    return n;
  }
  if (dataType === 'date') {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    cardFail('card_invalid', `${path} must be a timestamp (ms) or ISO date string.`);
  }
  if (dataType === 'lark_md' || dataType === 'markdown') {
    return sanitizeCardMarkdown(cleanText(String(value), clean, 1000, path, true), origin, s => s);
  }
  return cleanText(String(value), clean, 1000, path, true);
}

function sanitizeTableHeaderStyle(value: unknown, path: string): Json {
  const h = asObject(value, path);
  const out: Json = {};
  if (h.text_align !== undefined) {
    if (!alignValues.has(String(h.text_align))) cardFail('card_invalid', `${path}.text_align is invalid.`);
    out.text_align = String(h.text_align);
  }
  if (h.text_size !== undefined) {
    if (!textSizes.has(String(h.text_size))) cardFail('card_invalid', `${path}.text_size is invalid.`);
    out.text_size = String(h.text_size);
  }
  if (h.background_style !== undefined) {
    if (!bgStyles.has(String(h.background_style))) cardFail('card_invalid', `${path}.background_style is invalid.`);
    out.background_style = String(h.background_style);
  }
  if (h.text_color !== undefined) {
    if (!['default', 'grey'].includes(String(h.text_color))) cardFail('card_invalid', `${path}.text_color must be "default" or "grey".`);
    out.text_color = String(h.text_color);
  }
  if (h.bold !== undefined) out.bold = !!h.bold;
  if (h.lines !== undefined) {
    if (!Number.isSafeInteger(h.lines) || Number(h.lines) < 1 || Number(h.lines) > 3) cardFail('card_invalid', `${path}.lines must be 1..3.`);
    out.lines = Number(h.lines);
  }
  return out;
}

function sanitizeTableElement(el: Json, origin: string, clean: (s: string) => string, path: string): Json {
  const columns = sanitizeTableColumns(el.columns, clean, `${path}.columns`);
  if (!Array.isArray(el.rows) || el.rows.length > 100) cardFail('card_invalid', `${path}.rows must be an array of at most 100 rows.`);
  const pageSize = el.page_size === undefined ? 5 : Number(el.page_size);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10) cardFail('card_invalid', `${path}.page_size must be an integer between 1 and 10.`);
  const rows = el.rows.map((r, ri) => {
    const rowObj = asObject(r, `${path}.rows[${ri}]`);
    const outRow: Json = {};
    for (const col of columns) {
      const name = String(col.name);
      if (rowObj[name] !== undefined) outRow[name] = sanitizeTableCell(rowObj[name], String(col.data_type), origin, clean, `${path}.rows[${ri}].${name}`);
    }
    return outRow;
  });
  const out: Json = { tag: 'table', page_size: pageSize, columns, rows };
  if (el.row_height !== undefined) {
    const rh = String(el.row_height);
    if (!['low', 'medium', 'auto'].includes(rh) && !pxPattern.test(rh)) cardFail('card_invalid', `${path}.row_height must be "low", "medium", "auto", or px.`);
    out.row_height = rh;
  }
  if (el.freeze_first_column !== undefined) out.freeze_first_column = !!el.freeze_first_column;
  if (el.header_style !== undefined) out.header_style = sanitizeTableHeaderStyle(el.header_style, `${path}.header_style`);
  if (el.margin !== undefined) out.margin = sanitizeMargin(el.margin, `${path}.margin`);
  return out;
}

function sanitizeChartSpec(value: unknown, clean: (s: string) => string, path: string): Json {
  const spec = asObject(value, path);
  if (typeof spec.type !== 'string' || !chartTypes.has(spec.type)) {
    cardFail('card_chart_invalid', `${path}.type must be a supported VChart type (e.g. bar, line, area, pie, scatter, radar, funnel, linearProgress).`);
  }
  if (spec.data === undefined || spec.data === null || typeof spec.data !== 'object') {
    cardFail('card_chart_invalid', `${path}.data is required for VChart chart_spec.`);
  }
  const walk = (node: unknown, depth: number, loc: string): unknown => {
    if (depth > 12) cardFail('card_chart_invalid', `${loc} exceeds maximum nesting depth of 12.`);
    if (node === null || typeof node === 'boolean') return node;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) cardFail('card_chart_invalid', `${loc} must be a finite number.`);
      return node;
    }
    if (typeof node === 'string') {
      const cleaned = clean(node);
      if (cleaned.length > 500) cardFail('card_chart_invalid', `${loc} string exceeds 500 characters.`);
      if (/<svg\b|data:image\/svg|javascript:|^\s*function\s*\(|=>/i.test(cleaned)) {
        cardFail('card_chart_invalid', `${loc} contains disallowed script or SVG content.`);
      }
      return cleaned;
    }
    if (Array.isArray(node)) {
      if (node.length > 200) cardFail('card_chart_invalid', `${loc} array exceeds 200 items.`);
      return node.map((item, i) => walk(item, depth + 1, `${loc}[${i}]`));
    }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      const out: Json = {};
      for (const [k, v] of Object.entries(obj)) {
        if (forbiddenKeys.has(k)) cardFail('card_chart_invalid', `Forbidden key "${k}" at ${loc}.`);
        if (k === 'texture' || k === 'repeatX' || k === 'repeatY') {
          cardFail('card_chart_invalid', `${loc}.${k} is not supported on Feishu mobile clients.`);
        }
        if (k === 'gradient' && v === 'conical') {
          cardFail('card_chart_invalid', `${loc}.gradient="conical" is not supported on Feishu mobile clients.`);
        }
        if (k === 'layoutMode' && v === 'grid') {
          cardFail('card_chart_invalid', `${loc}.layoutMode="grid" is not supported on Feishu mobile clients.`);
        }
        if (v !== undefined) out[k] = walk(v, depth + 1, `${loc}.${k}`);
      }
      return out;
    }
    cardFail('card_chart_invalid', `${loc} has unsupported value type.`);
  };
  return walk(spec, 0, path) as Json;
}

function sanitizeChartElement(el: Json, clean: (s: string) => string, path: string): Json {
  const out: Json = { tag: 'chart', chart_spec: sanitizeChartSpec(el.chart_spec, clean, `${path}.chart_spec`) };
  if (el.aspect_ratio !== undefined) {
    if (!aspectRatios.has(String(el.aspect_ratio))) cardFail('card_chart_invalid', `${path}.aspect_ratio must be one of: ${[...aspectRatios].join(', ')}.`);
    out.aspect_ratio = String(el.aspect_ratio);
  }
  if (el.color_theme !== undefined) {
    if (!chartThemes.has(String(el.color_theme))) cardFail('card_chart_invalid', `${path}.color_theme must be one of: ${[...chartThemes].join(', ')}.`);
    out.color_theme = String(el.color_theme);
  }
  if (el.preview !== undefined) out.preview = !!el.preview;
  else out.preview = true;
  if (el.height !== undefined) {
    const h = String(el.height);
    if (h !== 'auto' && !pxPattern.test(h)) cardFail('card_chart_invalid', `${path}.height must be "auto" or pixel height (1..999px).`);
    out.height = h;
  }
  if (el.margin !== undefined) out.margin = sanitizeMargin(el.margin, `${path}.margin`);
  return out;
}

function sanitizePaginatedList(el: Json, origin: string, clean: (s: string) => string, path: string, seenIds: Set<string>): SanitizedPaginatedList {
  const id = cleanText(el.id, clean, 40, `${path}.id`);
  if (!idPattern.test(id)) cardFail('card_invalid', `${path}.id must match [a-zA-Z0-9_-]{1,40}.`);
  if (seenIds.has(id)) cardFail('card_invalid', `Duplicate paginated_list id "${id}".`);
  seenIds.add(id);
  const display = el.display === undefined ? (el.columns ? 'table' : 'items') : String(el.display);
  if (display !== 'table' && display !== 'items') cardFail('card_invalid', `${path}.display must be "table" or "items".`);
  const pageSize = el.page_size === undefined ? 5 : Number(el.page_size);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10) cardFail('card_invalid', `${path}.page_size must be an integer between 1 and 10.`);
  if (!Array.isArray(el.items) || el.items.length > 200) cardFail('card_invalid', `${path}.items must be an array of at most 200 entries.`);
  const title = el.title === undefined ? undefined : sanitizeCardInlineFragment(cleanText(el.title, clean, 120, `${path}.title`), origin);
  const emptyText = el.empty_text === undefined ? '暂无匹配条目' : sanitizeCardMarkdown(cleanText(el.empty_text, clean, 120, `${path}.empty_text`), origin);

  const columns = display === 'table' ? sanitizeTableColumns(el.columns, clean, `${path}.columns`) : undefined;
  const rawFilters = el.filters === undefined ? [] : Array.isArray(el.filters) ? el.filters : cardFail('card_invalid', `${path}.filters must be an array.`);
  if (rawFilters.length > 3) cardFail('card_invalid', `${path}.filters allows at most 3 filter dimensions.`);

  const filterDefs = rawFilters.map((f, fi) => {
    const obj = asObject(f, `${path}.filters[${fi}]`);
    const field = cleanText(obj.field, clean, 40, `${path}.filters[${fi}].field`);
    const label = cleanText(obj.label ?? field, clean, 30, `${path}.filters[${fi}].label`);
    const explicit = obj.options === undefined ? undefined
      : Array.isArray(obj.options) ? [...new Set(obj.options.map((o, oi) => cleanText(String(o), clean, 40, `${path}.filters[${fi}].options[${oi}]`)))]
      : cardFail('card_invalid', `${path}.filters[${fi}].options must be an array.`);
    if (explicit && explicit.length > 20) cardFail('card_invalid', `${path}.filters[${fi}].options allows at most 20 options.`);
    return { field, label, explicit };
  });

  const filterValues = new Map<string, Set<string>>(filterDefs.map(f => [f.field, new Set(f.explicit ?? [])]));

  const items: Json[] = el.items.map((raw, idx) => {
    const itemObj = asObject(raw, `${path}.items[${idx}]`);
    const meta: Record<string, string> = {};
    if (display === 'table') {
      const row: Json = {};
      for (const col of columns!) {
        const name = String(col.name);
        if (itemObj[name] !== undefined) row[name] = sanitizeTableCell(itemObj[name], String(col.data_type), origin, clean, `${path}.items[${idx}].${name}`);
      }
      for (const f of filterDefs) {
        const v = itemObj[f.field];
        const str = v === undefined || v === null ? ''
          : Array.isArray(v) && v[0] && typeof v[0] === 'object' && 'text' in (v[0] as any) ? clean(String((v[0] as any).text)).trim()
          : typeof v === 'object' && v !== null && 'text' in (v as any) ? clean(String((v as any).text)).trim()
          : clean(String(v)).trim();
        if (str) {
          meta[f.field] = str.slice(0, 40);
          if (!f.explicit && filterValues.get(f.field)!.size < 20) filterValues.get(f.field)!.add(meta[f.field]!);
        }
      }
      return { row, filters: meta };
    }
    const content = sanitizeCardMarkdown(cleanText(itemObj.content ?? itemObj.description ?? itemObj.title ?? '', clean, 1200, `${path}.items[${idx}].content`), origin, s => s);
    const itemTitle = itemObj.title === undefined ? undefined : sanitizeCardInlineFragment(cleanText(itemObj.title, clean, 120, `${path}.items[${idx}].title`), origin);
    const url = itemObj.url === undefined ? undefined : requireSafeUrl(itemObj.url, origin, `${path}.items[${idx}].url`);
    const linkLabel = itemObj.link_label === undefined ? '查看' : cleanText(itemObj.link_label, clean, 24, `${path}.items[${idx}].link_label`);
    const badges = itemObj.badges === undefined ? [] : Array.isArray(itemObj.badges) ? itemObj.badges.slice(0, 4).map((b, bi) => {
      if (typeof b === 'string') return { text: sanitizeCardInlineFragment(cleanText(b, clean, 24, `${path}.items[${idx}].badges[${bi}]`), origin), color: 'neutral' };
      const bo = asObject(b, `${path}.items[${idx}].badges[${bi}]`);
      const color = bo.color === undefined ? 'neutral' : String(bo.color);
      if (!tagColors.has(color)) cardFail('card_invalid', `${path}.items[${idx}].badges[${bi}].color is invalid.`);
      return { text: sanitizeCardInlineFragment(cleanText(bo.text, clean, 24, `${path}.items[${idx}].badges[${bi}].text`), origin), color };
    }) : cardFail('card_invalid', `${path}.items[${idx}].badges must be an array.`);
    const fieldsObj = itemObj.fields && typeof itemObj.fields === 'object' && !Array.isArray(itemObj.fields) ? itemObj.fields as Json : itemObj;
    for (const f of filterDefs) {
      const v = fieldsObj[f.field] ?? itemObj[f.field];
      if (v !== undefined && v !== null) {
        const str = clean(String(v)).trim().slice(0, 40);
        if (str) {
          meta[f.field] = str;
          if (!f.explicit && filterValues.get(f.field)!.size < 20) filterValues.get(f.field)!.add(str);
        }
      }
    }
    return { ...(itemTitle ? { title: itemTitle } : {}), content, ...(url ? { url, link_label: linkLabel } : {}), badges, filters: meta };
  });

  const filters = filterDefs.map(f => ({ field: f.field, label: f.label, options: [...(filterValues.get(f.field) ?? [])] })).filter(f => f.options.length > 0);
  const out: SanitizedPaginatedList = { tag: 'paginated_list', id, ...(title ? { title } : {}), display, page_size: pageSize, empty_text: emptyText, filters, items };
  if (columns) out.columns = columns;
  if (el.freeze_first_column !== undefined) out.freeze_first_column = !!el.freeze_first_column;
  if (el.row_height !== undefined) {
    const rh = String(el.row_height);
    if (!['low', 'medium', 'auto'].includes(rh) && !pxPattern.test(rh)) cardFail('card_invalid', `${path}.row_height is invalid.`);
    out.row_height = rh;
  }
  if (el.header_style !== undefined) out.header_style = sanitizeTableHeaderStyle(el.header_style, `${path}.header_style`);
  return out;
}

interface SanitizeCtx {
  origin: string;
  clean: (s: string) => string;
  seenListIds: Set<string>;
}

function sanitizeElements(raw: unknown, ctx: SanitizeCtx, depth: number, rootLevel: boolean, path: string): Json[] {
  if (!Array.isArray(raw)) cardFail('card_invalid', `${path} must be an array.`);
  if (depth > 5) cardFail('card_nesting_exceeded', `${path} exceeds Feishu's maximum container nesting depth of 5.`);
  const out: Json[] = [];
  for (let i = 0; i < raw.length; i++) {
    const el = asObject(raw[i], `${path}[${i}]`);
    const tag = String(el.tag ?? '');
    const loc = `${path}[${i}]`;
    if (tag === 'img' || tag === 'img_combination') {
      cardFail('card_img_key_forbidden', `${loc}: raw img/img_combination elements are not allowed in cards; attach real images via reply attachment tools instead.`);
    }
    if (tag === 'form' || tag === 'input' || tag === 'select_static' || tag === 'select_person' || tag === 'date_picker' || tag === 'picker_time' || tag === 'picker_datetime' || tag === 'overflow' || tag === 'action') {
      cardFail('card_callback_not_allowed', `${loc}: raw interactive tag "${tag}" is not allowed; use card.views, paginated_list, or card.actions for platform-managed interaction.`);
    }
    if (tag === 'markdown' || tag === 'lark_md') {
      const content = sanitizeCardMarkdown(cleanText(el.content, ctx.clean, 12000, `${loc}.content`), ctx.origin, s => s);
      const node: Json = { tag: 'markdown', content };
      if (el.text_align !== undefined) {
        if (!alignValues.has(String(el.text_align))) cardFail('card_invalid', `${loc}.text_align is invalid.`);
        node.text_align = String(el.text_align);
      }
      if (el.text_size !== undefined) {
        if (!textSizes.has(String(el.text_size))) cardFail('card_invalid', `${loc}.text_size is invalid.`);
        node.text_size = String(el.text_size);
      }
      if (el.margin !== undefined) node.margin = sanitizeMargin(el.margin, `${loc}.margin`);
      out.push(node);
      continue;
    }
    if (tag === 'plain_text') {
      const node = plainTextNode(el, ctx.clean, 4000, loc);
      if (el.text_align !== undefined) {
        if (!alignValues.has(String(el.text_align))) cardFail('card_invalid', `${loc}.text_align is invalid.`);
        node.text_align = String(el.text_align);
      }
      if (el.text_size !== undefined) {
        if (!textSizes.has(String(el.text_size))) cardFail('card_invalid', `${loc}.text_size is invalid.`);
        node.text_size = String(el.text_size);
      }
      if (el.text_color !== undefined) {
        if (!tagColors.has(String(el.text_color)) && String(el.text_color) !== 'default') cardFail('card_invalid', `${loc}.text_color is invalid.`);
        node.text_color = String(el.text_color);
      }
      out.push(node);
      continue;
    }
    if (tag === 'div') {
      const node: Json = { tag: 'div' };
      if (el.text !== undefined) node.text = textOrMarkdownNode(el.text, ctx.origin, ctx.clean, 6000, `${loc}.text`);
      if (el.fields !== undefined) {
        if (!Array.isArray(el.fields) || el.fields.length > 20) cardFail('card_invalid', `${loc}.fields must be an array of at most 20 items.`);
        node.fields = el.fields.map((f, fi) => {
          const fo = asObject(f, `${loc}.fields[${fi}]`);
          return { is_short: !!fo.is_short, text: textOrMarkdownNode(fo.text, ctx.origin, ctx.clean, 2000, `${loc}.fields[${fi}].text`) };
        });
      }
      if (!node.text && !node.fields) cardFail('card_invalid', `${loc} must include text or fields.`);
      if (el.icon !== undefined) node.icon = sanitizeStandardIcon(el.icon, `${loc}.icon`);
      if (el.margin !== undefined) node.margin = sanitizeMargin(el.margin, `${loc}.margin`);
      out.push(node);
      continue;
    }
    if (tag === 'hr') {
      const node: Json = { tag: 'hr' };
      if (el.margin !== undefined) node.margin = sanitizeMargin(el.margin, `${loc}.margin`);
      out.push(node);
      continue;
    }
    if (tag === 'note') {
      // Card JSON 2.0 replaces 1.0 note blocks with notation-sized markdown.
      if (!Array.isArray(el.elements) || !el.elements.length || el.elements.length > 10) cardFail('card_invalid', `${loc}.elements must have 1..10 text entries.`);
      const parts = el.elements.map((child, ci) => {
        if (typeof child === 'string') return ctx.clean(child).trim();
        const co = asObject(child, `${loc}.elements[${ci}]`);
        if (co.tag === 'img' || co.img_key !== undefined) cardFail('card_img_key_forbidden', `${loc}.elements[${ci}]: img is not allowed inside note.`);
        const node = textOrMarkdownNode(co, ctx.origin, ctx.clean, 500, `${loc}.elements[${ci}]`);
        return String(node.content ?? '');
      }).filter(Boolean);
      const node: Json = { tag: 'markdown', content: parts.join(' · '), text_size: 'notation' };
      if (el.margin !== undefined) node.margin = sanitizeMargin(el.margin, `${loc}.margin`);
      out.push(node);
      continue;
    }
    if (tag === 'button') {
      if (el.value !== undefined) cardFail('card_callback_not_allowed', `${loc}.value is not allowed; use card.actions for interactive callbacks or open_url for links.`);
      const behaviors = el.behaviors !== undefined
        ? sanitizeOpenUrlBehaviors(el.behaviors, ctx.origin, `${loc}.behaviors`)
        : el.url !== undefined ? [{ type: 'open_url', default_url: requireSafeUrl(el.url, ctx.origin, `${loc}.url`) }]
        : cardFail('card_invalid', `${loc} must provide url or behaviors with type "open_url".`);
      const node: Json = { tag: 'button', text: plainTextNode(el.text, ctx.clean, 60, `${loc}.text`), behaviors };
      if (el.type !== undefined) {
        if (!buttonTypes.has(String(el.type))) cardFail('card_invalid', `${loc}.type is invalid.`);
        node.type = String(el.type);
      }
      if (el.size !== undefined) {
        if (!buttonSizes.has(String(el.size))) cardFail('card_invalid', `${loc}.size is invalid.`);
        node.size = String(el.size);
      }
      if (el.width !== undefined) {
        const w = String(el.width);
        if (!['default', 'fill'].includes(w) && !pxPattern.test(w)) cardFail('card_invalid', `${loc}.width is invalid.`);
        node.width = w;
      }
      if (el.icon !== undefined) node.icon = sanitizeStandardIcon(el.icon, `${loc}.icon`);
      if (el.hover_tips !== undefined) node.hover_tips = plainTextNode(el.hover_tips, ctx.clean, 120, `${loc}.hover_tips`);
      if (el.margin !== undefined) node.margin = sanitizeMargin(el.margin, `${loc}.margin`);
      out.push(node);
      continue;
    }
    if (tag === 'column_set') {
      if (!Array.isArray(el.columns) || !el.columns.length || el.columns.length > 6) cardFail('card_invalid', `${loc}.columns must have 1..6 columns.`);
      const node: Json = {
        tag: 'column_set',
        columns: el.columns.map((col, ci) => {
          const co = asObject(col, `${loc}.columns[${ci}]`);
          const colOut: Json = { tag: 'column', elements: sanitizeElements(co.elements ?? [], ctx, depth + 1, false, `${loc}.columns[${ci}].elements`) };
          if (co.width !== undefined) {
            const w = String(co.width);
            if (!['auto', 'weighted', 'fill'].includes(w) && !pxPattern.test(w)) cardFail('card_invalid', `${loc}.columns[${ci}].width is invalid.`);
            colOut.width = w;
          } else colOut.width = 'weighted';
          if (co.weight !== undefined) {
            if (!Number.isSafeInteger(co.weight) || Number(co.weight) < 1 || Number(co.weight) > 5) cardFail('card_invalid', `${loc}.columns[${ci}].weight must be 1..5.`);
            colOut.weight = Number(co.weight);
          } else if (colOut.width === 'weighted') colOut.weight = 1;
          if (co.vertical_align !== undefined) {
            if (!vAlignValues.has(String(co.vertical_align))) cardFail('card_invalid', `${loc}.columns[${ci}].vertical_align is invalid.`);
            colOut.vertical_align = String(co.vertical_align);
          }
          if (co.horizontal_align !== undefined) {
            if (!alignValues.has(String(co.horizontal_align))) cardFail('card_invalid', `${loc}.columns[${ci}].horizontal_align is invalid.`);
            colOut.horizontal_align = String(co.horizontal_align);
          }
          if (co.vertical_spacing !== undefined) {
            const vs = String(co.vertical_spacing);
            if (!spacingValues.has(vs) && !pxPattern.test(vs)) cardFail('card_invalid', `${loc}.columns[${ci}].vertical_spacing is invalid.`);
            colOut.vertical_spacing = vs;
          }
          if (co.background_style !== undefined) {
            if (!bgStyles.has(String(co.background_style))) cardFail('card_invalid', `${loc}.columns[${ci}].background_style is invalid.`);
            colOut.background_style = String(co.background_style);
          }
          if (co.padding !== undefined) colOut.padding = sanitizeMargin(co.padding, `${loc}.columns[${ci}].padding`);
          return colOut;
        }),
      };
      if (el.flex_mode !== undefined) {
        if (!flexModes.has(String(el.flex_mode))) cardFail('card_invalid', `${loc}.flex_mode is invalid.`);
        node.flex_mode = String(el.flex_mode);
      }
      if (el.horizontal_spacing !== undefined) {
        const hs = String(el.horizontal_spacing);
        if (!spacingValues.has(hs) && !pxPattern.test(hs)) cardFail('card_invalid', `${loc}.horizontal_spacing is invalid.`);
        node.horizontal_spacing = hs;
      }
      if (el.horizontal_align !== undefined) {
        if (!alignValues.has(String(el.horizontal_align))) cardFail('card_invalid', `${loc}.horizontal_align is invalid.`);
        node.horizontal_align = String(el.horizontal_align);
      }
      if (el.background_style !== undefined) {
        if (!bgStyles.has(String(el.background_style))) cardFail('card_invalid', `${loc}.background_style is invalid.`);
        node.background_style = String(el.background_style);
      }
      if (el.margin !== undefined) node.margin = sanitizeMargin(el.margin, `${loc}.margin`);
      out.push(node);
      continue;
    }
    if (tag === 'collapsible_panel') {
      const headerObj = asObject(el.header, `${loc}.header`);
      const titleNode = headerObj.title && typeof headerObj.title === 'object' && (headerObj.title as Json).tag === 'markdown'
        ? { tag: 'markdown', content: sanitizeCardMarkdown(cleanText((headerObj.title as Json).content, ctx.clean, 200, `${loc}.header.title.content`), ctx.origin, s => s) }
        : plainTextNode(headerObj.title, ctx.clean, 200, `${loc}.header.title`);
      const panelHeader: Json = { title: titleNode };
      if (headerObj.background_color !== undefined) {
        if (!bgStyles.has(String(headerObj.background_color))) cardFail('card_invalid', `${loc}.header.background_color is invalid.`);
        panelHeader.background_color = String(headerObj.background_color);
      }
      if (headerObj.padding !== undefined) panelHeader.padding = sanitizeMargin(headerObj.padding, `${loc}.header.padding`);
      if (headerObj.icon !== undefined) panelHeader.icon = sanitizeStandardIcon(headerObj.icon, `${loc}.header.icon`);
      if (headerObj.icon_position !== undefined) {
        if (!['left', 'right'].includes(String(headerObj.icon_position))) cardFail('card_invalid', `${loc}.header.icon_position must be "left" or "right".`);
        panelHeader.icon_position = String(headerObj.icon_position);
      }
      const node: Json = {
        tag: 'collapsible_panel',
        expanded: el.expanded === true,
        header: panelHeader,
        elements: sanitizeElements(el.elements ?? [], ctx, depth + 1, false, `${loc}.elements`),
      };
      if (el.direction !== undefined) {
        if (!['vertical', 'horizontal'].includes(String(el.direction))) cardFail('card_invalid', `${loc}.direction must be "vertical" or "horizontal".`);
        node.direction = String(el.direction);
      }
      if (el.background_color !== undefined) {
        if (!bgStyles.has(String(el.background_color))) cardFail('card_invalid', `${loc}.background_color is invalid.`);
        node.background_color = String(el.background_color);
      }
      if (el.padding !== undefined) node.padding = sanitizeMargin(el.padding, `${loc}.padding`);
      if (el.border !== undefined) {
        const b = asObject(el.border, `${loc}.border`);
        const border: Json = {};
        if (b.color !== undefined) {
          if (!tagColors.has(String(b.color)) && String(b.color) !== 'default') cardFail('card_invalid', `${loc}.border.color is invalid.`);
          border.color = String(b.color);
        }
        if (b.corner_radius !== undefined) {
          if (!pxPattern.test(String(b.corner_radius))) cardFail('card_invalid', `${loc}.border.corner_radius must be px.`);
          border.corner_radius = String(b.corner_radius);
        }
        node.border = border;
      }
      if (el.margin !== undefined) node.margin = sanitizeMargin(el.margin, `${loc}.margin`);
      out.push(node);
      continue;
    }
    if (tag === 'interactive_container') {
      const behaviors = el.behaviors !== undefined
        ? sanitizeOpenUrlBehaviors(el.behaviors, ctx.origin, `${loc}.behaviors`)
        : el.url !== undefined ? [{ type: 'open_url', default_url: requireSafeUrl(el.url, ctx.origin, `${loc}.url`) }]
        : undefined;
      const node: Json = {
        tag: 'interactive_container',
        ...(behaviors ? { behaviors } : {}),
        elements: sanitizeElements(el.elements ?? [], ctx, depth + 1, false, `${loc}.elements`),
      };
      if (el.width !== undefined) {
        const w = String(el.width);
        if (!['fill', 'auto'].includes(w) && !pxPattern.test(w)) cardFail('card_invalid', `${loc}.width is invalid.`);
        node.width = w;
      }
      if (el.height !== undefined) {
        const h = String(el.height);
        if (h !== 'auto' && !pxPattern.test(h)) cardFail('card_invalid', `${loc}.height is invalid.`);
        node.height = h;
      }
      if (el.background_style !== undefined) {
        if (!bgStyles.has(String(el.background_style))) cardFail('card_invalid', `${loc}.background_style is invalid.`);
        node.background_style = String(el.background_style);
      }
      if (el.has_border !== undefined) node.has_border = !!el.has_border;
      if (el.border_color !== undefined) {
        if (!tagColors.has(String(el.border_color)) && String(el.border_color) !== 'default') cardFail('card_invalid', `${loc}.border_color is invalid.`);
        node.border_color = String(el.border_color);
      }
      if (el.corner_radius !== undefined) {
        if (!pxPattern.test(String(el.corner_radius))) cardFail('card_invalid', `${loc}.corner_radius must be px.`);
        node.corner_radius = String(el.corner_radius);
      }
      if (el.padding !== undefined) node.padding = sanitizeMargin(el.padding, `${loc}.padding`);
      if (el.direction !== undefined) {
        if (!['vertical', 'horizontal'].includes(String(el.direction))) cardFail('card_invalid', `${loc}.direction is invalid.`);
        node.direction = String(el.direction);
      }
      if (el.margin !== undefined) node.margin = sanitizeMargin(el.margin, `${loc}.margin`);
      out.push(node);
      continue;
    }
    if (tag === 'table') {
      if (!rootLevel) cardFail('card_table_nesting_forbidden', `${loc}: Feishu requires "table" to be placed at the root body level, not nested inside another container.`);
      out.push(sanitizeTableElement(el, ctx.origin, ctx.clean, loc));
      continue;
    }
    if (tag === 'chart') {
      out.push(sanitizeChartElement(el, ctx.clean, loc));
      continue;
    }
    if (tag === 'paginated_list') {
      if (!rootLevel) cardFail('card_invalid', `${loc}: "paginated_list" must be placed at the root body level (or top level of a view).`);
      out.push(sanitizePaginatedList(el, ctx.origin, ctx.clean, loc, ctx.seenListIds) as unknown as Json);
      continue;
    }
    cardFail('card_element_unsupported', `${loc}: unsupported element tag "${tag || '(missing)'}".`);
  }
  return out;
}

export function countCardElements(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  if (Array.isArray(node)) return node.reduce((sum, item) => sum + countCardElements(item), 0);
  const obj = node as Record<string, unknown>;
  let total = typeof obj.tag === 'string' ? 1 : 0;
  for (const key of ['elements', 'columns', 'fields', 'text', 'extra', 'header', 'title', 'subtitle', 'icon', 'hover_tips', 'placeholder']) {
    if (obj[key] !== undefined) total += countCardElements(obj[key]);
  }
  return total;
}

function countByTag(elements: Json[], targetTag: string): number {
  let count = 0;
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Json;
      if (obj.tag === targetTag) count++;
      if (Array.isArray(obj.elements)) walk(obj.elements);
      if (Array.isArray(obj.columns)) {
        for (const col of obj.columns as Json[]) walk(col?.elements);
      }
    }
  };
  walk(elements);
  return count;
}

export function cardSerializedBytes(card: Json): number {
  // Feishu envelopes card JSON inside a JSON string field ("content"), so double-serialized bytes reflect the actual request size.
  return Buffer.byteLength(JSON.stringify(JSON.stringify(card)));
}

export function initialCardState(spec: SanitizedCardSpec): InteractiveCardState {
  const lists: InteractiveCardState['lists'] = {};
  const collect = (elements: Json[]) => {
    for (const el of elements) {
      if (el.tag === 'paginated_list') lists[String(el.id)] = { page: 0, filters: {} };
    }
  };
  collect(spec.elements);
  for (const view of spec.views) collect(view.elements);
  return { view: spec.default_view, lists };
}

function renderPaginatedListBlock(
  list: SanitizedPaginatedList,
  listState: { page: number; filters: Record<string, string> },
  cardId: string,
  actions: Record<string, CardActionDescriptor>,
): Json[] {
  const out: Json[] = [];
  const activeFilters = listState.filters ?? {};
  const filtered = list.items.filter(item => {
    const meta = (item.filters ?? {}) as Record<string, string>;
    for (const f of list.filters) {
      const selected = activeFilters[f.field];
      if (selected && selected !== '__all__' && meta[f.field] !== selected) return false;
    }
    return true;
  });
  const totalItems = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / list.page_size));
  const page = Math.min(Math.max(0, listState.page ?? 0), totalPages - 1);
  const start = page * list.page_size;
  const slice = filtered.slice(start, start + list.page_size);

  const headingParts: string[] = [];
  if (list.title) headingParts.push(`**${sanitizeCardInlineFragment(list.title)}**`);
  headingParts.push(`共 ${totalItems} 条` + (totalItems !== list.items.length ? `（总计 ${list.items.length} 条）` : '') + (totalPages > 1 ? ` · 第 ${page + 1}/${totalPages} 页` : ''));
  out.push({ tag: 'markdown', content: headingParts.join(' · '), text_size: list.title ? 'normal' : 'notation' });

  if (list.filters.length && cardId) {
    const filterColumns: Json[] = list.filters.map(f => {
      const act = `f:${list.id}:${f.field}`;
      const current = activeFilters[f.field] || '__all__';
      actions[act] = { kind: 'filter', target: list.id, field: f.field, label: f.label, options: ['__all__', ...f.options] };
      return {
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: `${f.label}：全部` },
          initial_option: current,
          options: [
            { text: { tag: 'plain_text', content: `${f.label}：全部` }, value: '__all__' },
            ...f.options.map(opt => ({ text: { tag: 'plain_text', content: `${f.label}：${opt}` }, value: opt })),
          ],
          behaviors: [{ type: 'callback', value: { card: cardId, act } }],
        }],
      };
    });
    const hasFilter = Object.values(activeFilters).some(v => v && v !== '__all__');
    if (hasFilter) {
      const resetAct = `r:${list.id}`;
      actions[resetAct] = { kind: 'reset', target: list.id, label: '重置筛选' };
      filterColumns.push({
        tag: 'column',
        width: 'auto',
        vertical_align: 'center',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '重置' },
          type: 'default',
          size: 'small',
          behaviors: [{ type: 'callback', value: { card: cardId, act: resetAct } }],
        }],
      });
    }
    out.push({ tag: 'column_set', flex_mode: 'flow', horizontal_spacing: 'small', columns: filterColumns });
  }

  if (!slice.length) {
    out.push({ tag: 'markdown', content: sanitizeCardMarkdown(list.empty_text), text_size: 'notation' });
  } else if (list.display === 'table' && list.columns) {
    out.push({
      tag: 'table',
      page_size: list.page_size,
      row_height: list.row_height ?? 'low',
      ...(list.freeze_first_column ? { freeze_first_column: true } : {}),
      ...(list.header_style ? { header_style: list.header_style } : {}),
      columns: list.columns,
      rows: slice.map(entry => entry.row as Json),
    });
  } else {
    for (const entry of slice) {
      const badges = Array.isArray(entry.badges) ? (entry.badges as { text: string; color: string }[]).map(b => `<text_tag color='${b.color}'>${sanitizeCardInlineFragment(b.text)}</text_tag>`).join(' ') : '';
      const head = [entry.title ? `**${sanitizeCardInlineFragment(String(entry.title))}**` : '', badges].filter(Boolean).join(' ');
      const body = [head, String(entry.content ?? '')].filter(Boolean).join('\n');
      if (entry.url) {
        out.push({
          tag: 'column_set',
          flex_mode: 'none',
          horizontal_spacing: 'small',
          columns: [
            { tag: 'column', width: 'weighted', weight: 4, vertical_align: 'center', elements: [{ tag: 'markdown', content: body }] },
            { tag: 'column', width: 'auto', vertical_align: 'center', elements: [{ tag: 'button', text: { tag: 'plain_text', content: String(entry.link_label ?? '查看') }, size: 'small', type: 'default', behaviors: [{ type: 'open_url', default_url: String(entry.url) }] }] },
          ],
        });
      } else {
        out.push({ tag: 'markdown', content: body });
      }
    }
  }

  if (totalPages > 1 && cardId) {
    const prevAct = `p:${list.id}:prev`;
    const nextAct = `p:${list.id}:next`;
    actions[prevAct] = { kind: 'page', target: list.id, delta: -1, label: '上一页' };
    actions[nextAct] = { kind: 'page', target: list.id, delta: 1, label: '下一页' };
    out.push({
      tag: 'column_set',
      flex_mode: 'none',
      horizontal_spacing: 'small',
      horizontal_align: 'left',
      columns: [
        {
          tag: 'column', width: 'auto', vertical_align: 'center',
          elements: [{
            tag: 'button', text: { tag: 'plain_text', content: '上一页' }, size: 'small', type: 'default', disabled: page <= 0,
            behaviors: [{ type: 'callback', value: { card: cardId, act: prevAct } }],
          }],
        },
        {
          tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', horizontal_align: 'center',
          elements: [{ tag: 'markdown', content: `第 ${page + 1} / ${totalPages} 页`, text_align: 'center', text_size: 'notation' }],
        },
        {
          tag: 'column', width: 'auto', vertical_align: 'center',
          elements: [{
            tag: 'button', text: { tag: 'plain_text', content: '下一页' }, size: 'small', type: 'default', disabled: page >= totalPages - 1,
            behaviors: [{ type: 'callback', value: { card: cardId, act: nextAct } }],
          }],
        },
      ],
    });
  }
  return out;
}

export function renderFeishuCard(
  spec: SanitizedCardSpec,
  state: InteractiveCardState,
  cardId: string,
  options: { footerNote?: string; consoleUrl?: string } = {},
): { card: Json; actions: Record<string, CardActionDescriptor>; summary: string } {
  const actions: Record<string, CardActionDescriptor> = {};
  const bodyElements: Json[] = [];

  const expand = (elements: Json[]) => {
    for (const el of elements) {
      if (el.tag === 'paginated_list') {
        const list = el as unknown as SanitizedPaginatedList;
        const listState = state.lists[list.id] ?? { page: 0, filters: {} };
        bodyElements.push(...renderPaginatedListBlock(list, listState, cardId, actions));
      } else {
        bodyElements.push(el);
      }
    }
  };

  expand(spec.elements);

  if (spec.views.length) {
    const activeView = spec.views.find(v => v.id === state.view) ?? spec.views[0]!;
    if (cardId) {
      if (spec.view_switcher === 'select' || spec.views.length > 5) {
        const act = 'vs';
        actions[act] = { kind: 'view_select', target: 'views', label: '视图', options: spec.views.map(v => v.id) };
        bodyElements.push({
          tag: 'select_static',
          placeholder: { tag: 'plain_text', content: '切换视图' },
          initial_option: activeView.id,
          options: spec.views.map(v => ({ text: { tag: 'plain_text', content: v.label }, value: v.id })),
          behaviors: [{ type: 'callback', value: { card: cardId, act } }],
        });
      } else {
        bodyElements.push({
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: 'small',
          columns: spec.views.map(v => {
            const act = `v:${v.id}`;
            actions[act] = { kind: 'view', target: v.id, label: v.label };
            return {
              tag: 'column',
              width: 'auto',
              elements: [{
                tag: 'button',
                text: { tag: 'plain_text', content: v.label },
                size: 'small',
                type: v.id === activeView.id ? 'primary_filled' : 'default',
                behaviors: [{ type: 'callback', value: { card: cardId, act } }],
              }],
            };
          }),
        });
      }
    }
    expand(activeView.elements);
  }

  if (spec.actions.length && cardId) {
    bodyElements.push({ tag: 'hr' });
    bodyElements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      horizontal_spacing: 'small',
      columns: spec.actions.map(action => {
        const act = `a:${action.id}`;
        actions[act] = { kind: 'followup', target: action.id, label: action.label, prompt: action.prompt };
        return {
          tag: 'column',
          width: 'auto',
          elements: [{
            tag: 'button',
            text: { tag: 'plain_text', content: action.label },
            size: 'small',
            type: action.type,
            ...(action.confirm ? {
              confirm: {
                title: { tag: 'plain_text', content: action.confirm.title },
                text: { tag: 'plain_text', content: action.confirm.text },
              },
            } : {}),
            behaviors: [{ type: 'callback', value: { card: cardId, act } }],
          }],
        };
      }),
    });
  }

  const footerBits: string[] = [];
  if (options.footerNote) footerBits.push(sanitizeCardInlineFragment(options.footerNote));
  if (options.consoleUrl) {
    const safeConsole = safeCardUrl(options.consoleUrl);
    if (safeConsole) footerBits.push(`[登录后台查看](${safeConsole})`);
  }
  if (footerBits.length) {
    bodyElements.push({ tag: 'markdown', content: footerBits.join(' · '), text_size: 'notation' });
  }

  const card: Json = {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: spec.config.width_mode,
      enable_forward: spec.config.enable_forward,
    },
    ...(spec.header ? { header: spec.header } : {}),
    body: { elements: bodyElements },
  };
  return { card, actions, summary: cardText(card) };
}

function validateRenderedBudgets(spec: SanitizedCardSpec, cardIdPreview: string): { rendered: Json; bytes: number; element_count: number; summary: string } {
  const baseState = initialCardState(spec);
  const viewsToCheck = spec.views.length ? spec.views.map(v => v.id) : [null];
  let primary: { rendered: Json; bytes: number; element_count: number; summary: string } | undefined;

  for (const viewId of viewsToCheck) {
    const state: InteractiveCardState = { ...baseState, view: viewId };
    const { card, summary } = renderFeishuCard(spec, state, cardIdPreview);
    const body = (card.body as Json).elements as Json[];
    const tables = countByTag(body, 'table');
    if (tables > 5) cardFail('card_table_limit_exceeded', `Rendered card${viewId ? ` view "${viewId}"` : ''} contains ${tables} tables; Feishu allows at most 5 tables per card.`);
    const charts = countByTag(body, 'chart');
    if (charts > 5) cardFail('card_chart_limit_exceeded', `Rendered card${viewId ? ` view "${viewId}"` : ''} contains ${charts} charts; Feishu allows at most 5 charts per card.`);
    const elements = countCardElements(card);
    if (elements > feishuCardMaxElements) {
      cardFail('card_elements_exceeded', `Rendered card${viewId ? ` view "${viewId}"` : ''} has ${elements} elements (limit ${feishuCardMaxElements}, below Feishu's 200 cap). Split content across views or move rows into a paginated_list.`);
    }
    const bytes = cardSerializedBytes(card);
    if (bytes > feishuCardMaxBytes) {
      cardFail('card_size_exceeded', `Rendered card${viewId ? ` view "${viewId}"` : ''} is ${bytes} bytes serialized (limit ${feishuCardMaxBytes}, below Feishu's 30 KB cap). Shorten text, reduce page_size, or split across views.`);
    }
    if (!primary || viewId === baseState.view) primary = { rendered: card, bytes, element_count: elements, summary };
  }
  return primary!;
}

/** Validate, sanitize, redact and budget-check a Card JSON 2.0 tool payload. */
export function buildFeishuCard(args: unknown, options: { origin?: string; clean?: (s: string) => string } = {}): StagedFeishuCard {
  const origin = options.origin ?? '';
  const clean = options.clean ?? (s => s);
  const input = asObject(args, 'arguments');
  checkNoForbiddenKeys(input, 'arguments');
  const cardInput = asObject(input.card, 'card');
  if (cardInput.schema !== undefined && cardInput.schema !== '2.0') cardFail('card_invalid', 'card.schema must be "2.0".');

  const rawElements = cardInput.elements ?? (cardInput.body && typeof cardInput.body === 'object' ? (cardInput.body as Json).elements : undefined);
  const ctx: SanitizeCtx = { origin, clean, seenListIds: new Set() };
  const elements = rawElements === undefined ? [] : sanitizeElements(rawElements, ctx, 0, true, 'card.elements');

  let views: SanitizedCardView[] = [];
  if (cardInput.views !== undefined) {
    if (!Array.isArray(cardInput.views) || cardInput.views.length < 2 || cardInput.views.length > 10) {
      cardFail('card_invalid', 'card.views must contain between 2 and 10 views.');
    }
    const seenViews = new Set<string>();
    views = cardInput.views.map((v, vi) => {
      const vo = asObject(v, `card.views[${vi}]`);
      const id = cleanText(vo.id, clean, 40, `card.views[${vi}].id`);
      if (!idPattern.test(id)) cardFail('card_invalid', `card.views[${vi}].id must match [a-zA-Z0-9_-]{1,40}.`);
      if (seenViews.has(id)) cardFail('card_invalid', `Duplicate view id "${id}".`);
      seenViews.add(id);
      const label = cleanText(vo.label, clean, 24, `card.views[${vi}].label`);
      const viewEls = sanitizeElements(vo.elements, ctx, 0, true, `card.views[${vi}].elements`);
      if (!viewEls.length) cardFail('card_invalid', `card.views[${vi}].elements must not be empty.`);
      return { id, label, elements: viewEls };
    });
  }

  let actions: SanitizedCardAction[] = [];
  if (cardInput.actions !== undefined) {
    if (!Array.isArray(cardInput.actions) || cardInput.actions.length > 4) cardFail('card_invalid', 'card.actions allows at most 4 actions.');
    const seenActions = new Set<string>();
    actions = cardInput.actions.map((a, ai) => {
      const ao = asObject(a, `card.actions[${ai}]`);
      const id = cleanText(ao.id, clean, 40, `card.actions[${ai}].id`);
      if (!idPattern.test(id)) cardFail('card_invalid', `card.actions[${ai}].id must match [a-zA-Z0-9_-]{1,40}.`);
      if (seenActions.has(id)) cardFail('card_invalid', `Duplicate action id "${id}".`);
      seenActions.add(id);
      const label = cleanText(ao.label, clean, 32, `card.actions[${ai}].label`);
      const prompt = cleanText(ao.prompt, clean, 300, `card.actions[${ai}].prompt`);
      const type = ao.type === undefined ? 'default' : String(ao.type);
      if (!buttonTypes.has(type)) cardFail('card_invalid', `card.actions[${ai}].type is invalid.`);
      let confirm: { title: string; text: string } | undefined;
      if (ao.confirm !== undefined) {
        const co = asObject(ao.confirm, `card.actions[${ai}].confirm`);
        confirm = {
          title: cleanText(co.title, clean, 60, `card.actions[${ai}].confirm.title`),
          text: cleanText(co.text, clean, 240, `card.actions[${ai}].confirm.text`),
        };
      }
      return { id, label, prompt, type, ...(confirm ? { confirm } : {}) };
    });
  }

  if (!elements.length && !views.length) cardFail('card_invalid', 'card must contain elements or views.');
  if (ctx.seenListIds.size > 5) cardFail('card_invalid', 'A card may contain at most 5 paginated_list blocks.');

  const defaultView = views.length
    ? (cardInput.default_view === undefined ? views[0]!.id
      : views.some(v => v.id === cardInput.default_view) ? String(cardInput.default_view)
      : cardFail('card_invalid', `card.default_view "${cardInput.default_view}" does not match any view id.`))
    : null;
  const viewSwitcher = cardInput.view_switcher === undefined ? (views.length > 5 ? 'select' : 'buttons')
    : cardInput.view_switcher === 'buttons' || cardInput.view_switcher === 'select' ? cardInput.view_switcher
    : cardFail('card_invalid', 'card.view_switcher must be "buttons" or "select".');

  const header = cardInput.header === undefined ? undefined : sanitizeHeader(cardInput.header, clean);
  const hasWideContent = views.length > 0 || ctx.seenListIds.size > 0
    || countByTag(elements, 'table') > 0 || countByTag(elements, 'chart') > 0 || countByTag(elements, 'column_set') > 0
    || views.some(v => countByTag(v.elements, 'table') > 0 || countByTag(v.elements, 'chart') > 0 || countByTag(v.elements, 'column_set') > 0);
  const rawConfig = cardInput.config === undefined ? {} : asObject(cardInput.config, 'card.config');
  const widthMode = rawConfig.width_mode === undefined ? (hasWideContent ? 'fill' : 'default')
    : widthModes.has(String(rawConfig.width_mode)) ? String(rawConfig.width_mode) as 'default' | 'fill' | 'compact'
    : cardFail('card_invalid', 'card.config.width_mode must be "default", "fill", or "compact".');

  const interactive = views.length > 0 || ctx.seenListIds.size > 0 || actions.length > 0;
  const spec: SanitizedCardSpec = {
    config: { width_mode: widthMode, update_multi: true, enable_forward: rawConfig.enable_forward !== false },
    ...(header ? { header } : {}),
    elements,
    views,
    default_view: defaultView,
    view_switcher: viewSwitcher,
    actions,
    interactive,
  };
  if (Buffer.byteLength(JSON.stringify(spec)) > feishuCardMaxSpecBytes) {
    cardFail('card_spec_too_large', `Card interactive specification exceeds ${feishuCardMaxSpecBytes} bytes; reduce stored items or text.`);
  }

  const previewCardId = interactive ? '0'.repeat(48) : '';
  const { rendered, bytes, element_count, summary } = validateRenderedBudgets(spec, previewCardId);
  const fallbackText = input.fallback_text !== undefined
    ? cleanText(input.fallback_text, clean, 8000, 'fallback_text')
    : summary;

  return { spec, state: initialCardState(spec), rendered, fallback_text: fallbackText, interactive, bytes, element_count, summary };
}

/** Per-turn holder that validates, redacts and stages at most one Feishu Card JSON 2.0 for the turn's final reply. */
export class FeishuCardTurn {
  private current: StagedFeishuCard | null = null;
  constructor(private readonly origin = '', private readonly clean: (s: string) => string = s => s) {}
  get staged(): StagedFeishuCard | null { return this.current; }
  execute(args: unknown): Json {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { error: 'invalid_arguments', detail: 'set_feishu_card takes a JSON object.' };
    }
    const input = args as Json;
    if (input.clear === true) {
      this.current = null;
      return { staged: false, cleared: true, notice: 'Staged Feishu card cleared; this turn will reply with normal Markdown.' };
    }
    try {
      const staged = buildFeishuCard(input, { origin: this.origin, clean: this.clean });
      this.current = staged;
      return {
        staged: true,
        interactive: staged.interactive,
        bytes: staged.bytes,
        element_count: staged.element_count,
        width_mode: staged.spec.config.width_mode,
        ...(staged.spec.views.length ? { views: staged.spec.views.map(v => v.id), default_view: staged.spec.default_view } : {}),
        ...(staged.spec.actions.length ? { actions: staged.spec.actions.map(a => a.id) } : {}),
        summary: staged.summary.slice(0, 500),
        notice: 'Feishu Card JSON 2.0 validated and staged. Finish with a brief text summary as fallback.',
      };
    } catch (error) {
      if (error instanceof HttpError) return { error: error.code, detail: (error as { detail?: string }).detail ?? error.code };
      throw error;
    }
  }
}

export function applyInteractiveCardAction(
  spec: SanitizedCardSpec,
  state: InteractiveCardState,
  cardId: string,
  act: string,
  option?: string,
): { kind: 'update'; nextState: InteractiveCardState; toast: string } | { kind: 'followup'; label: string; prompt: string } | { kind: 'invalid'; toast: string } {
  const { actions } = renderFeishuCard(spec, state, cardId);
  const descriptor = actions[act];
  if (!descriptor) return { kind: 'invalid', toast: '该操作已过期，请刷新卡片后重试' };

  if (descriptor.kind === 'followup') {
    return { kind: 'followup', label: descriptor.label, prompt: descriptor.prompt! };
  }
  const next: InteractiveCardState = {
    view: state.view,
    lists: Object.fromEntries(Object.entries(state.lists).map(([k, v]) => [k, { page: v.page, filters: { ...v.filters } }])),
  };
  if (descriptor.kind === 'view') {
    if (!spec.views.some(v => v.id === descriptor.target)) return { kind: 'invalid', toast: '视图不存在' };
    next.view = descriptor.target;
    return { kind: 'update', nextState: next, toast: `已切换至「${descriptor.label}」` };
  }
  if (descriptor.kind === 'view_select') {
    const view = spec.views.find(v => v.id === option);
    if (!view) return { kind: 'invalid', toast: '所选视图无效' };
    next.view = view.id;
    return { kind: 'update', nextState: next, toast: `已切换至「${view.label}」` };
  }
  const listState = next.lists[descriptor.target] ?? { page: 0, filters: {} };
  next.lists[descriptor.target] = listState;
  if (descriptor.kind === 'page') {
    listState.page = Math.max(0, (listState.page ?? 0) + (descriptor.delta ?? 0));
    return { kind: 'update', nextState: next, toast: `第 ${listState.page + 1} 页` };
  }
  if (descriptor.kind === 'filter') {
    if (!option || !descriptor.options?.includes(option)) return { kind: 'invalid', toast: '所选筛选条件无效' };
    if (option === '__all__') delete listState.filters[descriptor.field!];
    else listState.filters[descriptor.field!] = option;
    listState.page = 0;
    return { kind: 'update', nextState: next, toast: option === '__all__' ? `${descriptor.label}：全部` : `${descriptor.label}：${option}` };
  }
  if (descriptor.kind === 'reset') {
    listState.filters = {};
    listState.page = 0;
    return { kind: 'update', nextState: next, toast: '已重置筛选条件' };
  }
  return { kind: 'invalid', toast: '不支持的操作' };
}

export function interactiveCardStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS channel_interactive_cards(
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      chat_id TEXT NOT NULL REFERENCES channel_chats(id) ON DELETE CASCADE,
      chat_type TEXT NOT NULL,
      remote_message_id TEXT,
      outbox_id TEXT,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      fence TEXT NOT NULL,
      spec TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS channel_interactive_cards_message ON channel_interactive_cards(connector_id,remote_message_id);
    CREATE INDEX IF NOT EXISTS channel_interactive_cards_chat ON channel_interactive_cards(chat_id,expires_at);
  `);
}

export class ChannelInteractiveCards {
  constructor(private readonly store: Store) {}
  create(input: {
    connector_id: string; chat_id: string; chat_type: 'p2p' | 'group';
    owner_kind: 'personal' | 'group'; owner_id: string; fence: string;
    spec: SanitizedCardSpec; state: InteractiveCardState;
    footer_note?: string; console_url?: string; now?: number;
  }): { id: string; rendered: Json; summary: string } {
    const id = randomId(), now = input.now ?? Date.now();
    const { card, summary } = renderFeishuCard(input.spec, input.state, id, { footerNote: input.footer_note, consoleUrl: input.console_url });
    this.store.run(
      `INSERT INTO channel_interactive_cards(id,connector_id,chat_id,chat_type,owner_kind,owner_id,fence,spec,state,revision,expires_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?)`,
      id, input.connector_id, input.chat_id, input.chat_type, input.owner_kind, input.owner_id, input.fence,
      this.store.secrets.seal({ spec: input.spec, footer_note: input.footer_note, console_url: input.console_url }, 'channel-interactive-card:' + id),
      JSON.stringify(input.state), now + feishuCardTtlMs, now, now,
    );
    return { id, rendered: card, summary };
  }
  attachMessage(id: string, remoteMessageId: string, outboxId?: string): void {
    this.store.run('UPDATE channel_interactive_cards SET remote_message_id=?,outbox_id=coalesce(outbox_id,?),updated_at=? WHERE id=?',
      remoteMessageId, outboxId ?? null, Date.now(), id);
  }
  get(id: string, connectorId: string): Row | undefined {
    return this.store.get('SELECT * FROM channel_interactive_cards WHERE id=? AND connector_id=?', id, connectorId);
  }
  openSpec(row: Row): { spec: SanitizedCardSpec; footer_note?: string; console_url?: string } {
    return this.store.secrets.open(row.spec, 'channel-interactive-card:' + row.id) as unknown as { spec: SanitizedCardSpec; footer_note?: string; console_url?: string };
  }
  saveState(id: string, expectedRevision: number, state: InteractiveCardState): number | null {
    const next = expectedRevision + 1;
    const changed = this.store.run('UPDATE channel_interactive_cards SET state=?,revision=?,updated_at=? WHERE id=? AND revision=?',
      JSON.stringify(state), next, Date.now(), id, expectedRevision).changes;
    return changed ? next : null;
  }
  prune(now = Date.now()): void {
    this.store.run('DELETE FROM channel_interactive_cards WHERE expires_at<?', now - 7 * 24 * 3600_000);
  }
}
