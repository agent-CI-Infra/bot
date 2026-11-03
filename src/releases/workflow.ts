import { parseDocument } from 'yaml';

// GitHub filter syntax differs from shell globs: ? and + quantify the preceding character.
// https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#filter-pattern-cheat-sheet
export function matches(pattern: string, value: string): boolean {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') { const next = pattern[++i]; if (!next) throw new Error('invalid_filter_escape'); source += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    else if (c === '*') { if (pattern[i + 1] === '*') { source += '.*'; i++; } else source += '[^/]*'; }
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1), content = pattern.slice(i + 1, end);
      if (end < 0 || !/^[A-Za-z0-9-]+$/.test(content)) throw new Error('invalid_filter_class');
      source += '[' + content + ']'; i = end;
    } else if (c === '+' || c === '?') { if (!source || /[*+?]$/.test(source)) throw new Error('invalid_filter_quantifier'); source += c; }
    else source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + source + '$').test(value);
}
export function filter(patterns: string[], value: string): { matched: boolean; reason: string } {
  let matched = false, reason = `没有规则匹配 ${value}`;
  for (const p of patterns) if (matches(p.startsWith('!') ? p.slice(1) : p, value)) {
    matched = !p.startsWith('!'); reason = `${value} ${matched ? '匹配' : '被排除于'} ${p}`;
  }
  return { matched, reason };
}
export function releaseWorkflow(content: string, version: string) {
  const doc = parseDocument(content, { uniqueKeys: true });
  if (doc.errors.length) throw new Error('Release workflow YAML 无法解析');
  const data = doc.toJS({ maxAliasCount: 50 }), push = data?.on?.push;
  const tags = push?.tags;
  if (!Array.isArray(tags) || !tags.length || tags.some(p => typeof p !== 'string' || !p.length) || push['tags-ignore'] !== undefined)
    throw new Error('on.push.tags 必须包含版本标签规则，不能同时配置 tags-ignore');
  // Validate every pattern, including exclusions which do not match the sample.
  for (const p of tags) matches(p.startsWith('!') ? p.slice(1) : p, 'v0.0.0');
  if (!tags.some(p => !p.startsWith('!') && p.startsWith('v') && /[*+?[]/.test(p))) throw new Error('on.push.tags 没有 v* 版本标签触发规则');
  const match = filter(tags, version || 'v1.2.3');
  return { name: String(data.name || 'Release'), tags, matched: match.matched, reason: match.reason,
    // With explicit tags and no branch filters GitHub does not trigger on branch pushes.
    branch_trigger: push.branches !== undefined || push['branches-ignore'] !== undefined,
    branches: push.branches, branches_ignore: push['branches-ignore'] };
}
