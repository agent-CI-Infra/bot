import { marked } from 'marked';
import type { Json } from '../core/security.js';

const label = (value: string) => value.replace(/[\\[\]]/g, '\\$&');
const literal = (value: string) => value.replace(/</g, '&lt;').replace(/>/g, '&gt;');
function webLink(value: string, origin: string): string | undefined {
  try {
    if (value.startsWith('//')) return;
    const url = value.startsWith('/') ? new URL(value, origin) : new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Non-web links remain readable labels. */ }
}

/** Native post Markdown supports CommonMark/GFM, with a few documented exceptions. Never trust native tags or image keys from a model. */
export function feishuMarkdown(value: string, origin = ''): string {
  const inline = (tokens: any[]): string => tokens.map(t => {
    switch (t.type) {
      case 'link': { const url = webLink(t.href, origin), text = inline(t.tokens); return url ? `[${text}](${url.replace(/[()<>\s]/g, (c: string) => encodeURIComponent(c))})` : text; }
      case 'image': { const url = webLink(t.href, origin), text = label(t.text || '图片'); return url ? `[图片：${text}](${url.replace(/[()<>\s]/g, (c: string) => encodeURIComponent(c))})` : `\\[图片：${text}\\]`; }
      case 'html': return literal(t.raw);
      case 'strong': return '**' + inline(t.tokens) + '**';
      case 'em': return '*' + inline(t.tokens) + '*';
      case 'del': return '~~' + inline(t.tokens) + '~~';
      case 'codespan': return t.raw;
      case 'br': return '  \n';
      default: return t.tokens ? inline(t.tokens) : literal(t.raw ?? t.text ?? '');
    }
  }).join('');
  const blocks = (tokens: any[]): string => tokens.map(t => {
    switch (t.type) {
      case 'space': case 'def': case 'checkbox': return '';
      case 'heading': return '#'.repeat(t.depth) + ' ' + inline(t.tokens);
      case 'paragraph': case 'text': return t.tokens ? inline(t.tokens) : literal(t.text);
      case 'code': {
        const fence = '`'.repeat(Math.max(3, ...[...t.text.matchAll(/`+/g)].map(m => m[0].length + 1)));
        return (t.lang === 'mermaid' ? '流程图源码（飞书不绘制图形）：\n\n' : '') + fence + String(t.lang ?? '').replace(/[^\w+-]/g, '') + '\n' + t.text + '\n' + fence;
      }
      case 'blockquote': return blocks(t.tokens).split('\n').map(line => '> ' + line).join('\n');
      case 'hr': return '---';
      case 'list': return t.items.map((item: any, i: number) => {
        const prefix = t.ordered ? `${Number(t.start) + i}. ` : '- ';
        const body = (item.task ? (item.checked ? '[x] ' : '[ ] ') : '') + blocks(item.tokens.filter((token:any)=>token.type!=='checkbox'));
        return prefix + body.split('\n').join('\n' + ' '.repeat(prefix.length));
      }).join('\n');
      case 'table': {
        const row = (cells: any[]) => '| ' + cells.map(c => inline(c.tokens).replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ') + ' |';
        return [row(t.header), '| ' + t.header.map(() => '---').join(' | ') + ' |', ...t.rows.map(row)].join('\n');
      }
      case 'html': return literal(t.raw);
      default: return literal(t.raw ?? t.text ?? '');
    }
  }).filter(Boolean).join('\n\n');
  try { return blocks(marked.lexer(value, { gfm: true })); }
  catch { return literal(value); }
}

/** Bound the serialized (twice-escaped) request below Feishu's 30 KB post limit, including CJK and emoji. */
export function markdownPosts(value: string, origin = ''): Json[] {
  const markdown = feishuMarkdown(value, origin), chunks: {text:string;plain?:boolean}[] = [];
  let blocks:string[],plain=false;
  try{blocks=marked.lexer(markdown).filter(t=>t.type!=='space').map(t=>t.raw.trimEnd());}
  catch{blocks=[markdown];plain=true;}
  let current = '';
  for (const block of blocks) {
    if (Buffer.byteLength(JSON.stringify(JSON.stringify(current + '\n\n' + block))) <= 18000) { current += (current ? '\n\n' : '') + block; continue; }
    if (current) chunks.push({text:current,plain}); current = '';
    if (Buffer.byteLength(JSON.stringify(JSON.stringify(block))) <= 18000) { current = block; continue; }
    // A single oversized block is preserved verbatim as readable text, rather than cutting a fence/table in half.
    let piece = '', bytes=6;
    for (const char of block) {
      const size=Buffer.byteLength(JSON.stringify(JSON.stringify(char)))-6;
      if (bytes+size > 17000) { chunks.push({text:piece,plain:true}); piece = '';bytes=6; }
      piece += char;bytes+=size;
    }
    if (piece) chunks.push({text:piece,plain:true});
  }
  if (current) chunks.push({text:current,plain});
  return chunks.map(({text,plain}) => ({ zh_cn: { title: '', content: [[{ tag: plain?'text':'md', text }]] } }));
}

/** Keep native post paragraphs, inline styles, links, mentions and code boundaries on ingress. */
export function postText(data: any, mention?: (id: string, name: string) => string, renderText: (value: string) => string = value => value): string {
  const post = Array.isArray(data?.content) ? data
    : Array.isArray(data?.zh_cn?.content) ? data.zh_cn
    : Object.values(data ?? {}).find((p: any) => Array.isArray(p?.content)) as any;
  if (!post) return '';
  const element = (el: any): string => {
    if (!el || typeof el !== 'object') return '';
    if (el.tag === 'img') return '[图片]';
    if (el.tag === 'media') return el.file_name ? `[视频附件：${renderText(String(el.file_name))}]` : '[视频附件]';
    if (el.tag === 'emotion') return el.emoji_type ? `[表情：${String(el.emoji_type)}]` : '[表情]';
    if (el.tag === 'at') return mention ? mention(String(el.user_id ?? ''), String(el.user_name ?? '')) : String(el.user_id ?? el.user_name ?? '');
    if (el.tag === 'hr') return '\n---\n';
    if (el.tag === 'code_block') return '\n````' + String(el.language ?? '').replace(/[^\w+-]/g, '') + '\n' + renderText(String(el.text ?? '')).replace(/`{4}/g, '` ` ` `') + '\n````\n';
    if (el.tag === 'md') return renderText(String(el.text ?? ''));
    if (el.tag === 'a') { const url = webLink(String(el.href ?? ''), ''); return url ? `[${label(renderText(String(el.text ?? url)))}](${url})` : renderText(String(el.text ?? '')); }
    let text = renderText(String(el.text ?? ''));
    for (const [style, mark] of [['lineThrough', '~~'], ['italic', '*'], ['bold', '**']]) {
      if (Array.isArray(el.style) && el.style.includes(style)) text = text.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_: string, a: string, b: string, c: string) => b ? a + mark + b + mark + c : text);
    }
    return text;
  };
  return [post.title ? renderText(String(post.title)) : '', ...(post.content as any[]).map(line => Array.isArray(line) ? line.map(element).join('') : '')].filter(Boolean).join('\n').trim();
}

function localizedString(value: any): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const key of ['zh_cn', 'en_us', 'ja_jp']) if (typeof value[key] === 'string' && value[key]) return value[key];
  const first = Object.values(value).find(v => typeof v === 'string' && v);
  return typeof first === 'string' ? first : '';
}

function cardTextValue(node: any, renderText: (value: string) => string): string {
  if (typeof node === 'string') return renderText(node);
  if (!node || typeof node !== 'object') return '';
  if (typeof node.content === 'string') return renderText(node.content);
  if (typeof node.text === 'string') return renderText(node.text);
  if (node.i18n_content) return renderText(localizedString(node.i18n_content));
  if (node.i18n) return renderText(localizedString(node.i18n));
  if (node.text && typeof node.text === 'object') return cardTextValue(node.text, renderText);
  return '';
}

function cardUrl(node: any): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const candidates: unknown[] = [node.url, node.href, node.default_url, node.pc_url, node.android_url, node.ios_url];
  if (node.multi_url && typeof node.multi_url === 'object') {
    candidates.push(node.multi_url.url, node.multi_url.pc_url, node.multi_url.android_url, node.multi_url.ios_url);
  }
  if (Array.isArray(node.behaviors)) {
    for (const b of node.behaviors) {
      if (b?.type === 'open_url') candidates.push(b.default_url, b.pc_url, b.android_url, b.ios_url, b.url);
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const url = webLink(candidate, '');
      if (url) return url;
    }
  }
  return undefined;
}

/**
 * Parse Feishu interactive cards across Card JSON 2.0 (body.elements), Card JSON 1.0 (elements),
 * simplified received cards (2D inline element rows), wrapped { card }, i18n variants and templates.
 */
export function cardText(data: any, mention?: (id: string, name: string) => string, renderText: (value: string) => string = value => value): string {
  if (!data || typeof data !== 'object') return '[卡片消息]';
  let root = data.card && typeof data.card === 'object' && !Array.isArray(data.card) ? data.card : data;
  if (!root.header && !root.elements && !root.body && !root.title && !root.i18n_elements && !root.i18n_header && root.type !== 'template') {
    const localized = (root.zh_cn && typeof root.zh_cn === 'object' ? root.zh_cn : Object.values(root).find((v: any) => v && typeof v === 'object' && (v.elements || v.body || v.header || v.title)));
    if (localized) root = localized;
  }
  if (root.type === 'template' && root.data && typeof root.data === 'object') {
    const id = typeof root.data.template_id === 'string' ? root.data.template_id : '';
    const vars = root.data.template_variable ? summarizePayload(root.data.template_variable, renderText) : '';
    return [`[卡片模板${id ? '：' + id : ''}]`, vars].filter(Boolean).join('\n');
  }

  const renderInline = (el: any, depth: number): string => {
    if (!el || typeof el !== 'object' || depth > 20) return '';
    if (el.tag === 'img') {
      const caption = cardTextValue(el.alt ?? el.title, renderText).trim();
      return caption ? `[图片：${caption}]` : '[图片]';
    }
    if (el.tag === 'media') return el.file_name ? `[视频附件：${renderText(String(el.file_name))}]` : '[视频附件]';
    if (el.tag === 'emotion') return el.emoji_type ? `[表情：${String(el.emoji_type)}]` : '[表情]';
    if (el.tag === 'at') return mention ? mention(String(el.user_id ?? ''), String(el.user_name ?? '')) : String(el.user_name ?? el.user_id ?? '');
    if (el.tag === 'hr') return '\n---\n';
    if (el.tag === 'code_block') return '\n````' + String(el.language ?? '').replace(/[^\w+-]/g, '') + '\n' + renderText(String(el.text ?? el.content ?? '')).replace(/`{4}/g, '` ` ` `') + '\n````\n';
    if (el.tag === 'a') {
      const url = cardUrl(el), text = renderText(String(el.text ?? el.content ?? url ?? ''));
      return url ? `[${label(text)}](${url})` : text;
    }
    if (el.tag === 'button') return renderButton(el);
    if (el.tag === 'md' || el.tag === 'markdown' || el.tag === 'lark_md') return cardTextValue(el, renderText);
    return cardTextValue(el, renderText);
  };

  const renderButton = (el: any): string => {
    const text = cardTextValue(el.text, renderText).trim() || '按钮';
    const url = cardUrl(el);
    return url ? `[${label(text)}](${url})` : `[按钮：${text}]`;
  };

  const renderCell = (value: any, depth: number): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return renderText(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(item => renderCell(item, depth + 1)).filter(Boolean).join('、');
    if (typeof value === 'object') {
      if (value.tag) return renderBlock(value, depth + 1);
      if (value.text !== undefined || value.content !== undefined) return cardTextValue(value, renderText);
      if (typeof value.name === 'string') return renderText(value.name);
      return summarizePayload(value, renderText, depth + 1, 500);
    }
    return '';
  };

  const renderTable = (el: any, depth: number): string => {
    const columns = Array.isArray(el.columns) ? el.columns : [];
    const rows = Array.isArray(el.rows) ? el.rows : [];
    if (!columns.length && !rows.length) return '';
    const cols = columns.length ? columns : Object.keys(rows[0] ?? {}).map(name => ({ name, display_name: name }));
    const clean = (cell: string) => cell.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n+/g, ' ').trim();
    const header = '| ' + cols.map((c: any) => clean(renderText(String(c.display_name ?? c.name ?? '')))).join(' | ') + ' |';
    const sep = '| ' + cols.map(() => '---').join(' | ') + ' |';
    const body = rows.map((row: any) => '| ' + cols.map((c: any) => clean(renderCell(row?.[c.name], depth + 1))).join(' | ') + ' |');
    return [header, sep, ...body].join('\n');
  };

  const renderBlock = (el: any, depth: number): string => {
    if (!el || depth > 20) return '';
    if (Array.isArray(el)) return el.map(item => renderInline(item, depth + 1)).join('').trim();
    if (typeof el !== 'object') return typeof el === 'string' ? renderText(el) : '';
    const tag = typeof el.tag === 'string' ? el.tag : '';
    switch (tag) {
      case 'markdown':
      case 'lark_md':
      case 'md':
      case 'plain_text':
      case 'text':
        return cardTextValue(el, renderText).trim();
      case 'hr':
        return '---';
      case 'img': {
        const caption = cardTextValue(el.alt ?? el.title, renderText).trim();
        return caption ? `[图片：${caption}]` : '[图片]';
      }
      case 'img_combination': {
        const count = Array.isArray(el.img_list) ? el.img_list.length : 0;
        return count > 1 ? `[图片组（${count} 张）]` : '[图片]';
      }
      case 'media':
        return el.file_name ? `[视频附件：${renderText(String(el.file_name))}]` : '[视频附件]';
      case 'div': {
        const parts: string[] = [];
        const main = cardTextValue(el.text, renderText).trim();
        if (main) parts.push(main);
        if (Array.isArray(el.fields)) {
          for (const field of el.fields) {
            const text = cardTextValue(field?.text, renderText).trim();
            if (text) parts.push(text);
          }
        }
        if (el.extra) {
          const extra = renderBlock(el.extra, depth + 1);
          if (extra) parts.push(extra);
        }
        return parts.join('\n');
      }
      case 'note': {
        const items = Array.isArray(el.elements) ? el.elements.map((child: any) => renderInline(child, depth + 1).trim()).filter(Boolean) : [];
        return items.join(' ');
      }
      case 'action': {
        const actions = Array.isArray(el.actions) ? el.actions.map((child: any) => renderBlock(child, depth + 1)).filter(Boolean) : [];
        return actions.join(' ');
      }
      case 'button':
        return renderButton(el);
      case 'overflow': {
        const opts = Array.isArray(el.options) ? el.options.map((opt: any) => {
          const text = cardTextValue(opt?.text, renderText).trim();
          const url = cardUrl(opt);
          return url && text ? `[${label(text)}](${url})` : text;
        }).filter(Boolean) : [];
        return opts.join(' / ');
      }
      case 'column_set': {
        const cols = Array.isArray(el.columns) ? el.columns.map((col: any) => renderList(col?.elements, depth + 1)).filter(Boolean) : [];
        return cols.join('\n\n');
      }
      case 'collapsible_panel': {
        const title = cardTextValue(el.header?.title, renderText).trim();
        const body = renderList(el.elements, depth + 1);
        return [title ? `**${title}**` : '', body].filter(Boolean).join('\n');
      }
      case 'table':
        return renderTable(el, depth);
      case 'form':
      case 'interactive_container':
      case 'repeat': {
        const body = renderList(el.elements, depth + 1);
        const url = cardUrl(el);
        return [body, url ? `[链接](${url})` : ''].filter(Boolean).join('\n');
      }
      case 'person': {
        const uid = String(el.user_id ?? '');
        return uid ? (mention ? mention(uid, '') : `[用户：${uid}]`) : '';
      }
      case 'person_list': {
        const persons = Array.isArray(el.persons) ? el.persons.map((p: any) => {
          const uid = String(p?.id ?? p?.user_id ?? '');
          return uid ? (mention ? mention(uid, '') : uid) : '';
        }).filter(Boolean) : [];
        return persons.length ? `[成员：${persons.join('、')}]` : '';
      }
      case 'chart': {
        const title = cardTextValue(el.chart_spec?.title?.text ?? el.chart_spec?.title, renderText).trim();
        return title ? `[图表：${title}]` : '[图表]';
      }
      case 'select_static': {
        const selected = typeof el.initial_option === 'string' && Array.isArray(el.options)
          ? el.options.find((o: any) => o?.value === el.initial_option) : undefined;
        const labelText = selected ? cardTextValue(selected.text, renderText).trim() : cardTextValue(el.placeholder, renderText).trim();
        return labelText ? `[选择：${labelText}]` : '';
      }
      case 'input': {
        const name = cardTextValue(el.label ?? el.placeholder, renderText).trim();
        const value = typeof el.default_value === 'string' ? renderText(el.default_value).trim() : '';
        return [name, value].filter(Boolean).join('：');
      }
      case 'a':
      case 'at':
      case 'emotion':
      case 'code_block':
        return renderInline(el, depth);
      default: {
        if (Array.isArray(el.elements)) return renderList(el.elements, depth + 1);
        const fallback = cardTextValue(el.text ?? el, renderText).trim();
        return fallback;
      }
    }
  };

  const renderList = (items: any, depth: number): string => {
    if (!Array.isArray(items) || depth > 20) return '';
    return items.map(item => renderBlock(item, depth + 1)).filter(Boolean).join('\n\n');
  };

  const sections: string[] = [];
  const header = root.header ?? (root.i18n_header && typeof root.i18n_header === 'object' ? (root.i18n_header.zh_cn ?? Object.values(root.i18n_header)[0]) : undefined);
  const title = cardTextValue(header?.title ?? root.title, renderText).trim();
  const subtitle = cardTextValue(header?.subtitle, renderText).trim();
  const tagList = header?.text_tag_list ?? header?.i18n_text_tag_list?.zh_cn;
  const tags = Array.isArray(tagList) ? tagList.map((t: any) => cardTextValue(t?.text, renderText).trim()).filter(Boolean) : [];
  if (title || tags.length) sections.push([title, ...tags.map(t => `[${t}]`)].filter(Boolean).join(' '));
  if (subtitle) sections.push(subtitle);

  const elements = Array.isArray(root.body?.elements) ? root.body.elements
    : Array.isArray(root.elements) ? root.elements
    : root.i18n_elements && typeof root.i18n_elements === 'object' ? (Array.isArray(root.i18n_elements.zh_cn) ? root.i18n_elements.zh_cn : Object.values(root.i18n_elements).find(Array.isArray))
    : undefined;
  const body = renderList(elements, 0);
  if (body) sections.push(body);

  const link = cardUrl(root.card_link);
  if (link) sections.push(`[卡片链接](${link})`);

  const result = sections.join('\n\n').trim();
  return result || '[卡片消息]';
}

/** Extract readable text from a Feishu system message template or arbitrary structured payload. */
export function systemMessageText(data: any, renderText: (value: string) => string = value => value): string {
  if (!data || typeof data !== 'object') return '[系统消息]';
  const formatVar = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return renderText(value);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(formatVar).filter(Boolean).join('、');
    if (typeof value === 'object') {
      const obj = value as Record<string, any>;
      if (obj.i18n_text) return renderText(localizedString(obj.i18n_text));
      if (typeof obj.text === 'string') return renderText(obj.text);
      if (typeof obj.name === 'string') return renderText(obj.name);
      return summarizePayload(obj, renderText, 0, 500);
    }
    return '';
  };
  if (typeof data.template === 'string' && data.template.trim()) {
    const rendered = data.template.replace(/\{([A-Za-z0-9_]+)\}/g, (_: string, key: string) => formatVar(data[key])).replace(/\s+/g, ' ').trim();
    return rendered ? `[系统消息] ${renderText(rendered)}` : '[系统消息]';
  }
  const direct = formatVar(data.divider_text ?? data.text ?? data.content).trim();
  if (direct) return `[系统消息] ${direct}`;
  const summary = summarizePayload(data, renderText, 0, 1000);
  return summary ? `[系统消息] ${summary}` : '[系统消息]';
}

/** Bounded, readable summary for unknown or future Feishu message types. */
export function summarizePayload(value: unknown, renderText: (value: string) => string = value => value, depth = 0, maxChars = 4000): string {
  const parts: string[] = [];
  let length = 0;
  const push = (text: string) => {
    const cleaned = text.trim();
    if (!cleaned || length >= maxChars) return;
    const room = maxChars - length;
    const slice = cleaned.length > room ? cleaned.slice(0, room) : cleaned;
    parts.push(slice);
    length += slice.length + 1;
  };
  const priority = ['title', 'summary', 'topic', 'name', 'text', 'content', 'description', 'message', 'url', 'href'];
  const skipKeys = new Set(['image_key', 'img_key', 'file_key', 'width', 'height', 'style', 'tag']);
  const walk = (node: unknown, level: number): void => {
    if (node === null || node === undefined || level > 10 || length >= maxChars) return;
    if (typeof node === 'string') { push(renderText(node)); return; }
    if (typeof node === 'number' || typeof node === 'boolean') { push(String(node)); return; }
    if (Array.isArray(node)) { for (const item of node) walk(item, level + 1); return; }
    if (typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      const seen = new Set<string>();
      for (const key of priority) {
        if (Object.hasOwn(obj, key) && obj[key] !== undefined && obj[key] !== null) {
          seen.add(key);
          if (key === 'url' || key === 'href') {
            const safe = typeof obj[key] === 'string' ? webLink(obj[key], '') : undefined;
            if (safe) push(safe);
          } else walk(obj[key], level + 1);
        }
      }
      for (const [key, item] of Object.entries(obj)) {
        if (seen.has(key) || skipKeys.has(key) || item === undefined || item === null) continue;
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') push(`${key}: ${renderText(String(item))}`);
        else if (typeof item === 'object') walk(item, level + 1);
      }
    }
  };
  walk(value, depth);
  return parts.join('\n').trim();
}
