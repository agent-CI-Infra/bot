function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export function renderIndex(boards) {
  const cards = boards
    .map(
      (board) => `      <a class="card" href="${escapeHtml(board.boardUrl)}">
        <span class="repo">${escapeHtml(board.repository.name)}</span>
        <span class="label">${escapeHtml(board.label)}</span>
        <span class="meta">${board.generatedAt ? `更新于 ${escapeHtml(board.generatedAt.slice(0, 10))}` : '等待首次采集'}</span>
      </a>`
    )
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>单仓看板 · Dashboard</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --ink: #1c2430; --dim: #61708a; --line: #dde3ec; --accent: #2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111827; --card: #1c2534; --ink: #e5e9f0; --dim: #98a6bc; --line: #2d3a4f; --accent: #7aa2ff; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 40px 22px 64px; }
  a { color: inherit; text-decoration: none; }
  .back { color: var(--dim); font-size: 13px; }
  .back:hover { color: var(--accent); }
  h1 { margin: 14px 0 6px; font-size: 28px; letter-spacing: -0.02em; }
  p.lead { margin: 0 0 28px; color: var(--dim); max-width: 680px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
  .card { display: flex; flex-direction: column; gap: 3px; padding: 16px 17px; border: 1px solid var(--line); border-radius: 12px; background: var(--card); transition: border-color .15s, transform .15s; }
  .card:hover { border-color: var(--accent); transform: translateY(-1px); }
  .repo { font-weight: 600; overflow-wrap: anywhere; }
  .label { color: var(--dim); font-size: 13px; }
  .meta { margin-top: 8px; color: var(--dim); font-size: 12px; }
  .empty { padding: 28px; border: 1px dashed var(--line); border-radius: 12px; color: var(--dim); }
  footer { margin-top: 30px; color: var(--dim); font-size: 12px; }
</style>
</head>
<body>
<main>
  <a class="back" href="/dashboard/">← 公共多仓 Dashboard</a>
  <h1>单仓看板</h1>
  <p class="lead">每个代码仓一个看板，由 bot 在 webhook 入口托管；公开仓默认提供，私有仓需管理员在仓库列表开启看板。</p>
  <div class="grid">
${cards || '    <div class="empty">还没有看板。安装覆盖公开仓后默认提供；私有仓需管理员在仓库列表开启看板。</div>'}
  </div>
  <footer>已验证的 webhook 自动触发数据更新。</footer>
</main>
</body>
</html>
`
}
