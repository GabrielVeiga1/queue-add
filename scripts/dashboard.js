"use strict";
const http = require("http");
const store = require("./lib/store");

const STATUS_COLOR = {
  queued: "#8b8b8b",
  running: "#2e8bff",
  done: "#2ecc71",
  failed: "#ff5555",
  rate_limited: "#f1c40f",
};

const PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<title>claude-queue dashboard</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0e0f12; color:#e6e6e6; font-family: ui-monospace, Menlo, Consolas, monospace; margin:0; padding:24px; }
  h1 { font-size:18px; font-weight:600; margin:0 0 4px; }
  .sub { color:#888; font-size:12px; margin-bottom:20px; }
  table { width:100%; border-collapse: collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #22242a; }
  th { color:#999; font-weight:500; text-transform:uppercase; font-size:11px; letter-spacing:.04em; }
  .status { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; color:#0e0f12; }
  .prompt { color:#ccc; max-width:480px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .empty { color:#666; padding:40px 0; text-align:center; }
  .stats { display:flex; gap:24px; margin-bottom:20px; }
  .stat { background:#17181d; border:1px solid #22242a; border-radius:8px; padding:10px 16px; }
  .stat .n { font-size:20px; font-weight:700; }
  .stat .l { font-size:11px; color:#888; text-transform:uppercase; }
</style>
</head>
<body>
  <h1>claude-queue</h1>
  <div class="sub">atualiza a cada 3s — sem chamadas ao Claude, só lê ~/.claude-queue/tasks.json</div>
  <div class="stats" id="stats"></div>
  <table>
    <thead><tr><th>status</th><th>id</th><th>prioridade</th><th>dir</th><th>prompt</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="empty" style="display:none">fila vazia</div>

<script>
// as tasks (prompt, dir, id) são texto digitado pelo usuário e podem conter
// HTML/JS — nunca jogar direto em innerHTML sem escapar (o próprio README
// avisa: "evite colar código ali dentro", mas é bug nosso depender disso).
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function tick() {
  const res = await fetch('/api/tasks');
  const tasks = await res.json();
  const rows = document.getElementById('rows');
  const empty = document.getElementById('empty');
  const statsEl = document.getElementById('stats');

  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  statsEl.innerHTML = Object.entries(byStatus).map(([s, n]) =>
    \`<div class="stat"><div class="n">\${n}</div><div class="l">\${esc(s)}</div></div>\`
  ).join('') || '';

  if (tasks.length === 0) {
    rows.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  const colors = ${JSON.stringify(STATUS_COLOR)};
  const sorted = [...tasks].sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at));
  rows.innerHTML = sorted.map(t => \`
    <tr>
      <td><span class="status" style="background:\${colors[t.status] || '#888'}" title="\${esc(t.fail_reason || '')}">\${esc(t.status)}\${t.fail_reason ? ' ⓘ' : ''}</span></td>
      <td>\${esc(t.id)}</td>
      <td>\${esc(t.priority)}</td>
      <td title="\${esc(t.dir)}">\${esc(t.dir.split(/[\\\\/]/).pop())}</td>
      <td class="prompt" title="\${esc(t.prompt)}">\${esc(t.prompt)}</td>
    </tr>
  \`).join('');
}
tick();
setInterval(tick, 3000);
</script>
</body>
</html>`;

function parsePort(args) {
  if (args.port === undefined) return 4317;
  const port = typeof args.port === "string" ? parseInt(args.port, 10) : NaN;
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    console.error(`aviso: --port inválido (recebido "${args.port}"), usando a porta padrão 4317`);
    return 4317;
  }
  return port;
}

function start(args) {
  const port = parsePort(args);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const server = http.createServer((req, res) => {
    // Bind em 127.0.0.1 já bloqueia conexão de rede externa direta, mas não
    // protege contra DNS rebinding (um domínio que resolve pra 127.0.0.1
    // depois de enganar o navegador) — nesse ataque o header Host continua
    // sendo o domínio do atacante, nunca 127.0.0.1/localhost, então essa
    // checagem barra exatamente esse caso sem afetar o uso normal (a própria
    // página do dashboard sempre faz fetch pra mesma origem).
    if (!allowedHosts.has(req.headers.host)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    if (req.url === "/api/tasks") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(store.load()));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`erro: porta ${port} já está em uso — tente '/queue dashboard --port <outra>'`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`dashboard rodando em http://127.0.0.1:${port} (Ctrl+C pra parar)`);
  });
}

module.exports = { start };
