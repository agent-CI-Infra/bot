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
  const post = Array.isArray(data?.content) ? data : Object.values(data ?? {}).find((p: any) => Array.isArray(p?.content)) as any;
  if (!post) return '';
  const element = (el: any): string => {
    if (el.tag === 'img') return '[图片]';
    if (el.tag === 'media') return '[视频附件]';
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
