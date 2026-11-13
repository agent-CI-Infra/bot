// The CI observation's advice is the model's Markdown. It is drawn with text nodes only, never parsed as HTML: headings,
// list items and paragraphs keep their lines, and `code`, **bold** and http(s) links become elements.
function releaseAdviceInline(target, text) {
  let at = 0;
  for (const match of text.matchAll(/`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
    target.append(text.slice(at, match.index));
    target.append(match[1] ? element('code', match[1]) : match[2] ? element('strong', match[2]) : link(match[4], match[3]));
    at = match.index + match[0].length;
  }
  target.append(text.slice(at)); return target;
}
function releaseAdvice(markdown) {
  const box = element('div', '', 'release-advice'); let list = null;
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.trimEnd(), heading = /^#{1,6}\s+(.*)$/.exec(line), item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line.trim()) { list = null; continue; }
    if (heading) { list = null; box.append(releaseAdviceInline(element('h4', ''), heading[1])); continue; }
    if (item) {
      const tag = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) { list = element(tag, ''); box.append(list); }
      list.append(releaseAdviceInline(element('li', ''), item[2])); continue;
    }
    list = null; box.append(releaseAdviceInline(element('p', ''), line.trim()));
  }
  return box;
}
