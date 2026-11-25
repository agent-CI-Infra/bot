// Only these self-identifying formats are recognized without a registered value.
// An installation token can wrap a JWT. gh auth status replaces its final component with stars.
// Consume the wrapper and the components together, leaving adjacent punctuation in the comment.
const installationToken = String.raw`(?:gh[pousr]_|github_pat_)\d+_(?=[\w.*-]{20})[\w-]+(?:\.[\w-]+\.[\w-]+|(?:\.[\w-]+)?(?=\*))`;
const githubBoundary = String.raw`(?:\b|(?<=\\[nrt]|\x1b\[[0-9;]{0,32}m))`;
export const githubTokenSource = githubBoundary + '(?:' + installationToken + String.raw`|gh[pousr]_(?=[\w*]{30})\w+|github_pat_(?=[\w*]{22})\w+)\**`;
const providerTokenSource = String.raw`\b(?:sk-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{20,}|rrt_(?:[\w-]{12}\.[\w-]{43}|[\w-]{16,})|bsync_(?:[a-f0-9]{12}\.[a-f0-9]{48}|[\w-]{16,}))`;
const tokens = new RegExp(githubTokenSource + '|' + providerTokenSource, 'g');
const pemDelimiter = /-----(BEGIN|END) ([A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?)-----/g;
const marker = '[REDACTED]';

function mapStrings(value, clean, keys = false) {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(item => mapStrings(item, clean, keys));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [keys ? clean(key) : key, mapStrings(item, clean, keys)]));
  return value;
}

function literalPattern(forms) {
  const escaped = [...forms].sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(escaped.join('|'), 'g');
}

export class Redactor {
  values = new Set();
  #raw;
  #public;
  add(value) {
    if (typeof value !== 'string' || value.length < 8 || this.values.has(value)) return;
    this.values.add(value);
    this.#raw = this.#public = undefined;
  }
  // Internal tools exchange Base64 protocol frames. Only publication examines encoded representations.
  text(value) {
    if (!this.values.size) return value;
    this.#raw ??= literalPattern(this.values);
    return value.replace(this.#raw, marker);
  }
  clean(value) { return mapStrings(value, text => this.text(text)); }
  contains(bytes) { return [...this.values].some(value => bytes.includes(Buffer.from(value))); }
  get publicationPattern() {
    if (!this.#public && this.values.size) {
      const forms = new Set(this.values);
      for (const value of this.values) {
        const text = value.toWellFormed(), base64 = Buffer.from(text).toString('base64');
        forms.add(encodeURIComponent(text));
        forms.add(text.split('/').map(encodeURIComponent).join('/'));
        forms.add(new URLSearchParams([['', text]]).toString().slice(1));
        for (const encoded of [base64, base64.replace(/\+/g, '-').replace(/\//g, '_')]) {
          forms.add(encoded); forms.add(encoded.replace(/=+$/, ''));
        }
      }
      this.#public = literalPattern(forms);
    }
    return this.#public;
  }
}

// Coalesce overlapping matches so a registered value inside a token (or vice versa) cannot leave a suffix visible.
export function publicText(value, redactor) {
  const spans = [];
  for (const pattern of [tokens, redactor.publicationPattern]) {
    if (pattern) for (const m of value.matchAll(pattern)) spans.push([m.index, m.index + m[0].length]);
  }
  let start;
  for (const m of value.matchAll(pemDelimiter)) {
    if (m[1] === 'BEGIN') start = m;
    else if (start?.[2] === m[2]) { spans.push([start.index, m.index + m[0].length]); start = undefined; }
  }
  if (!spans.length) return value;
  spans.sort((a, b) => a[0] - b[0]);
  let result = '', end = 0;
  for (const [from, to] of spans) {
    if (from >= end) result += value.slice(end, from) + marker;
    end = Math.max(end, to);
  }
  return result + value.slice(end);
}

export function publicContent(value, redactor) { return mapStrings(value, text => publicText(text, redactor), true); }
