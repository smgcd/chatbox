/**
 * The iPad client page, served by the LAN remote host server.
 *
 * Kept as a plain string so the Electron main bundle needs no extra asset
 * pipeline (no `?raw` import, no electron-vite config change). The client only
 * speaks the closed command enum from shared/remote-host.ts.
 *
 * Live updates arrive over Server-Sent Events (/api/events): the renderer
 * pushes ~150ms frames with the streaming text + reasoning. The 3s poll is only
 * for structure (new sessions, final text, tool list).
 *
 * Reasoning is collapsed into a single row and mirrors Chatbox's own thinking
 * row: label + live last line + chevron; tapping expands the full transcript.
 *
 * Note: this string is written without backticks or "${" so it can live inside
 * a template literal safely. Every backslash that must reach the browser is
 * doubled.
 */
export const REMOTE_CLIENT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="format-detection" content="telephone=no">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f6f7f9">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0c0f">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='9' fill='%232f6bff'/%3E%3C/svg%3E">
<title>Chatbox 遥控</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --panel-2: #eef0f4;
    --line: rgba(17, 20, 26, .09);
    --line-strong: rgba(17, 20, 26, .20);
    --fg: #14161a;
    --fg-soft: #3d434d;
    --dim: #6d7580;
    --accent: #2f6bff;
    --accent-ink: #ffffff;
    --ok: #1f9d63;
    --warn: #b97708;
    --err: #d1444a;
    --shadow-sm: 0 1px 2px rgba(16, 20, 28, .06), 0 1px 1px rgba(16, 20, 28, .04);
    --shadow-md: 0 8px 24px rgba(16, 20, 28, .10);
    --radius: 18px;
    --ease: cubic-bezier(.32, .72, 0, 1);
    --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0c0f;
      --panel: #16181d;
      --panel-2: #1d2027;
      --line: rgba(255, 255, 255, .09);
      --line-strong: rgba(255, 255, 255, .24);
      --fg: #e9ecf2;
      --fg-soft: #c3c9d4;
      --dim: #8d95a3;
      --accent: #4f7dff;
      --accent-ink: #ffffff;
      --ok: #4ecf95;
      --warn: #f0b429;
      --err: #ff7a7f;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, .5);
      --shadow-md: 0 12px 32px rgba(0, 0, 0, .55);
    }
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body {
    margin: 0; height: 100%;
    background: var(--bg); color: var(--fg);
    font-family: var(--font);
    font-size: 16px; line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  body { display: flex; flex-direction: column; height: 100dvh; overscroll-behavior: none; }

  /* ── header ─────────────────────────────────────────────── */
  header {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 10px;
    padding: calc(env(safe-area-inset-top) + 9px) 14px 9px;
    background: var(--bg);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: saturate(180%) blur(18px);
    -webkit-backdrop-filter: saturate(180%) blur(18px);
    border-bottom: 1px solid var(--line);
  }
  .status {
    flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%;
    background: var(--dim); transition: background .2s var(--ease), box-shadow .2s var(--ease);
  }
  .status.busy { background: var(--warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 22%, transparent); }
  select {
    flex: 1 1 auto; min-width: 0; height: 36px;
    padding: 0 30px 0 11px;
    font: inherit; font-size: 15px; font-weight: 500; color: var(--fg-soft);
    background: var(--panel) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2.5 4.5 6 8l3.5-3.5' fill='none' stroke='%238a90a0' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 10px center;
    border: 1px solid var(--line); border-radius: 12px;
    appearance: none; -webkit-appearance: none;
    text-overflow: ellipsis; white-space: nowrap; overflow: hidden;
    transition: border-color .18s var(--ease), background-color .18s var(--ease);
  }
  select:focus-visible { outline: none; border-color: var(--accent); }
  button {
    font: inherit; font-size: 15px; font-weight: 600;
    color: var(--fg-soft); background: var(--panel);
    border: 1px solid var(--line); border-radius: 12px;
    height: 36px; padding: 0 12px;
    display: inline-flex; align-items: center; justify-content: center;
    transition: transform .16s var(--ease), background-color .18s var(--ease), color .18s var(--ease), border-color .18s var(--ease), opacity .18s var(--ease);
  }
  button:active { transform: scale(.96); }
  button:disabled { opacity: .38; }
  button.icon { width: 36px; padding: 0; font-size: 19px; font-weight: 400; line-height: 1; }
  button.danger { color: var(--err); border-color: color-mix(in srgb, var(--err) 30%, var(--line)); }
  button.danger.on { background: color-mix(in srgb, var(--err) 12%, var(--panel)); }

  /* ── message list ────────────────────────────────────────── */
  main {
    flex: 1 1 auto; overflow-y: auto; -webkit-overflow-scrolling: touch;
    padding: 16px 16px 8px;
    display: flex; flex-direction: column; gap: 18px;
  }

  .turn { display: flex; flex-direction: column; gap: 8px; }
  .turn.new { animation: turn-in .28s var(--ease) both; }
  @keyframes turn-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .turn.new { animation: none; } }

  .turn.user { align-items: flex-end; }
  .user-bubble {
    max-width: 84%;
    padding: 10px 15px;
    border-radius: 20px 20px 6px 20px;
    background: var(--accent); color: var(--accent-ink);
    box-shadow: var(--shadow-sm);
    white-space: pre-wrap; word-break: break-word;
    transition: box-shadow .2s var(--ease);
  }
  .answer {
    max-width: 100%;
    color: var(--fg);
    white-space: pre-wrap; word-break: break-word;
    letter-spacing: .002em;
  }
  .answer:empty { display: none; }
  .answer code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13.5px;
    background: var(--panel-2); color: var(--fg-soft);
    padding: 1.5px 5px; border-radius: 6px;
  }
  .answer pre {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13px; line-height: 1.55;
    background: var(--panel-2); color: var(--fg-soft);
    padding: 12px 13px; border-radius: 12px;
    overflow-x: auto; margin: 10px 0;
  }
  .answer .h { display: block; font-size: 15.5px; font-weight: 650; margin: 12px 0 4px; }
  .answer .li { display: block; padding-left: 2px; margin: 2px 0; }
  .answer .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 10px 0; }
  .answer table { border-collapse: collapse; width: 100%; font-size: 13.5px; white-space: normal; }
  .answer th, .answer td {
    border: 1px solid var(--line-strong);
    padding: 8px 10px; text-align: left; vertical-align: top;
    white-space: normal; line-height: 1.5;
  }
  .answer th { background: var(--panel-2); font-weight: 650; color: var(--fg); white-space: nowrap; }
  .answer td { color: var(--fg-soft); }
  .answer tr:nth-child(even) td { background: color-mix(in srgb, var(--panel-2) 45%, transparent); }

  /* thinking row: one line, tap to expand */
  .think { border: 1px solid var(--line); border-radius: 13px; background: var(--panel); overflow: hidden; transition: border-color .2s var(--ease); }
  .think-head {
    display: flex; align-items: center; gap: 7px;
    width: 100%; height: 38px; padding: 0 12px;
    background: none; border: 0; border-radius: 0;
    font-size: 13.5px; font-weight: 600; color: var(--dim);
    text-align: left;
  }
  .think-head:active { transform: none; background: var(--panel-2); }
  .think-spark { color: var(--accent); font-size: 13px; line-height: 1; }
  .think-label { flex: 0 0 auto; }
  .think-time { flex: 0 0 auto; font-weight: 500; font-variant-numeric: tabular-nums; opacity: .85; }
  .think-summary {
    flex: 1 1 auto; min-width: 0;
    font-weight: 400; color: var(--dim);
    white-space: nowrap; overflow: hidden; text-overflow: clip;
    opacity: .9;
  }
  .think-caret {
    flex: 0 0 auto; width: 12px; height: 12px; opacity: .7;
    transition: transform .24s var(--ease);
  }
  .think.open .think-caret { transform: rotate(180deg); }
  .think-body {
    max-height: 0; overflow: hidden;
    transition: max-height .26s var(--ease);
  }
  .think.open .think-body { max-height: 46vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .think-text {
    padding: 2px 12px 12px;
    font-size: 13px; line-height: 1.65; color: var(--dim);
    white-space: pre-wrap; word-break: break-word;
  }
  .dots::after { content: "…"; opacity: .55; animation: pulse 1.2s var(--ease) infinite; }

  /* tool calls */
  .tools { display: flex; flex-direction: column; gap: 6px; }
  .tool {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-radius: 12px;
    background: var(--panel); border: 1px solid var(--line);
    font-size: 13px; color: var(--fg-soft);
  }
  .tool .dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; background: var(--dim); }
  .tool.call .dot { background: var(--warn); animation: pulse 1.1s var(--ease) infinite; }
  .tool.result .dot { background: var(--ok); }
  .tool.error .dot { background: var(--err); }
  .tool.paused .dot { background: var(--warn); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  .tool .name { font-weight: 600; }
  .tool .meta { margin-left: auto; color: var(--dim); font-variant-numeric: tabular-nums; font-size: 12px; }
  .approve { display: flex; gap: 8px; margin-top: 2px; }
  .approve button { height: 34px; font-size: 13.5px; border-radius: 10px; }
  .approve .yes { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
  .err { font-size: 13px; color: var(--err); }
  .err:empty { display: none; }

  .empty { margin: 22vh auto 0; max-width: 300px; text-align: center; color: var(--dim); font-size: 14px; line-height: 1.9; }

  /* jump-to-latest */
  .jump {
    position: fixed; left: 50%; transform: translate(-50%, 10px);
    bottom: calc(env(safe-area-inset-bottom) + 92px);
    height: 34px; padding: 0 14px; border-radius: 999px;
    background: var(--panel); box-shadow: var(--shadow-md);
    font-size: 13px; color: var(--fg-soft);
    opacity: 0; pointer-events: none;
    transition: opacity .2s var(--ease), transform .2s var(--ease);
  }
  .jump.show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }

  /* ── composer ─────────────────────────────────────────────── */
  footer {
    position: relative; z-index: 20;
    display: flex; align-items: flex-end; gap: 9px;
    padding: 9px 14px calc(env(safe-area-inset-bottom) + 11px);
    background: var(--bg);
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: saturate(180%) blur(18px);
    -webkit-backdrop-filter: saturate(180%) blur(18px);
    border-top: 1px solid var(--line);
  }
  textarea {
    flex: 1 1 auto; min-height: 42px; max-height: 34vh;
    padding: 10px 14px; resize: none;
    font: inherit; font-size: 16px; line-height: 1.45;
    color: var(--fg); background: var(--panel);
    border: 1px solid var(--line); border-radius: 21px;
    transition: border-color .18s var(--ease), box-shadow .18s var(--ease);
  }
  textarea::placeholder { color: var(--dim); }
  textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
  #sendBtn {
    flex: 0 0 auto; width: 42px; height: 42px; padding: 0;
    border-radius: 50%; border: 0;
    background: var(--accent); color: var(--accent-ink);
    box-shadow: var(--shadow-sm);
  }
  #sendBtn svg { width: 18px; height: 18px; }
  .hint {
    position: fixed; left: 50%; transform: translate(-50%, 8px);
    bottom: calc(env(safe-area-inset-bottom) + 96px);
    padding: 7px 14px; border-radius: 999px;
    background: var(--fg); color: var(--bg);
    font-size: 13px; opacity: 0; pointer-events: none;
    transition: opacity .22s var(--ease), transform .22s var(--ease);
  }
  .hint.show { opacity: .92; transform: translate(-50%, 0); }
