/**
 * A unified line diff (`-` removed, `+` added, ` ` context) for showing what a gate PR changes in an existing file.
 * Workflow and config files are small, so a longest-common-subsequence table is enough.
 */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const a = before.replace(/\n$/, '').split('\n'), b = after.replace(/\n$/, '').split('\n');
  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const lines: { mark: ' ' | '-' | '+'; text: string; a: number; b: number }[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { lines.push({ mark: ' ', text: a[i]!, a: i++, b: j++ }); continue; }
    if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) lines.push({ mark: '+', text: b[j]!, a: i, b: j++ });
    else lines.push({ mark: '-', text: a[i]!, a: i++, b: j });
  }
  // Keep changed lines with `context` lines around them; gaps become hunk headers.
  const keep = lines.map(() => false);
  lines.forEach((line, index) => { if (line.mark !== ' ') for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true; });
  const out: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (!keep[index]) { index++; continue; }
    let end = index; while (end < lines.length && keep[end]) end++;
    const hunk = lines.slice(index, end), oldCount = hunk.filter(line => line.mark !== '+').length, newCount = hunk.filter(line => line.mark !== '-').length;
    out.push(`@@ -${hunk[0]!.a + (oldCount ? 1 : 0)},${oldCount} +${hunk[0]!.b + (newCount ? 1 : 0)},${newCount} @@`, ...hunk.map(line => line.mark + line.text));
    index = end;
  }
  return out.join('\n');
}
