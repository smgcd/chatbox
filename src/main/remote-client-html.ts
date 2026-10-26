/**
 * The iPad client page, served by the LAN remote host server.
 *
 * Kept as a plain string so the Electron main bundle needs no extra asset
 * pipeline (no `?raw` import, no electron-vite config change). The client only
 * speaks the closed command enum from shared/remote-host.ts.
 *
 * Note: this string is written without backticks or "${" so it can live inside
 * a template literal safely.
 */
export const REMOTE_CLIENT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#0f1014">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%235b8cff'/%3E%3C/svg%3E">
<title>Chatbox 遥控</title>
<style>
  :root { color-scheme: dark; --bg:#0f1014; --panel:#171920; --line:#24262f; --fg:#e6e8ef; --dim:#8b90a0; --accent:#5b8cff; --ok:#48c78e; --warn:#f0b429; --err:#ef5b5b; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif; }
  body { display:flex; flex-direction:column; height:100dvh; }
  header { display:flex; gap:8px; align-items:center; padding:calc(env(safe-area-inset-top) + 8px) 12px 8px; background:var(--panel); border-bottom:1px solid var(--line); }
  header .dot { width:8px; height:8px; border-radius:50%; background:var(--dim); flex:0 0 auto; }
  header .dot.busy { background:var(--warn); box-shadow:0 0 8px var(--warn); }
  select { flex:1 1 auto; min-width:0; background:#12141a; color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:9px 10px; font-size:15px; }
  button { background:#1e2130; color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:9px 13px; font-size:15px; font-weight:600; }
  button:active { transform:scale(.97); }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { background:#3a1d22; border-color:#5c2a32; color:#ff9a9a; }
  button:disabled { opacity:.4; }
  main { flex:1 1 auto; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:12px 12px 4px; }
  .msg { display:flex; margin:0 0 12px; }
  .msg.user { justify-content:flex-end; }
  .bubble { max-width:86%; border-radius:16px; padding:10px 13px; white-space:pre-wrap; word-break:break-word; }
  .msg.user .bubble { background:#243055; border:1px solid #2f3f6b; }
  .msg.assistant .bubble { background:var(--panel); border:1px solid var(--line); }
  .msg.system .bubble { background:#1a1c22; color:var(--dim); font-size:13px; }
  .tools { margin-top:8px; display:flex; flex-direction:column; gap:5px; }
  .tool { font-size:12px; padding:5px 8px; border-radius:8px; background:#12141a; border:1px solid var(--line); color:var(--dim); }
  .tool.call { border-color:#4a3c12; color:var(--warn); }
  .tool.result { border-color:#1f4433; color:var(--ok); }
  .tool.error { border-color:#4a2024; color:var(--err); }
  .tool.paused { border-color:#4a3c12; color:#f0a429; }
  .approve { margin-top:7px; display:flex; gap:8px; }
  .approve button { font-size:13px; padding:6px 11px; border-radius:8px; }
  .approve .yes { background:#1d3a2a; border-color:#2f5a41; color:#7ee2b0; }
  .approve .no { background:#3a1d22; border-color:#5c2a32; color:#ff9a9a; }
  .err { margin-top:6px; font-size:12px; color:var(--err); }
  .reason { margin-top:6px; font-size:12px; line-height:1.5; color:#7d8398; white-space:pre-wrap; border-left:2px solid #2a2e3a; padding-left:8px; }
  .empty { color:var(--dim); text-align:center; margin-top:40px; font-size:14px; line-height:1.8; }
  footer { padding:8px 12px calc(env(safe-area-inset-bottom) + 10px); background:var(--panel); border-top:1px solid var(--line); display:flex; gap:8px; align-items:flex-end; }
  textarea { flex:1 1 auto; resize:none; min-height:44px; max-height:38vh; background:#12141a; color:var(--fg); border:1px solid var(--line); border-radius:12px; padding:11px 12px; font:16px/1.4 inherit; }
  textarea:focus, select:focus { outline:none; border-color:var(--accent); }
  .hint { position:fixed; left:0; right:0; bottom:96px; text-align:center; font-size:12px; color:var(--dim); pointer-events:none; opacity:0; transition:opacity .3s; }
  .hint.show { opacity:1; }
</style>
</head>
<body>
<header>
  <span id="dot" class="dot"></span>
  <select id="sessions"></select>
  <button id="newBtn" aria-label="新建会话">＋</button>
  <button id="modeBtn">普通</button>
  <button id="stopBtn" class="danger" disabled>停止</button>
</header>
<main id="log"><div class="empty">正在连接…</div></main>
<footer>
  <textarea id="input" rows="1" placeholder="输入想法，回车发送"></textarea>
  <button id="sendBtn" class="primary">发送</button>
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
  var modeBtn = document.getElementById('modeBtn');
  var state = { sessionId: null, sessions: [], busy: false, timer: null, inflight: false, agentMode: 'off', locked: false };

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

  function nearBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 120;
  }

  function renderTools(tools, messageId) {
    if (!tools || !tools.length) return '';
    var html = '<div class="tools">';
    for (var i = 0; i < tools.length; i++) {
      var tool = tools[i];
      var suffix = tool.duration ? ' · ' + Math.round(tool.duration / 100) / 10 + 's' : '';
      html += '<div class="tool ' + esc(tool.state) + '" title="' + esc(tool.brief || '') + '">'
        + esc(tool.toolName) + ' · ' + esc(tool.state) + suffix + '</div>';
      if (tool.state === 'paused') {
        html += '<div class="approve">'
          + '<button class="yes" data-approve="1" data-mid="' + esc(messageId) + '" data-tid="' + esc(tool.toolCallId) + '">批准执行</button>'
          + '<button class="no" data-approve="0" data-mid="' + esc(messageId) + '" data-tid="' + esc(tool.toolCallId) + '">拒绝</button>'
          + '</div>';
      }
    }
    return html + '</div>';
  }

  function render(session) {
    var stick = nearBottom();
    if (!session) {
      logEl.innerHTML = '<div class="empty">这个会话还没有消息。<br>在下面输入，就是直接对它说话。</div>';
      return;
    }
    if (!session.messages.length) {
      logEl.innerHTML = '<div class="empty">空会话，直接输入即可。</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < session.messages.length; i++) {
      var message = session.messages[i];
      if (message.role !== 'user' && message.role !== 'assistant') continue;
      var role = message.role === 'user' ? 'user' : 'assistant';
      var text = message.text || (message.generating ? '…' : '');
      var reason = '';
      if (message.reasoning && (message.generating || !message.text)) {
        var tail = message.reasoning.length > 240 ? '…' + message.reasoning.slice(-240) : message.reasoning;
        reason = '<div class="reason">' + esc(tail) + '</div>';
      }
      html += '<div class="msg ' + role + '"><div class="bubble">'
        + esc(text)
        + reason
        + renderTools(message.tools, message.id)
        + (message.error ? '<div class="err">' + esc(message.error) + '</div>' : '')
        + '</div></div>';
    }
    logEl.innerHTML = html;
    if (stick) logEl.scrollTop = logEl.scrollHeight;
    state.busy = Boolean(session.busy || session.generating);
    state.agentMode = session.agentMode || 'off';
    state.locked = Boolean(session.agentModeLocked);
    dotEl.className = 'dot' + (state.busy ? ' busy' : '');
    stopEl.disabled = !state.busy;
    modeBtn.textContent = state.agentMode === 'on' ? '智能体 开' : (state.agentMode === 'auto' ? '自动' : '普通');
    modeBtn.disabled = state.locked;
  }

  function scheduleNext() {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(tick, state.busy ? 1200 : 3000);
  }

  function tick() {
    if (!state.sessionId || state.inflight) { scheduleNext(); return; }
    state.inflight = true;
    api('get-session', { sessionId: state.sessionId })
      .then(function (session) { render(session); })
      .catch(function (error) { hint(error.message); })
      .then(function () { state.inflight = false; scheduleNext(); });
  }

  function loadSessions(selectId) {
    return api('list-sessions').then(function (list) {
      state.sessions = list || [];
      var html = '';
      for (var i = 0; i < state.sessions.length; i++) {
        var item = state.sessions[i];
        html += '<option value="' + esc(item.id) + '">' + esc(item.name || '(未命名)') + '</option>';
      }
      sessionsEl.innerHTML = html || '<option value="">(无会话)</option>';
      var target = selectId || state.sessionId || (state.sessions[0] && state.sessions[0].id);
      if (target) { sessionsEl.value = target; state.sessionId = target; }
      tick();
    });
  }

  function send() {
    var text = inputEl.value.trim();
    if (!text || !state.sessionId) return;
    sendEl.disabled = true;
    api('send-message', { sessionId: state.sessionId, text: text })
      .then(function () {
        inputEl.value = '';
        inputEl.style.height = 'auto';
        state.busy = true;
        scheduleNext();
      })
      .catch(function (error) { hint(error.message); })
      .then(function () { sendEl.disabled = false; inputEl.focus(); });
  }

  sessionsEl.addEventListener('change', function () {
    state.sessionId = sessionsEl.value;
    logEl.innerHTML = '<div class="empty">加载中…</div>';
    tick();
  });

  sendEl.addEventListener('click', send);

  inputEl.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
  });

  inputEl.addEventListener('input', function () {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, window.innerHeight * 0.38) + 'px';
  });

  stopEl.addEventListener('click', function () {
    if (!state.sessionId) return;
    stopEl.disabled = true;
    api('stop', { sessionId: state.sessionId })
      .then(function () { hint('已发送停止'); scheduleNext(); })
      .catch(function (error) { hint(error.message); stopEl.disabled = false; });
  });

  modeBtn.addEventListener('click', function () {
    if (!state.sessionId || state.locked) return;
    var next = state.agentMode === 'on' ? 'off' : 'on';
    api('set-agent-mode', { sessionId: state.sessionId, value: next })
      .then(function (result) {
        state.agentMode = result.agentMode;
        state.locked = Boolean(result.locked);
        modeBtn.textContent = state.agentMode === 'on' ? '智能体 开' : '普通';
        hint(state.locked ? '会话已开始，模式已锁定' : '已切换');
      })
      .catch(function (error) { hint(error.message); });
  });

  logEl.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.getAttribute || target.getAttribute('data-approve') === null) return;
    var approve = target.getAttribute('data-approve') === '1';
    var payload = {
      sessionId: state.sessionId,
      messageId: target.getAttribute('data-mid'),
      toolCallId: target.getAttribute('data-tid')
    };
    target.disabled = true;
    api(approve ? 'continue-paused' : 'reject-paused', payload)
      .then(function () { hint(approve ? '已批准' : '已拒绝'); scheduleNext(); })
      .catch(function (error) { hint(error.message); target.disabled = false; });
  });

  newEl.addEventListener('click', function () {
    api('create-session')
      .then(function (result) { return loadSessions(result.sessionId); })
      .then(function () { inputEl.focus(); })
      .catch(function (error) { hint(error.message); });
  });

  loadSessions().catch(function (error) {
    logEl.innerHTML = '<div class="empty">连接失败：' + esc(error.message) + '<br>请确认与电脑在同一 WiFi，并用带 token 的链接打开。</div>';
  });
})();
</script>
</body>
</html>`