</style>
</head>
<body>
<header>
  <span id="dot" class="status"></span>
  <select id="sessions" aria-label="会话"></select>
  <button id="newBtn" class="icon" aria-label="新建会话">＋</button>
  <button id="stopBtn" class="danger" disabled>停止</button>
</header>
<main id="log"><div class="empty">正在连接…</div></main>
<button id="jumpBtn" class="jump">回到底部</button>
<footer>
  <textarea id="input" rows="1" placeholder="输入想法…" enterkeyhint="send"></textarea>
  <button id="sendBtn" aria-label="发送">
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>
</footer>
<div id="hint" class="hint"></div>
<script>
(function () {
  var sessionsEl = document.getElementById('sessions');
  var logEl = document.getElementById('log');
  var inputEl = document.getElementById('input');
  var sendEl = document.getElementById('sendBtn');
  var stopEl = document.getElementById('stopBtn');
  var newEl = document.getElementById('newBtn');
  var dotEl = document.getElementById('dot');
  var hintEl = document.getElementById('hint');
  var jumpEl = document.getElementById('jumpBtn');

  var state = {
    sessionId: null,
    sessions: [],
    busy: false,
    timer: null,
    inflight: false,
    source: null,
    pinned: true,
    expanded: {},
    thinkStart: {},
    thinkEnd: {},
    nodes: {},
    emptyShown: false
  };

  var CARET = '<svg class="think-caret" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hint(text) {
    hintEl.textContent = text;
    hintEl.className = 'hint show';
    setTimeout(function () { hintEl.className = 'hint'; }, 2200);
  }

  function api(op, payload) {
    var body = Object.assign({ op: op }, payload || {});
    return fetch('/api/exec', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (response) {
      return response.json().catch(function () { return { ok: false, error: 'HTTP ' + response.status }; });
    }).then(function (json) {
      if (!json.ok) throw new Error(json.error || '请求失败');
      return json.data;
    });
  }

  // ── scroll: only follow the stream while the user is pinned to the bottom ──
  function atBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 90;
  }
  function syncPinned() {
    state.pinned = atBottom();
    jumpEl.className = state.pinned ? 'jump' : 'jump show';
  }
  function scrollToBottom(behavior) {
    logEl.scrollTo({ top: logEl.scrollHeight, behavior: behavior || 'auto' });
  }
  logEl.addEventListener('scroll', syncPinned, { passive: true });
  jumpEl.addEventListener('click', function () {
    scrollToBottom('smooth');
    state.pinned = true;
    jumpEl.className = 'jump';
  });

  // ── markdown (subset), applied once streaming stops ──
  function splitRow(line) {
    return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (cell) { return cell.trim(); });
  }

  function md(src) {
    var out = esc(src || '');
    var codeBlocks = [];
    out = out.replace(/\\u0060\\u0060\\u0060([a-zA-Z0-9_-]*)\\n([\\s\\S]*?)\\u0060\\u0060\\u0060/g, function (m, lang, code) {
      codeBlocks.push('<pre>' + code.replace(/\\n$/, '') + '</pre>');
      return '@@CODE' + (codeBlocks.length - 1) + '@@';
    });
    out = out.replace(/\\u0060([^\\u0060\\n]+)\\u0060/g, '<code>$1</code>');
    out = out.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>');
    out = out.replace(/^#{1,6}\\s+(.+)$/gm, '<div class="h">$1</div>');

    // pipe tables
    var lines = out.split('\\n');
    var outLines = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var next = lines[i + 1] || '';
      if (line.indexOf('|') > -1 && next.indexOf('-') > -1 && /^\\s*\\|?[\\s:|-]+$/.test(next)) {
        var head = splitRow(line);
        var rows = [];
        var j = i + 2;
        while (j < lines.length && lines[j].trim() && lines[j].indexOf('|') > -1) {
          rows.push(splitRow(lines[j]));
          j += 1;
        }
        var table = '<div class="table-wrap"><table><thead><tr>';
        for (var h = 0; h < head.length; h++) table += '<th>' + head[h] + '</th>';
        table += '</tr></thead><tbody>';
        for (var r = 0; r < rows.length; r++) {
          table += '<tr>';
          for (var c = 0; c < rows[r].length; c++) table += '<td>' + rows[r][c] + '</td>';
          table += '</tr>';
        }
        table += '</tbody></table></div>';
        outLines.push(table);
        i = j - 1;
        continue;
      }
      outLines.push(line);
    }
    out = outLines.join('\\n');

    out = out.replace(/^\\s*[-*]\\s+(.+)$/gm, '<div class="li">• $1</div>');
    out = out.replace(/^\\s*(\\d+)[.)]\\s+(.+)$/gm, '<div class="li">$1. $2</div>');
    out = out.replace(/@@CODE(\\d+)@@/g, function (m, index) { return codeBlocks[Number(index)]; });
    return out;
  }

  function fmtDuration(ms) {
    var s = Math.max(1, Math.round(ms / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm' + (s % 60) + 's';
  }

  function summaryLine(reasoning, thinking) {
    if (!reasoning) return '';
    var lines = reasoning.split('\\n').map(function (line) { return line.trim(); }).filter(Boolean);
    if (!lines.length) return '';
    var line = thinking ? lines[lines.length - 1] : lines[0];
    line = line.replace(/[*#\\u0060]/g, '');
    return line.length > 60 ? (thinking ? '…' + line.slice(-58) : line.slice(0, 58) + '…') : line;
  }

  function thinkHtml(message) {
    var reasoning = message.reasoning || '';
    var thinking = Boolean(message.generating && !message.text);
    if (!reasoning && !thinking) return '';
    var open = Boolean(state.expanded[message.id]);
    var start = state.thinkStart[message.id];
    var end = state.thinkEnd[message.id];
    var elapsed = '';
    if (start && thinking) elapsed = fmtDuration(Date.now() - start);
    else if (start && end) elapsed = fmtDuration(end - start);
    var label = thinking ? '思考中' : '已思考';
    return '<div class="think' + (open ? ' open' : '') + '" data-think="' + esc(message.id) + '">'
      + '<button type="button" class="think-head" data-expand="' + esc(message.id) + '">'
      + '<span class="think-spark">✦</span>'
      + '<span class="think-label' + (thinking ? ' dots' : '') + '">' + label + '</span>'
      + (elapsed ? '<span class="think-time">' + elapsed + '</span>' : '')
      + '<span class="think-summary' + (thinking ? ' dots' : '') + '">' + esc(summaryLine(reasoning, thinking)) + '</span>'
      + CARET
      + '</button>'
      + '<div class="think-body"><div class="think-text">' + esc(reasoning) + '</div></div>'
      + '</div>';
  }

  function toolsHtml(tools, messageId) {
    if (!tools || !tools.length) return '';
    var html = '';
    for (var i = 0; i < tools.length; i++) {
      var tool = tools[i];
      var meta = tool.duration ? Math.round(tool.duration / 100) / 10 + 's' : tool.state;
      html += '<div class="tool ' + esc(tool.state) + '" title="' + esc(tool.brief || '') + '">'
        + '<span class="dot"></span>'
        + '<span class="name">' + esc(tool.toolName) + '</span>'
        + '<span class="meta">' + esc(meta) + '</span>'
        + '</div>';
      if (tool.state === 'paused') {
        html += '<div class="approve">'
          + '<button class="yes" data-approve="1" data-mid="' + esc(messageId) + '" data-tid="' + esc(tool.toolCallId) + '">批准执行</button>'
          + '<button data-approve="0" data-mid="' + esc(messageId) + '" data-tid="' + esc(tool.toolCallId) + '">拒绝</button>'
          + '</div>';
      }
    }
    return html;
  }

  function answerHtml(message) {
    var text = message.text || '';
    if (!text) return message.generating ? '<span class="dots"></span>' : '';
    return message.generating ? esc(text) : md(text);
  }

  function turnHtml(message) {
    if (message.role === 'user') {
      return '<div class="turn user" data-mid="' + esc(message.id) + '">'
        + '<div class="user-bubble">' + esc(message.text) + '</div></div>';
    }
    return '<div class="turn assistant" data-mid="' + esc(message.id) + '">'
      + thinkHtml(message)
      + '<div class="answer">' + answerHtml(message) + '</div>'
      + '<div class="tools">' + toolsHtml(message.tools, message.id) + '</div>'
      + '<div class="err">' + esc(message.error || '') + '</div>'
      + '</div>';
  }

  function syncStatus(next) {
    var value = Boolean(next);
    // Called on every stream frame; bail out unless the state actually flipped.
    if (value === state.busy) return;
    var wasBusy = state.busy;
    state.busy = value;
    dotEl.className = 'status' + (state.busy ? ' busy' : '');
    stopEl.disabled = !state.busy;
    stopEl.className = 'danger' + (state.busy ? ' on' : '');
    if (wasBusy && !state.busy && state.sessionId) {
      // Auto-naming runs right after a turn ends; pull the new title in.
      setTimeout(function () {
        if (state.sessionId) loadSessions(state.sessionId);
      }, 2500);
    }
  }

  // Signature of everything a turn actually renders: if it did not change, we
  // must not touch the DOM (a full rebuild flickered the whole page every 3s).
  function turnSignature(message) {
    var tools = (message.tools || []).map(function (tool) {
      return tool.toolCallId + ':' + tool.state + ':' + (tool.duration || 0);
    }).join(',');
    return [message.generating ? 1 : 0, message.error || '', tools, message.text || '', message.reasoning || ''].join('\u0001');
  }

  function createTurn(message) {
    var holder = document.createElement('div');
    holder.innerHTML = turnHtml(message);
    var node = holder.firstElementChild;
    if (!node) return null;
    node.classList.add('new');
    node.__sig = turnSignature(message);
    state.nodes[message.id] = node;
    return node;
  }

  function updateTurn(node, message) {
    node.__sig = turnSignature(message);
    if (message.role === 'user') {
      var bubble = node.querySelector('.user-bubble');
      if (bubble) bubble.textContent = message.text || '';
      return;
    }
    var think = node.querySelector('[data-think]');
    var thinking = Boolean(message.generating && !message.text);
    if (!think && (message.reasoning || thinking)) {
      // First reasoning arrived after the turn was rendered: rebuild this turn.
      var holder = document.createElement('div');
      holder.innerHTML = turnHtml(message);
      var fresh = holder.firstElementChild;
      if (fresh) {
        node.innerHTML = fresh.innerHTML;
        node.className = fresh.className;
        node.classList.remove('new');
      }
      return;
    }
    if (think) {
      var summary = think.querySelector('.think-summary');
      var label = think.querySelector('.think-label');
      if (summary) {
        summary.textContent = summaryLine(message.reasoning, thinking);
        summary.className = 'think-summary' + (thinking ? ' dots' : '');
      }
      if (label) {
        label.textContent = thinking ? '思考中' : '已思考';
        label.className = 'think-label' + (thinking ? ' dots' : '');
      }
      var body = think.querySelector('.think-text');
      if (body) body.textContent = message.reasoning || '';
    }
    var answer = node.querySelector('.answer');
    if (answer) {
      if (message.generating) answer.textContent = message.text || '';
      else answer.innerHTML = md(message.text);
    }
    var toolsBox = node.querySelector('.tools');
    if (toolsBox) toolsBox.innerHTML = toolsHtml(message.tools, message.id);
    var err = node.querySelector('.err');
    if (err) err.textContent = message.error || '';
  }

  // Reconcile instead of rebuilding: keep nodes, patch only what changed.
  function reconcile(list) {
    var seen = {};
    var cursor = logEl.firstElementChild;
    for (var i = 0; i < list.length; i++) {
      var message = list[i];
      seen[message.id] = true;
      var node = state.nodes[message.id] || createTurn(message);
      if (!node) continue;
      if (cursor === node) {
        cursor = cursor.nextElementSibling;
      } else {
        logEl.insertBefore(node, cursor);
      }
      if (node.__sig !== turnSignature(message)) updateTurn(node, message);
    }
    while (cursor) {
      var next = cursor.nextElementSibling;
      var id = cursor.getAttribute ? cursor.getAttribute('data-mid') : null;
      // Anything without data-mid is a placeholder ("加载中…"/empty state) and
      // must not survive a real render.
      if (!id || !seen[id]) {
        logEl.removeChild(cursor);
        if (id) delete state.nodes[id];
      }
      cursor = next;
    }
  }

  function render(session) {
    var stick = state.pinned;
    if (!session) {
      state.nodes = {};
      logEl.innerHTML = '<div class="empty">这个会话还没有消息。<br>在下面输入，就是对它说话。</div>';
      state.emptyShown = true;
      syncStatus(false);
      return;
    }

    var list = [];
    for (var i = 0; i < session.messages.length; i++) {
      var message = session.messages[i];
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      // Only time what we actually watched stream; a message loaded already
      // finished has no honest duration to show.
      if (message.generating && message.reasoning && !state.thinkStart[message.id]) {
        state.thinkStart[message.id] = Date.now();
      }
      list.push(message);
    }

    if (!list.length) {
      state.nodes = {};
      logEl.innerHTML = '<div class="empty">空会话，直接输入即可。</div>';
      state.emptyShown = true;
    } else {
      if (state.emptyShown) {
        logEl.innerHTML = '';
        state.emptyShown = false;
      }
      reconcile(list);
    }

    syncStatus(Boolean(session.busy || session.generating));
    if (stick) scrollToBottom('auto');
    syncPinned();
  }

  // Patch one turn in place: full re-render at 6fps would fight scrolling.
  // Write a node's text only when it actually differs: assigning textContent
  // with the same string still swaps the text node and repaints.
  function setText(el, value) {
    if (!el) return;
    var next = value == null ? '' : String(value);
    if (el.textContent !== next) el.textContent = next;
  }

  function applyProgress(event) {
    if (event.sessionId !== state.sessionId) return;
    var node = state.nodes[event.messageId] || logEl.querySelector('.turn[data-mid="' + event.messageId + '"]');
    if (!node) { tick(); return; }
    var stick = state.pinned;
    if (!state.thinkStart[event.messageId] && event.reasoning && event.generating) {
      state.thinkStart[event.messageId] = Date.now();
    }
    if (!event.generating && state.thinkStart[event.messageId] && !state.thinkEnd[event.messageId]) {
      state.thinkEnd[event.messageId] = Date.now();
    }
    var thinking = Boolean(event.generating && !event.text);
    var thinkNode = node.querySelector('[data-think]');
    if (thinkNode) {
      var summary = thinkNode.querySelector('.think-summary');
      var label = thinkNode.querySelector('.think-label');
      var time = thinkNode.querySelector('.think-time');
      if (summary) {
        setText(summary, summaryLine(event.reasoning, thinking));
        var summaryClass = 'think-summary' + (thinking ? ' dots' : '');
        if (summary.className !== summaryClass) summary.className = summaryClass;
      }
      if (label) {
        setText(label, thinking ? '思考中' : '已思考');
        var labelClass = 'think-label' + (thinking ? ' dots' : '');
        if (label.className !== labelClass) label.className = labelClass;
      }
      if (time) {
        var start = state.thinkStart[event.messageId];
        var end = state.thinkEnd[event.messageId];
        if (start && thinking) setText(time, fmtDuration(Date.now() - start));
        else if (start && end) setText(time, fmtDuration(end - start));
        else setText(time, '');
      }
      var body = thinkNode.querySelector('.think-text');
      if (body && thinkNode.classList.contains('open')) setText(body, event.reasoning || '');
    }
    var answer = node.querySelector('.answer');
    if (answer) {
      if (event.generating) {
        setText(answer, event.text || '');
      } else if (node.__mdFor !== event.text) {
        node.__mdFor = event.text;
        answer.innerHTML = md(event.text);
      }
    }
    var tools = node.querySelector('.tools');
    if (tools) {
      var toolsHtmlNext = toolsHtml(event.tools, event.messageId);
      if (node.__toolsHtml !== toolsHtmlNext) {
        node.__toolsHtml = toolsHtmlNext;
        tools.innerHTML = toolsHtmlNext;
      }
    }
    syncStatus(Boolean(event.generating));
    if (stick) scrollToBottom('auto');
    syncPinned();
  }

  function connectEvents() {
    if (state.source) state.source.close();
    var source = new EventSource('/api/events');
    state.source = source;
    source.onmessage = function (event) {
      try {
        var payload = JSON.parse(event.data);
        if (payload && payload.type === 'progress') applyProgress(payload);
      } catch (error) { /* ignore malformed frame */ }
    };
    source.onerror = function () { hint('实时连接断开，正在重连…'); };
  }

  function scheduleNext() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(tick, 3000);
  }

  function tick() {
    if (!state.sessionId || state.inflight) { scheduleNext(); return; }
    var requested = state.sessionId;
    state.inflight = true;
    api('get-session', { sessionId: requested })
      .then(function (session) {
        // Drop stale responses: switching sessions while a poll is in flight
        // used to overwrite the new session's content.
        if (state.sessionId === requested) render(session);
      })
      .catch(function (error) { hint(error.message); })
      .then(function () { state.inflight = false; scheduleNext(); });
  }

  function loadSessions(selectId) {
    return api('list-sessions').then(function (list) {
      state.sessions = list || [];
      var html = '';
      for (var i = 0; i < state.sessions.length; i++) {
        var item = state.sessions[i];
        html += '<option value="' + esc(item.id) + '">' + esc(item.name || '未命名会话') + '</option>';
      }
      sessionsEl.innerHTML = html || '<option value="">(无会话)</option>';
      var target = selectId || state.sessionId || (state.sessions[0] && state.sessions[0].id);
      if (target) { sessionsEl.value = target; state.sessionId = target; }
      tick();
    });
  }

  // Auto-naming runs a model call after the first turn, so the title lands a
  // little later than the reply; refresh just the picker without touching the
  // transcript or the scroll position.
  function refreshTitles() {
    if (state.busy) return;
    api('list-sessions').then(function (list) {
      state.sessions = list || [];
      var html = '';
      for (var i = 0; i < state.sessions.length; i++) {
        var item = state.sessions[i];
        html += '<option value="' + esc(item.id) + '">' + esc(item.name || '未命名会话') + '</option>';
      }
      if (!html) return;
      sessionsEl.innerHTML = html;
      if (state.sessionId) sessionsEl.value = state.sessionId;
    }).catch(function () { /* ignore */ });
  }

  function send() {
    var text = inputEl.value.trim();
    if (!text || !state.sessionId) return;
    sendEl.disabled = true;
    state.pinned = true;
    api('send-message', { sessionId: state.sessionId, text: text })
      .then(function () {
        inputEl.value = '';
        inputEl.style.height = 'auto';
        state.busy = true;
        syncStatus(true);
        scheduleNext();
      })
      .catch(function (error) { hint(error.message); })
      .then(function () { sendEl.disabled = false; inputEl.focus(); });
  }

  // ── events ────────────────────────────────────────────────
  logEl.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) return;

    var expandBtn = target.closest('[data-expand]');
    if (expandBtn) {
      var id = expandBtn.getAttribute('data-expand');
      state.expanded[id] = !state.expanded[id];
      var box = logEl.querySelector('[data-think="' + id + '"]');
      if (box) box.classList.toggle('open', Boolean(state.expanded[id]));
      return;
    }

    var approveBtn = target.closest('[data-approve]');
    if (approveBtn) {
      var approve = approveBtn.getAttribute('data-approve') === '1';
      approveBtn.disabled = true;
      api(approve ? 'continue-paused' : 'reject-paused', {
        sessionId: state.sessionId,
        messageId: approveBtn.getAttribute('data-mid'),
        toolCallId: approveBtn.getAttribute('data-tid')
      })
        .then(function () { hint(approve ? '已批准' : '已拒绝'); scheduleNext(); })
        .catch(function (error) { hint(error.message); approveBtn.disabled = false; });
    }
  });

  sessionsEl.addEventListener('change', function () {
    state.sessionId = sessionsEl.value;
    state.expanded = {};
    state.thinkStart = {};
    state.thinkEnd = {};
    state.nodes = {};
    state.emptyShown = false;
    state.inflight = false;
    if (state.timer) clearTimeout(state.timer);
    logEl.innerHTML = '<div class="empty">加载中…</div>';
    state.pinned = true;
    tick();
  });

  sendEl.addEventListener('click', send);

  inputEl.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  });

  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, window.innerHeight * 0.34) + 'px';
  });

  stopEl.addEventListener('click', function () {
    if (!state.sessionId) return;
    stopEl.disabled = true;
    api('stop', { sessionId: state.sessionId })
      .then(function () { hint('已发送停止'); scheduleNext(); })
      .catch(function (error) { hint(error.message); syncStatus(state.busy); });
  });

  newEl.addEventListener('click', function () {
    api('create-session')
      .then(function (result) { return loadSessions(result.sessionId); })
      .then(function () { inputEl.focus(); })
      .catch(function (error) { hint(error.message); });
  });

  connectEvents();
  setInterval(refreshTitles, 8000);
  loadSessions().catch(function (error) {
    logEl.innerHTML = '<div class="empty">连接失败：' + esc(error.message) + '<br>请确认与电脑在同一 WiFi，并用带 token 的链接打开。</div>';
  });
})();
</script>
</body>
</html>`
