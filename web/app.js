'use strict';
// ============================================================ 工具
const $ = (s, el = document) => el.querySelector(s);
const LV = { read: { name: '只读问答', desc: '只能读文件、回答问题，改文件和执行命令会被拒绝' },
  edit: { name: '可改文件', desc: '可以在工作目录里改文件；Codex 可在沙盒内执行命令' },
  full: { name: '完全放开', desc: '跳过所有确认，能执行任意命令。只给信得过的人' } };

function toast(msg, err) {
  const d = document.createElement('div'); d.textContent = msg; if (err) d.className = 'err';
  $('#toast').appendChild(d); setTimeout(() => d.remove(), 3200);
}
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : (method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : (method !== 'GET' ? '{}' : undefined) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && url !== '/api/login') { S.me = null; render(); throw new Error('请重新登录'); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const tryApi = async (...a) => { try { return await api(...a); } catch (e) { toast(e.message, true); throw e; } };


// ============================================================ 状态
const S = { me: null, view: 'chat', agents: [], agentToken: null, convs: [], conv: null, tasks: new Map(), allTasks: [], taskFilter: '', users: [], es: null, sideOpen: false };

// ============================================================ 偏好设置（存在本浏览器，手机和电脑可以各设各的）
const PREF_DEFAULTS = { sendKey: 'enter', rememberNewConv: true };
const SEND_KEYS = {
  enter: { name: 'Enter 发送', desc: 'Shift+Enter 换行' },
  mod: { name: 'Ctrl/⌘ + Enter 发送', desc: 'Enter 换行' },
};
function loadJSON(k, d) { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return { ...d }; } }
let PREFS = loadJSON('aib.prefs', PREF_DEFAULTS);
function savePrefs(p) { PREFS = { ...PREFS, ...p }; localStorage.setItem('aib.prefs', JSON.stringify(PREFS)); }
const sendKeyHint = () => `${SEND_KEYS[PREFS.sendKey]?.name || SEND_KEYS.enter.name}，${SEND_KEYS[PREFS.sendKey]?.desc || SEND_KEYS.enter.desc}`;
function isSendKey(e) {
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return false; // 输入法选词时的回车不算
  return PREFS.sendKey === 'mod' ? (e.ctrlKey || e.metaKey) : !(e.shiftKey || e.altKey);
}

// ============================================================ 设备、CLI、模型（新对话顶部直接点选）
const CLI_CHOICES = ['claude', 'codex'];
const DEFAULT_CHOICE = { cli: 'claude', model: 'claude-opus-5-5' };
// Claude 固定 3 个；Codex 的模型名以 Mac 上 agent 配置的 clis.codex.models 为准（取前 3 个），没配就用 CLI 默认
function modelChoices(cli, agent) {
  if (cli === 'claude') return CLAUDE_MODELS;
  const list = (agent?.clis?.[cli]?.models || []).slice(0, 3).map(v => [v, v]);
  return list.length ? list : [['', '默认']];
}
// 单选按钮组，选中的打勾。items: [值, 名字, 是否禁用, 小字说明]
function pillsHTML(attr, items, cur) {
  return `<div class="pills">${items.map(([v, label, disabled, note]) => `<button type="button" class="pill ${v === cur ? 'on' : ''}" data-${attr}="${esc(v)}" ${disabled ? 'disabled' : ''}><span class="tick">✓</span>${esc(label)}${note ? `<small>${esc(note)}</small>` : ''}</button>`).join('')}</div>`;
}
const pickAgent = () => S.agents.find(a => a.online) || S.agents[0] || null;
const deviceName = a => (!a || a.platform === 'darwin') ? 'Mac' : a.name;
const deviceChip = a => `<span class="chip"><span class="dot ${a?.online ? 'on' : ''}"></span>${esc(deviceName(a))}${a?.online ? '' : a ? ' · 离线' : ' · 未连接'}</span>`;

async function boot() {
  try { const r = await api('GET', '/api/me'); S.me = r.user; } catch { S.me = null; }
  const h = location.hash.slice(1); if (['chat', 'tasks', 'agents', 'users'].includes(h)) S.view = h;
  render();
  if (S.me) afterLogin();
}
async function afterLogin() {
  connectStream();
  await Promise.all([loadAgents(), loadConvs()]);
  S.loaded = true; // 加载完之前不显示「未连接」「还没有对话」这类状态，免得一闪而过
  setTimeout(() => refreshQuota(true), 500); // 右上角的额度圆环：登录后先查一次（数据够新就直接用）
  // 手机上一打开先看历史对话
  if (!S.conv && matchMedia('(max-width:760px)').matches) S.sideOpen = true;
  render();
}
function connectStream() {
  S.es?.close();
  const es = new EventSource('/api/stream'); S.es = es;
  es.addEventListener('agents', e => {
    S.agents = JSON.parse(e.data); updateHeadAgent();
    if (S.view === 'agents') renderView();
    if (S.view === 'chat' && !S.conv) renderNewChat(); // 新对话顶部的 Mac 在线状态
    if (S.view === 'chat') updateComposer();
    if (S.quotaOpen || $('#quotaInline')) renderQuota(); else updateQuotaRing(); // 任务里顺带更新的额度
  });
  es.addEventListener('task', e => onTaskUpdate(JSON.parse(e.data)));
  es.addEventListener('chunk', e => onChunk(JSON.parse(e.data)));
  es.onerror = () => { if (!S.me) es.close(); };
}
async function loadAgents() { const r = await api('GET', '/api/agents'); S.agents = r.agents; S.agentToken = r.agentToken; }
async function loadConvs() { const r = await api('GET', '/api/convs'); S.convs = r.convs; }

function onTaskUpdate(t) {
  const cur = S.tasks.get(t.id);
  if (cur) Object.assign(cur, t); else if (S.conv && t.convId === S.conv.id) S.tasks.set(t.id, { ...t, events: [] });
  const i = S.allTasks.findIndex(x => x.id === t.id);
  if (i >= 0) S.allTasks[i] = { ...S.allTasks[i], ...t }; else if (S.view === 'tasks') S.allTasks.unshift(t);
  const c = S.convs.find(c => c.id === t.convId);
  if (c && t.endedAt) { c.updatedAt = t.endedAt; }
  if (c && t.sessionId) c.sessionId = t.sessionId;
  if (S.conv && t.convId === S.conv.id && t.sessionId) S.conv.sessionId = t.sessionId;
  if (S.view === 'chat' && S.conv && t.convId === S.conv.id) { renderTurn(t.id); updateComposer(); }
  if (S.view === 'chat') renderConvList();
  if (S.view === 'tasks') renderTaskTable();
  if (S.detailTask === t.id) refreshDetail();
}
function onChunk({ taskId, events }) {
  const t = S.tasks.get(taskId);
  if (t) {
    for (const e of events) { const last = t.events[t.events.length - 1]; if (e.k === 'text' && last?.k === 'text') last.d += e.d; else t.events.push({ ...e }); }
    renderTurn(taskId, true);
  }
  if (S.detailTask === taskId) refreshDetail();
}

// ============================================================ 总渲染
function render() {
  const app = $('#app');
  if (!S.me) { app.innerHTML = loginHTML(); bindLogin(); return; }
  const isAdmin = S.me.role === 'admin';
  const tabs = [['chat', '对话'], ['tasks', '任务'], ['agents', '设备'], ...(isAdmin ? [['users', '用户权限']] : [])];
  app.innerHTML = `
    <header class="top">
      <div class="brand"><i>&gt;_</i><span>AI 遥控台</span></div>
      <nav class="nav">${tabs.map(([k, n]) => `<button data-v="${k}" class="${S.view === k ? 'on' : ''}">${n}</button>`).join('')}</nav>
      <div class="me"><span class="dot" id="headDot"></span><span class="name">${esc(S.me.username)}</span>
        <button class="icon-btn qbtn" id="quotaBtn" title="额度使用情况（也可以在对话里发 /usage）">${quotaRingSVG()}</button><button class="icon-btn" id="prefBtn" title="偏好设置">⚙</button><button class="icon-btn" id="pwBtn" title="改密码">🔑</button><button class="icon-btn" id="logout" title="退出">⏻</button></div>
    </header>
    <div class="quota-pop card" id="quotaPop" ${S.quotaOpen ? '' : 'hidden'}></div>
    <div class="main" id="main"></div>`;
  app.querySelectorAll('.nav button').forEach(b => b.onclick = () => { S.view = b.dataset.v; S.sideOpen = false; location.hash = S.view; render(); });
  $('#logout').onclick = async () => { await api('POST', '/api/logout'); S.es?.close(); S.me = null; render(); };
  $('#pwBtn').onclick = changePassword;
  $('#prefBtn').onclick = prefsDialog;
  $('#quotaBtn').onclick = () => setQuotaOpen(!S.quotaOpen);
  if (S.quotaOpen) renderQuota();
  updateHeadAgent();
  renderView();
}
// ============================================================ 额度（5 小时 / 本周 / 恢复时间），和 Claude Code 的 /usage 一样
S.quota = { loading: false, error: null };
// 用量等级（颜色）：蓝 < 40% ≤ 绿 < 70% ≤ 橙 < 90% ≤ 红
const quotaLevel = p => p >= 90 ? 'red' : p >= 70 ? 'orange' : p >= 40 ? 'green' : 'blue';
const quotaMax = q => (q?.windows || []).reduce((m, w) => Math.max(m, w.percent), -1); // 用得最多的那个窗口
// 圆环图标：灰色底圈 + 一段彩色弧线（从 12 点方向顺时针），长度 = 用得最多的那个额度
function quotaRingSVG() {
  const q = pickAgent()?.quota, p = quotaMax(q);
  const C = 2 * Math.PI * 14, len = p > 0 ? Math.max(C * p / 100, 3) : 0;
  return `<svg class="qring ${p < 0 ? 'none' : 'lv-' + quotaLevel(p)}" viewBox="0 0 36 36" aria-hidden="true">
    <circle class="trk" cx="18" cy="18" r="14"/>${len ? `<circle class="arc" cx="18" cy="18" r="14" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" transform="rotate(-90 18 18)"/>` : ''}</svg>`;
}
function updateQuotaRing() {
  const b = $('#quotaBtn'); if (!b) return;
  b.innerHTML = quotaRingSVG();
  const q = pickAgent()?.quota;
  b.title = q?.windows?.length ? q.windows.map(w => `${w.label} ${w.percent}%`).join(' · ') + '（点开看详情，也可以在对话里发 /usage）' : '额度使用情况（也可以在对话里发 /usage）';
}
const fmtLeft = ms => {
  const min = Math.max(1, Math.round(ms / 60000)), h = Math.floor(min / 60), d = Math.floor(h / 24);
  return d ? `${d} 天 ${h % 24} 小时` : h ? `${h} 小时 ${min % 60} 分` : `${min} 分钟`;
};
function resetText(w) {
  if (w.resetsAt) {
    const t = new Date(w.resetsAt), left = w.resetsAt - Date.now();
    return `${t.getMonth() + 1}月${t.getDate()}日 ${t.toTimeString().slice(0, 5)} 恢复 · ${left > 0 ? '还有 ' + fmtLeft(left) : '已恢复'}`;
  }
  return w.resetsText ? `恢复：${w.resetsText}` : '';
}
function quotaHTML() {
  const a = pickAgent(), q = a?.quota, st = S.quota;
  const rows = (q?.windows || []).map(w => `<div class="qrow">
      <div class="qhead"><b>${esc(w.label)}</b><span class="qpct lv-${quotaLevel(w.percent)}">${w.percent}% 已用</span></div>
      <div class="qbar"><i class="lv-${quotaLevel(w.percent)}" style="width:${w.percent}%"></i></div>
      <div class="faint">${esc(resetText(w))}</div></div>`).join('');
  return `<div class="qtop"><b>额度使用情况</b>
      <button class="btn sm" data-quota-refresh ${st.loading ? 'disabled' : ''}>${st.loading ? '<span class="spin"></span> 查询中' : '刷新'}</button></div>
    ${rows || `<div class="faint">${st.loading ? '正在向 Mac 查询…' : '还没有数据，点「刷新」查询'}</div>`}
    ${st.error ? `<div class="errbox">${esc(st.error)}</div>` : ''}
    ${q?.at ? `<div class="faint qfoot">更新于 ${fmtTime(q.at)}${a && !a.online ? ' · Mac 离线' : ''}</div>` : ''}`;
}
function renderQuota() {
  const html = quotaHTML();
  const pop = $('#quotaPop'); if (pop) pop.innerHTML = html;
  const inline = $('#quotaInline'); if (inline) inline.innerHTML = html; // 对话里发 /usage 时显示的那张卡片
  document.querySelectorAll('[data-quota-refresh]').forEach(b => b.onclick = () => refreshQuota());
  updateQuotaRing();
}
async function refreshQuota(auto = false) {
  if (S.quota.loading) return;
  const a = pickAgent(); if (!a) { if (!auto) { S.quota.error = 'Mac 还没连上'; renderQuota(); } return; }
  if (auto && !a.online) return;
  S.quota = { loading: true, error: null }; renderQuota();
  try {
    const r = await api('POST', '/api/quota', { agent: a.name, maxAge: auto ? 4 * 60000 : 0 });
    if (r.quota) a.quota = r.quota;
    S.quota = { loading: false, error: r.error || null };
  } catch (e) { S.quota = { loading: false, error: e.message }; }
  renderQuota();
}
function setQuotaOpen(open) {
  S.quotaOpen = open; const pop = $('#quotaPop'); if (!pop) return;
  pop.hidden = !open;
  if (open) { renderQuota(); const q = pickAgent()?.quota; if (!q || Date.now() - (q.at || 0) > 60000) refreshQuota(); } // 超过 1 分钟的数据自动刷新
}
const QUOTA_EVERY = 5 * 60000;
setInterval(() => { if (S.me && S.loaded && document.visibilityState === 'visible') refreshQuota(true); }, QUOTA_EVERY);
document.addEventListener('visibilitychange', () => {
  const q = pickAgent()?.quota;
  if (S.me && S.loaded && document.visibilityState === 'visible' && Date.now() - (q?.at || 0) > QUOTA_EVERY) refreshQuota(true);
});
document.addEventListener('mousedown', e => { if (S.quotaOpen && !e.target.closest('#quotaPop, #quotaBtn')) setQuotaOpen(false); });
// 对话里发 /usage：不发给 AI，直接在对话末尾显示额度卡片（不保存）
function showUsageInChat() {
  const inner = $('#msgsInner'); if (!inner) return;
  $('#quotaInline')?.closest('.turn')?.remove();
  const el = document.createElement('div'); el.className = 'turn';
  el.innerHTML = '<div class="bubble-user">/usage</div><div class="reply"><div class="quota-card card" id="quotaInline"></div></div>';
  inner.appendChild(el); renderQuota(); scrollBottom(true); refreshQuota();
}

function updateHeadAgent() {
  const d = $('#headDot'); if (!d) return;
  const on = S.agents.filter(a => a.online).length;
  d.className = 'dot' + (on ? ' on' : ''); d.title = on ? `${on} 台设备在线` : '没有设备在线';
}
function renderView() {
  const m = $('#main'); if (!m) return;
  ({ chat: viewChat, tasks: viewTasks, agents: viewAgents, users: viewUsers }[S.view] || viewChat)(m);
}

// ============================================================ 登录
function loginHTML() {
  return `<form class="card login" id="loginForm">
    <h1 style="margin-bottom:20px">AI 遥控台</h1>
    <label class="field"><span>用户名</span><input class="input" name="username" autocomplete="username" required></label>
    <label class="field"><span>密码</span><input class="input" name="password" type="password" autocomplete="current-password" required></label>
    <div class="err" id="loginErr"></div>
    <button class="btn primary" style="width:100%;justify-content:center">登录</button></form>`;
}
function bindLogin() {
  $('#loginForm').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    try { const r = await api('POST', '/api/login', { username: f.get('username'), password: f.get('password') }); S.me = r.user; render(); afterLogin(); }
    catch (err) { $('#loginErr').textContent = err.message; }
  };
}
function changePassword() {
  modal(`<h3>修改密码</h3>
    <label class="field"><span>原密码</span><input class="input" type="password" id="pwOld"></label>
    <label class="field"><span>新密码（至少 6 位）</span><input class="input" type="password" id="pwNew"></label>`,
  async () => { await tryApi('POST', '/api/me/password', { old: $('#pwOld').value, password: $('#pwNew').value }); toast('密码已修改'); });
}

function prefsDialog() {
  const m = modal(`<h3>偏好设置</h3>
    <div class="field"><span>发送消息</span><div class="levels">${Object.entries(SEND_KEYS).map(([k, v]) => `<label class="level ${PREFS.sendKey === k ? 'on' : ''}">
      <input type="radio" name="sendKey" value="${k}" ${PREFS.sendKey === k ? 'checked' : ''}><div><b>${v.name}</b><small>${v.desc}</small></div></label>`).join('')}</div></div>
    <div class="field"><span>新对话</span><label class="checks"><label><input type="checkbox" id="pRemember" ${PREFS.rememberNewConv ? 'checked' : ''}>记住上次选的设备、CLI、模型、目录和权限</label></label></div>`,
  async () => {
    const remember = $('#pRemember').checked;
    savePrefs({ sendKey: m.querySelector('input[name=sendKey]:checked')?.value || 'enter', rememberNewConv: remember });
    if (!remember) localStorage.removeItem('aib.lastConv');
    const ta = $('#input'); if (ta) ta.title = sendKeyHint();
    toast('已保存');
  }, { okText: '保存' });
  m.querySelectorAll('input[name=sendKey]').forEach(r => r.onchange = () => m.querySelectorAll('.level').forEach(l => l.classList.toggle('on', l.querySelector('input').checked)));
}

// ============================================================ 弹窗
function modal(inner, onOk, { okText = '确定', wide = false, noFoot = false } = {}) {
  const m = document.createElement('div'); m.className = 'mask';
  m.innerHTML = `<div class="card modal ${wide ? 'wide' : ''}">${inner}${noFoot ? '' : `<div class="modal-foot"><button class="btn" data-x>取消</button><button class="btn primary" data-ok>${okText}</button></div>`}</div>`;
  document.body.appendChild(m);
  const close = () => { m.remove(); if (m._onClose) m._onClose(); };
  m.addEventListener('mousedown', e => { if (e.target === m) close(); });
  m.querySelectorAll('[data-x]').forEach(b => b.onclick = close);
  const ok = m.querySelector('[data-ok]');
  if (ok) ok.onclick = async () => { ok.disabled = true; try { await onOk?.(m); close(); } catch { ok.disabled = false; } };
  m.close = close;
  return m;
}

// ============================================================ 对话页
function viewChat(m) {
  m.innerHTML = `
    <aside class="side ${S.sideOpen ? 'open' : ''}" id="side">
      <div class="side-head"><button class="btn primary" id="newConv">＋ 新对话</button></div>
      <div class="convs" id="convList"></div>
      <div class="side-foot"><a class="btn" href="/api/export" download title="所有对话打成一个 zip，解压后双击 index.html 查看">⬇ 备份全部对话</a></div>
    </aside>
    <div class="side-mask ${S.sideOpen ? 'open' : ''}" id="sideMask"></div>
    <section class="chat" id="chat"></section>`;
  $('#newConv').onclick = () => { setSide(false); S.conv = null; S.tasks = new Map(); S.draft = null; renderConvList(); renderChat(); $('#input')?.focus(); };
  $('#sideMask').onclick = () => setSide(false);
  renderConvList();
  renderChat();
}
function convSub(c) {
  return `${CLI_NAME[c.cli] || c.cli} · ${modelLabel(c.cli, c.model)}`;
}
function renderConvList() {
  const el = $('#convList'); if (!el) return;
  const running = new Set([...S.tasks.values(), ...S.allTasks].filter(t => ['queued', 'dispatched', 'running'].includes(t.status)).map(t => t.convId));
  S.convs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  el.innerHTML = S.convs.length ? S.convs.map(c => `
    <div class="conv ${S.conv?.id === c.id ? 'on' : ''}" data-id="${c.id}">
      <div class="t">${running.has(c.id) ? '<span class="spin" style="color:var(--accent);width:10px;height:10px"></span>' : ''}${esc(c.title)}</div>
      <div class="s">${esc(convSub(c))} · ${fmtTime(c.updatedAt)}</div></div>`).join('')
    : S.loaded ? '<div class="empty">还没有对话</div>' : '';
  el.querySelectorAll('.conv').forEach(d => d.onclick = () => { setSide(false); openConv(d.dataset.id); });
}
async function openConv(id) {
  const r = await tryApi('GET', '/api/convs/' + id);
  S.conv = r.conv; S.tasks = new Map(r.tasks.map(t => [t.id, t]));
  renderConvList(); renderChat();
}
// ---- 新对话：顶部直接选 CLI 和模型，发第一条消息时才创建对话
S.draft = null; // { cli, model }
function draftChoice(agent) {
  if (!S.draft) {
    const last = PREFS.rememberNewConv ? loadJSON('aib.lastConv', {}) : {};
    S.draft = { cli: CLI_CHOICES.includes(last.cli) ? last.cli : DEFAULT_CHOICE.cli, model: last.model ?? DEFAULT_CHOICE.model };
  }
  const ok = k => !!agent?.clis?.[k]?.ok;
  if (agent && !ok(S.draft.cli)) { const k = CLI_CHOICES.find(ok); if (k) S.draft = { cli: k, model: null }; }
  const models = modelChoices(S.draft.cli, agent);
  if (!models.some(([v]) => v === (S.draft.model ?? ''))) S.draft.model = S.draft.cli === 'claude' ? DEFAULT_CHOICE.model : models[0][0];
  return S.draft;
}
function renderNewChat() {
  const el = $('#newchat'); if (!el || !S.loaded) return;
  const a = pickAgent(), d = draftChoice(a);
  el.innerHTML = `<div class="newchat-inner">
    ${deviceChip(a)}
    ${pillsHTML('cli', CLI_CHOICES.map(k => { const c = a?.clis?.[k]; return [k, CLI_NAME[k], !c?.ok, !c ? '不可用' : c.ok ? '' : '未安装']; }), d.cli)}
    ${pillsHTML('model', modelChoices(d.cli, a), d.model ?? '')}
  </div>`;
  el.querySelectorAll('[data-cli]').forEach(b => b.onclick = () => { S.draft = { cli: b.dataset.cli, model: null }; renderNewChat(); });
  el.querySelectorAll('[data-model]').forEach(b => b.onclick = () => { S.draft.model = b.dataset.model; renderNewChat(); });
}
// 目录和权限不让选：自动用这台 Mac 上「每个对话独立文件夹」的目录，权限给到允许的最高一级（实际访问由 Mac 上的文件夹限制兜住）
async function ensureConv(title) {
  if (S.conv) return S.conv;
  const a = pickAgent();
  if (!a) { toast('Mac 还没连上', true); throw new Error('no agent'); }
  const d = draftChoice(a);
  const ws = a.workspaces.find(w => w.isolate) || a.workspaces[0];
  const level = ws && allowedLevels(a, ws.name).filter(l => l.ok).pop()?.k;
  if (!ws || !level) { toast('没有可用的目录', true); throw new Error('no workspace'); }
  const r = await tryApi('POST', '/api/convs', { agent: a.name, cli: d.cli, model: d.model || null, workspace: ws.name, level, title });
  if (PREFS.rememberNewConv) localStorage.setItem('aib.lastConv', JSON.stringify({ cli: d.cli, model: d.model }));
  S.convs.unshift({ ...r.conv, username: S.me.username }); S.conv = r.conv; S.tasks = new Map(); S.draft = null;
  renderConvList();
  return S.conv;
}
function rerenderChatKeepInput() {
  const v = $('#input')?.value || ''; renderChat();
  const ta = $('#input'); if (ta) { ta.value = v; ta.focus(); }
}
function renderChat() {
  const el = $('#chat'); if (!el) return;
  const c = S.conv;
  el.innerHTML = `
    <div class="chat-head">
      <button class="icon-btn menu-btn" id="menuBtn">☰</button>
      <div style="min-width:0;flex:1">
        <div class="title">${c ? esc(c.title) : '新对话'}</div>
        ${c ? `<div class="meta">${deviceChip(S.agents.find(a => a.name === c.agent))}<span class="chip">${esc(CLI_NAME[c.cli] || c.cli)} · ${esc(modelLabel(c.cli, c.model))}</span></div>` : ''}
      </div>
      ${c ? `<a class="icon-btn" href="/api/convs/${esc(c.id)}/export" download title="下载这个对话的备份（zip，解压后双击 index.html 查看）">⬇</a><button class="icon-btn" id="convMenu" title="对话设置">⋯</button>` : ''}
    </div>
    ${c ? '' : '<div class="newchat" id="newchat"></div>'}
    <div class="msgs" id="msgs"><div class="msgs-inner" id="msgsInner"></div></div>
    <div class="composer" id="composer">
      <div class="pending" id="pending"></div>
      <div class="composer-inner">
        <button class="icon-btn attach" id="attachBtn" title="添加附件（也可以粘贴或拖进来）">📎</button>
        <input type="file" id="fileInput" multiple hidden>
        <textarea id="input" rows="1" placeholder="${c ? `给 ${esc(CLI_NAME[c.cli] || c.cli)} 发消息…` : '发消息开始新对话…'}" title="${esc(sendKeyHint())}"></textarea>
        <button class="btn primary" id="sendBtn">发送</button>
      </div>
      <div class="hint" id="hint"></div>
    </div>`;
  $('#menuBtn').onclick = toggleSide;
  if (c) $('#convMenu').onclick = convMenu; else renderNewChat();
  const inner = $('#msgsInner');
  const tasks = c ? [...S.tasks.values()].sort((a, b) => a.createdAt - b.createdAt) : [];
  inner.innerHTML = tasks.map(t => `<div class="turn" id="turn-${t.id}"></div>`).join('');
  tasks.forEach(t => renderTurn(t.id));
  scrollBottom(true);
  const ta = $('#input');
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 220) + 'px'; };
  ta.onkeydown = e => { if (isSendKey(e)) { e.preventDefault(); sendMsg(); } };
  $('#sendBtn').onclick = sendMsg;
  $('#attachBtn').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
  ta.addEventListener('paste', e => {
    const fs = [...(e.clipboardData?.files || [])];
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  });
  const chat = $('#chat');
  chat.ondragover = e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); chat.classList.add('dragging'); } };
  chat.ondragleave = e => { if (!chat.contains(e.relatedTarget)) chat.classList.remove('dragging'); };
  chat.ondrop = e => { e.preventDefault(); chat.classList.remove('dragging'); addFiles([...e.dataTransfer.files]); };
  renderPending();
  updateComposer();
}

// ---- 附件：选中即上传到中继，发送时只带 id
S.pending = [];
const MAX_ATTACH = 25 * 1024 * 1024;
async function addFiles(list) {
  if (!S.conv) { try { await ensureConv('新对话'); } catch { return; } rerenderChatKeepInput(); } // 新对话里先加附件：先建好对话
  for (const file of list) {
    if (S.pending.length >= 10) { toast('一次最多 10 个附件', true); break; }
    if (file.size > MAX_ATTACH) { toast(`${file.name} 超过 25MB`, true); continue; }
    const name = file.name && file.name !== 'image.png' ? file.name : `粘贴图片-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`;
    const p = { key: Math.random().toString(36).slice(2), name, mime: file.type || 'application/octet-stream', size: file.size, uploading: true,
      thumb: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, convId: S.conv.id };
    S.pending.push(p); renderPending();
    try {
      const r = await fetch('/api/uploads', { method: 'POST', body: file, headers: {
        'Content-Type': 'application/octet-stream', 'X-Upload': '1', 'X-Conv': S.conv.id, 'X-Name': encodeURIComponent(name), 'X-Mime': p.mime } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      p.id = j.file.id; p.uploading = false;
    } catch (e) { toast(`${name} 上传失败：${e.message}`, true); S.pending = S.pending.filter(x => x !== p); }
    renderPending();
  }
}
function renderPending() {
  const el = $('#pending'); if (!el) return;
  const list = S.pending.filter(p => p.convId === S.conv?.id);
  el.innerHTML = list.map(p => `<div class="pend">
    ${p.thumb ? `<img src="${p.thumb}" alt="">` : `<span class="ficon">${ICON[kindOf(p)]}</span>`}
    <div class="pend-name">${esc(p.name)}<div class="faint">${p.uploading ? '<span class="spin"></span> 上传中' : fmtSize(p.size)}</div></div>
    <button class="icon-btn" data-unpend="${p.key}" title="移除">✕</button></div>`).join('');
  el.querySelectorAll('[data-unpend]').forEach(b => b.onclick = () => {
    const p = S.pending.find(x => x.key === b.dataset.unpend);
    S.pending = S.pending.filter(x => x !== p);
    if (p?.id) api('DELETE', '/api/uploads/' + p.id).catch(() => {});
    renderPending();
  });
}
// 手机布局下的对话列表抽屉：点遮罩、选对话、新建对话、切页面、按 Esc 都会收起
function setSide(open) { S.sideOpen = open; $('#side')?.classList.toggle('open', open); $('#sideMask')?.classList.toggle('open', open); }
function toggleSide() { setSide(!S.sideOpen); }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sideOpen) setSide(false); });
function updateComposer() {
  const hint = $('#hint'); if (!hint || !S.loaded) return;
  const agent = S.conv ? S.agents.find(a => a.name === S.conv.agent) : pickAgent();
  const busy = S.conv ? [...S.tasks.values()].filter(t => ['queued', 'dispatched', 'running'].includes(t.status)).length : 0;
  hint.textContent = !agent?.online ? 'Mac 离线，消息会等它上线后执行' : busy ? `还有 ${busy} 条在执行，新消息会排在后面` : '';
}
function scrollBottom(force) {
  const m = $('#msgs'); if (!m) return;
  if (force || m.scrollHeight - m.scrollTop - m.clientHeight < 160) m.scrollTop = m.scrollHeight;
}
async function sendMsg() {
  const ta = $('#input'); const v = ta.value.trim();
  if (/^\/(usage|额度)$/i.test(v)) { ta.value = ''; showUsageInChat(); return; } // 查额度，不发给 AI
  const atts = S.pending.filter(p => p.convId === S.conv?.id);
  if (!v && !atts.length) return;
  if (atts.some(p => p.uploading)) return toast('附件还在上传，稍等一下');
  $('#sendBtn').disabled = true;
  try {
    if (!S.conv) await ensureConv(v.replace(/\s+/g, ' ').slice(0, 30) || '新对话'); // 新对话：发第一条时才创建
    const r = await tryApi('POST', `/api/convs/${S.conv.id}/send`, { prompt: v, attachments: atts.map(p => p.id) });
    atts.forEach(p => p.thumb && URL.revokeObjectURL(p.thumb));
    S.pending = S.pending.filter(p => !atts.includes(p));
    if (!S.tasks.has(r.task.id)) S.tasks.set(r.task.id, { ...r.task, events: [] });
    const c = S.convs.find(x => x.id === S.conv.id); if (c) { c.updatedAt = Date.now(); if (c.title === '新对话' && v) { c.title = v.slice(0, 30); S.conv.title = c.title; } }
    ta.value = '';
    renderChat(); renderConvList(); scrollBottom(true);
  } catch { /* tryApi 已经提示过 */ } finally { const b = $('#sendBtn'); if (b) b.disabled = false; $('#input')?.focus(); }
}

// ---- 文件：图标、卡片、预览、diff
function findMeta(id) {
  const pools = [...S.tasks.values(), ...(S.detail ? [S.detail] : [])];
  for (const t of pools) { const f = (t.outputs || []).find(x => x.id === id) || (t.inputs || []).find(x => x.id === id); if (f) return f; }
  return null;
}
async function previewFile(id) {
  const f = findMeta(id) || { id, name: '文件', mime: '' };
  const k = kindOf(f), url = fileUrl(id);
  let body;
  if (k === 'image') body = `<div class="pv-img"><img src="${url}" alt=""></div>`;
  // 隔离由服务端的 CSP: sandbox 响应头保证（页面变成不透明源，拿不到本站 cookie / API）
  else if (k === 'html') body = `<iframe class="pv-frame" src="${url}"></iframe>`;
  else if (k === 'pdf') body = `<iframe class="pv-frame" src="${url}"></iframe>`;
  else if (k === 'audio') body = `<audio controls src="${url}" style="width:100%"></audio>`;
  else if (k === 'video') body = `<video controls src="${url}" style="width:100%;max-height:70vh"></video>`;
  else if (k === 'text') body = `<div id="pvText" class="faint">加载中…</div>`;
  else body = `<div class="empty">这种文件没法在网页里预览，请下载后打开</div>`;
  const m = modal(`<div class="pv-head"><div><b>${esc(f.name)}</b><div class="faint">${esc(f.path || '')}${f.size ? ' · ' + fmtSize(f.size) : ''}</div></div>
      <div style="display:flex;gap:6px"><a class="btn sm" href="${url}" target="_blank" rel="noopener">新窗口</a><a class="btn sm" href="${fileUrl(id, 1)}" download>下载</a><button class="btn sm" data-x>关闭</button></div></div>${body}`,
    null, { wide: true, noFoot: true });
  if (k === 'text') {
    try {
      const r = await fetch(url); let txt = await r.text();
      const cut = txt.length > 400000; if (cut) txt = txt.slice(0, 400000);
      const box = m.querySelector('#pvText'); if (!box) return;
      if (/markdown/.test(f.mime)) { box.className = 'md pv-md'; box.innerHTML = md(txt); }
      else { box.className = ''; box.innerHTML = `<pre class="code-view">${txt.split('\n').map((l, i) => `<span class="ln">${i + 1}</span>${esc(l)}`).join('\n')}</pre>${cut ? '<div class="faint">（文件过大，只显示前 400KB）</div>' : ''}`; }
    } catch { m.querySelector('#pvText').textContent = '加载失败'; }
  }
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-diff]')) return; // 改动对比的展开由 render.js 处理
  const f = e.target.closest('[data-file]');
  if (f && !e.ctrlKey && !e.metaKey) { e.preventDefault(); previewFile(f.dataset.file); }
});

function renderTurn(id, streaming) {
  const t = S.tasks.get(id); if (!t) return;
  let el = document.getElementById('turn-' + id);
  if (!el) {
    const inner = $('#msgsInner'); if (!inner) return;
    if (inner.querySelector('.empty')) inner.innerHTML = '';
    el = document.createElement('div'); el.className = 'turn'; el.id = 'turn-' + id; inner.appendChild(el);
  }
  const active = ['queued', 'dispatched', 'running'].includes(t.status);
  const hasText = t.events?.some(e => e.k === 'text' && e.d.trim());
  el.innerHTML = `
    ${t.prompt ? `<div class="bubble-user">${esc(t.prompt)}</div>` : ''}
    ${inputsHTML(t)}
    <div class="reply">
      <div class="reply-head"><span class="chip ${t.status}">${active ? '<span class="spin"></span>' : ''}${ST[t.status]}${t.cancelRequested && active ? ' · 停止中' : ''}</span>
        <span>${fmtTime(t.createdAt)}</span>
        ${t.status === 'queued' && t.waitingFor === 'workspace' ? `<span class="faint">「${esc(t.workspace)}」目录里有别的任务在跑，等它结束后自动开始</span>` : ''}
        ${active ? `<button class="btn sm danger" data-cancel="${t.id}" ${t.cancelRequested ? 'disabled' : ''}>${t.cancelRequested ? '停止中…' : '停止'}</button>` : ''}
        ${['failed', 'cancelled'].includes(t.status) ? `<button class="btn sm" data-retry="${t.id}">重试</button>` : ''}</div>
      ${eventsHTML(t.events || [], t.linkMap)}
      ${t.status === 'done' && !hasText && t.result ? `<div class="md">${md(t.result, t.linkMap)}</div>` : ''}
      ${outputsHTML(t)}
      ${t.error && t.status !== 'cancelled' ? `<div class="errbox">${esc(t.error)}</div>` : ''}
      ${t.endedAt ? `<div class="usage">${esc(usageText(t))}</div>` : ''}
    </div>`;
  el.querySelector('[data-cancel]')?.addEventListener('click', e => stopTask(id, e.currentTarget));
  el.querySelector('[data-retry]')?.addEventListener('click', async () => { const r = await tryApi('POST', `/api/tasks/${id}/retry`); S.tasks.set(r.task.id, { ...r.task, events: [] }); renderTurn(r.task.id); scrollBottom(true); });
  scrollBottom(!streaming && active);
}
// 停止：按钮立即变灰防连点；同一任务只发一次请求
const stopping = new Set();
async function stopTask(id, btn) {
  if (stopping.has(id)) return;
  stopping.add(id);
  if (btn) { btn.disabled = true; btn.textContent = '停止中…'; }
  try { await tryApi('POST', `/api/tasks/${id}/cancel`); }
  catch { stopping.delete(id); if (btn) { btn.disabled = false; btn.textContent = '停止'; } }
}
function convMenu() {
  const c = S.conv, agent = S.agents.find(a => a.name === c.agent);
  let model = c.model || '';
  const m = modal(`<h3>对话设置</h3>
    <label class="field"><span>标题</span><input class="input" id="cTitle" value="${esc(c.title)}"></label>
    <div class="field"><span>模型</span><div id="cModel"></div></div>
    ${c.sessionId ? '<label class="checks"><label><input type="checkbox" id="cReset">清空上下文，下一条消息重新开始</label></label>' : ''}
    <div style="border-top:1px solid var(--line);padding-top:12px;margin-top:4px"><button class="btn danger" id="cDel">删除这个对话</button></div>`,
  async () => {
    const r = await tryApi('PATCH', '/api/convs/' + c.id, { title: $('#cTitle').value, model: model || null, resetSession: $('#cReset')?.checked });
    Object.assign(S.conv, r.conv); Object.assign(S.convs.find(x => x.id === c.id) || {}, r.conv);
    renderConvList(); renderChat();
  }, { okText: '保存' });
  const drawModels = () => {
    const box = m.querySelector('#cModel');
    box.innerHTML = pillsHTML('model', modelChoices(c.cli, agent), model);
    box.querySelectorAll('[data-model]').forEach(b => b.onclick = () => { model = b.dataset.model; drawModels(); });
  };
  drawModels();
  $('#cDel').onclick = async () => {
    if (!confirm('删除这个对话和它的全部记录？')) return;
    await tryApi('DELETE', '/api/convs/' + c.id);
    S.convs = S.convs.filter(x => x.id !== c.id); S.conv = null; S.tasks = new Map(); m.close(); renderConvList(); renderChat();
  };
}

// 这个用户在这台设备的这个目录上能用的最高权限
const LVORDER = ['read', 'edit', 'full'];
function allowedLevels(agent, wsName) {
  const ws = agent?.workspaces.find(w => w.name === wsName);
  const max = Math.min(LVORDER.indexOf(S.me.perms.maxLevel), LVORDER.indexOf(ws?.maxLevel || 'full'));
  return LVORDER.map((k, i) => ({ k, ok: i <= max }));
}

// ============================================================ 任务页
async function viewTasks(m) {
  m.innerHTML = `<div class="page"><div class="page-inner">
    <div class="page-head"><div><h2>任务</h2></div>
      <button class="btn" id="refreshT">刷新</button></div>
    <div class="stats" id="stats"></div>
    <div class="filters" id="filters"></div>
    <div class="card" style="overflow:auto"><table class="list" id="taskTable"></table></div></div></div>`;
  $('#refreshT').onclick = () => loadTasks();
  await loadTasks();
}
async function loadTasks() {
  const r = await tryApi('GET', '/api/tasks'); S.allTasks = r.tasks; renderTaskTable();
}
function renderTaskTable() {
  const tb = $('#taskTable'); if (!tb) return;
  const by = {}; for (const t of S.allTasks) by[t.status] = (by[t.status] || 0) + 1;
  const active = (by.queued || 0) + (by.dispatched || 0) + (by.running || 0);
  $('#stats').innerHTML = [['进行中', active], ['完成', by.done || 0], ['失败', by.failed || 0], ['已取消', by.cancelled || 0], ['合计', S.allTasks.length]]
    .map(([l, n]) => `<div class="card stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
  const fs = [['', '全部'], ['active', '进行中'], ['done', '完成'], ['failed', '失败'], ['cancelled', '已取消']];
  $('#filters').innerHTML = fs.map(([k, n]) => `<button data-f="${k}" class="${S.taskFilter === k ? 'on' : ''}">${n}</button>`).join('');
  $('#filters').querySelectorAll('button').forEach(b => b.onclick = () => { S.taskFilter = b.dataset.f; renderTaskTable(); });
  const list = S.allTasks.filter(t => !S.taskFilter || (S.taskFilter === 'active' ? ['queued', 'dispatched', 'running'].includes(t.status) : t.status === S.taskFilter));
  const admin = S.me.role === 'admin';
  tb.innerHTML = `<tr><th>状态</th><th>内容</th>${admin ? '<th>用户</th>' : ''}<th class="hide-m">设备 / CLI</th><th class="hide-m">权限</th><th>时间</th><th></th></tr>` +
    (list.length ? list.map(t => `<tr class="click" data-id="${t.id}">
      <td><span class="chip ${t.status}">${['queued', 'dispatched', 'running'].includes(t.status) ? '<span class="spin"></span>' : ''}${ST[t.status]}</span></td>
      <td><div class="ellip">${esc(t.prompt)}</div><div class="faint ellip">${esc(t.convTitle || '')}</div></td>
      ${admin ? `<td>${esc(t.username || '')}</td>` : ''}
      <td class="hide-m">${esc(t.agent)}<div class="faint">${esc(CLI_NAME[t.cli] || t.cli)} · ${esc(t.workspace)}</div></td>
      <td class="hide-m"><span class="chip lv-${t.level}">${LV[t.level]?.name}</span></td>
      <td style="white-space:nowrap">${fmtTime(t.createdAt)}<div class="faint">${t.endedAt && t.startedAt ? fmtDur(t.endedAt - t.startedAt) : ''}</div></td>
      <td>${['queued', 'dispatched', 'running'].includes(t.status) ? `<button class="btn sm danger" data-cancel="${t.id}" ${t.cancelRequested ? 'disabled' : ''}>${t.cancelRequested ? '停止中…' : '停止'}</button>` : ''}</td></tr>`).join('')
      : `<tr><td colspan="7" class="empty">没有任务</td></tr>`);
  tb.querySelectorAll('tr.click').forEach(r => r.onclick = e => { if (e.target.closest('[data-cancel]')) return; openTaskDetail(r.dataset.id); });
  tb.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => stopTask(b.dataset.cancel, b));
}
async function openTaskDetail(id) {
  const r = await tryApi('GET', '/api/tasks/' + id);
  S.detail = r.task; S.detailTask = id;
  const m = modal(`<div id="detailBody"></div>`, null, { wide: true, noFoot: true });
  m._onClose = () => { S.detailTask = null; S.detail = null; };
  S.detailModal = m;
  refreshDetail(true);
}
async function refreshDetail(first) {
  if (!S.detailTask) return;
  if (!first) { try { const r = await api('GET', '/api/tasks/' + S.detailTask); S.detail = r.task; } catch { return; } }
  const t = S.detail; const body = $('#detailBody'); if (!body) return;
  const active = ['queued', 'dispatched', 'running'].includes(t.status);
  body.innerHTML = `<h3 style="display:flex;gap:10px;align-items:center">任务详情 <span class="chip ${t.status}">${ST[t.status]}</span></h3>
    <dl class="kv"><dt>对话</dt><dd>${esc(t.convTitle || '')}</dd><dt>用户</dt><dd>${esc(t.username)}</dd>
      <dt>设备</dt><dd>${esc(t.agent)} · ${esc(CLI_NAME[t.cli] || t.cli)}${t.model ? ' · ' + esc(t.model) : ''}</dd><dt>目录 / 权限</dt><dd>${esc(t.workspace)} · ${LV[t.level]?.name}</dd>
      <dt>时间</dt><dd>${new Date(t.createdAt).toLocaleString()}${t.endedAt && t.startedAt ? ' · 耗时 ' + fmtDur(t.endedAt - t.startedAt) : ''}</dd>
      ${t.sessionId ? `<dt>会话 ID</dt><dd><code>${esc(t.sessionId)}</code></dd>` : ''}
      ${t.usage ? `<dt>用量</dt><dd>${esc(usageText(t))}</dd>` : ''}</dl>
    <div class="field"><span>指令</span><div class="task-out" style="white-space:pre-wrap">${esc(t.prompt)}${inputsHTML(t)}</div></div>
    <div class="field"><span>输出</span><div class="task-out">${eventsHTML(t.events || [], t.linkMap, true) || '<span class="faint">（暂无输出）</span>'}${t.error ? `<div class="errbox">${esc(t.error)}</div>` : ''}${outputsHTML(t)}</div></div>
    <div class="modal-foot">${active ? `<button class="btn danger" id="dCancel">停止</button>` : ''}
      ${['failed', 'cancelled'].includes(t.status) && t.userId === S.me.id ? '<button class="btn" id="dRetry">重试</button>' : ''}
      <button class="btn" id="dOpen">打开对话</button><button class="btn primary" data-x>关闭</button></div>`;
  body.querySelector('[data-x]').onclick = () => S.detailModal.close();
  $('#dCancel')?.addEventListener('click', e => stopTask(t.id, e.currentTarget));
  $('#dRetry')?.addEventListener('click', async () => { await tryApi('POST', `/api/tasks/${t.id}/retry`); toast('已重新排队'); S.detailModal.close(); loadTasks(); });
  $('#dOpen').onclick = () => { S.detailModal.close(); if (t.userId !== S.me.id) return toast('这是别人的对话，只能在任务里查看'); S.view = 'chat'; location.hash = 'chat'; render(); openConv(t.convId); };
}

// ============================================================ 设备页
function viewAgents(m) {
  const admin = S.me.role === 'admin';
  m.innerHTML = `<div class="page"><div class="page-inner">
    <div class="page-head"><div><h2>设备</h2></div></div>
    <div class="agents">${S.agents.length ? S.agents.map(a => `<div class="card agent">
      <h4><span class="dot ${a.online ? 'on' : ''}"></span>${esc(a.name)}</h4>
      <div class="faint" style="margin-bottom:8px">${esc(a.platform)} · ${esc(a.hostname || '')} · ${a.online ? '在线' : '离线，最后在线 ' + fmtTime(a.lastSeen)}</div>
      ${Object.entries(a.clis).map(([k, c]) => `<div class="row"><span>${esc(CLI_NAME[k] || k)}</span><span class="${c.ok ? '' : 'faint'}">${c.ok ? esc(c.version) : '不可用'}</span></div>`).join('')}
      <div class="row"><span>并发</span><span>${a.running.length} / ${a.maxConcurrent}</span></div>
      <div class="row"><span>文件夹限制</span><span class="${a.confine ? '' : 'faint'}">${a.confine ? '开' : '关'}</span></div>
      <div class="row" style="display:block"><span>工作目录</span><div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${a.workspaces.map(w => `<span class="chip lv-${w.maxLevel}" title="${esc(w.note)}">📁 ${esc(w.name)}</span>`).join('')}</div></div>
    </div>`).join('') : '<div class="card empty">还没有设备连上来</div>'}</div>
    ${admin ? `<h2 style="margin-top:28px">接入新设备</h2>
    <div class="card" style="padding:18px;margin-top:10px">
      <div class="field"><span>Agent Token</span><div class="token" id="tok">${esc(S.agentToken || '')}</div>
        <div style="display:flex;gap:8px;margin-top:8px"><button class="btn sm" id="copyTok">复制</button><button class="btn sm danger" id="rotTok">更换 token</button></div></div>
    </div>` : ''}
  </div></div>`;
  $('#copyTok')?.addEventListener('click', () => navigator.clipboard.writeText(S.agentToken).then(() => toast('已复制')));
  $('#rotTok')?.addEventListener('click', async () => {
    if (!confirm('更换后，所有已连接的设备都要改配置里的 token 才能重新连上。继续？')) return;
    const r = await tryApi('POST', '/api/agent-token/rotate'); S.agentToken = r.agentToken; renderView();
  });
}

// ============================================================ 用户权限页
async function viewUsers(m) {
  m.innerHTML = `<div class="page"><div class="page-inner">
    <div class="page-head"><div><h2>用户与权限</h2></div>
      <button class="btn primary" id="addUser">＋ 添加用户</button></div>
    <div class="card" style="overflow:auto"><table class="list" id="userTable"></table></div></div></div>`;
  $('#addUser').onclick = () => userDialog();
  const r = await tryApi('GET', '/api/users'); S.users = r.users; renderUsers();
}
const listText = l => !l || l.includes('*') ? '全部' : l.length ? l.join('、') : '无';
function renderUsers() {
  const tb = $('#userTable'); if (!tb) return;
  tb.innerHTML = `<tr><th>用户</th><th>角色</th><th class="hide-m">CLI</th><th class="hide-m">设备 / 目录</th><th>最高权限</th><th>今日 / 额度</th><th></th></tr>` + S.users.map(u => `
    <tr><td><b>${esc(u.username)}</b>${u.disabled ? ' <span class="chip failed">已停用</span>' : ''}</td>
      <td>${u.role === 'admin' ? '<span class="chip running">管理员</span>' : '<span class="chip">成员</span>'}</td>
      <td class="hide-m">${esc(listText(u.perms.clis))}</td>
      <td class="hide-m">${esc(listText(u.perms.agents))}<div class="faint">${esc(listText(u.perms.workspaces))}</div></td>
      <td><span class="chip lv-${u.perms.maxLevel}">${LV[u.perms.maxLevel]?.name}</span></td>
      <td>${u.today} / ${u.perms.dailyLimit || '∞'}<div class="faint">累计 ${u.total}</div></td>
      <td><button class="btn sm" data-edit="${u.id}">编辑</button></td></tr>`).join('');
  tb.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => userDialog(S.users.find(u => u.id === b.dataset.edit)));
}
function userDialog(u) {
  const isNew = !u;
  const p = u?.perms || { clis: ['claude', 'codex'], agents: ['*'], workspaces: ['*'], maxLevel: 'edit', dailyLimit: 50 };
  const allClis = [...new Set(['claude', 'codex', ...S.agents.flatMap(a => Object.keys(a.clis))])];
  const allAgents = S.agents.map(a => a.name);
  const allWs = [...new Set(S.agents.flatMap(a => a.workspaces.map(w => w.name)))];
  const checks = (name, all, cur) => `<div class="checks"><label><input type="checkbox" data-g="${name}" value="*" ${cur.includes('*') ? 'checked' : ''}>全部</label>
    ${all.map(v => `<label><input type="checkbox" data-g="${name}" value="${esc(v)}" ${cur.includes(v) || cur.includes('*') ? 'checked' : ''}>${esc(CLI_NAME[v] || v)}</label>`).join('')}</div>`;
  const m = modal(`<h3>${isNew ? '添加用户' : '编辑用户：' + esc(u.username)}</h3>
    ${isNew ? '<label class="field"><span>用户名</span><input class="input" id="uName"></label>' : ''}
    <label class="field"><span>${isNew ? '密码（至少 6 位）' : '重置密码（留空不改）'}</span><input class="input" id="uPw" type="text" autocomplete="off"></label>
    <label class="field"><span>角色</span><select class="input" id="uRole"><option value="user">成员</option><option value="admin" ${u?.role === 'admin' ? 'selected' : ''}>管理员（可管理用户、看所有任务）</option></select></label>
    <div class="field"><span>可用的 CLI</span>${checks('clis', allClis, p.clis)}</div>
    <div class="field"><span>可用的设备</span>${checks('agents', allAgents, p.agents)}</div>
    <div class="field"><span>可用的工作目录</span>${checks('workspaces', allWs, p.workspaces)}</div>
    <div class="field"><span>最高权限级别</span><select class="input" id="uLv">${LVORDER.map(k => `<option value="${k}" ${p.maxLevel === k ? 'selected' : ''}>${LV[k].name} — ${LV[k].desc}</option>`).join('')}</select></div>
    <label class="field"><span>每日次数上限（0 = 不限）</span><input class="input" id="uLim" type="number" min="0" value="${p.dailyLimit || 0}"></label>
    ${isNew ? '' : `<label class="checks" style="margin-bottom:12px"><label><input type="checkbox" id="uDis" ${u.disabled ? 'checked' : ''}>停用这个账号</label></label>
      <button class="btn danger sm" id="uDel">删除用户</button>`}`,
  async () => {
    const grp = n => { const vals = [...m.querySelectorAll(`[data-g=${n}]:checked`)].map(x => x.value); return vals.includes('*') ? ['*'] : vals; };
    const perms = { clis: grp('clis'), agents: grp('agents'), workspaces: grp('workspaces'), maxLevel: $('#uLv').value, dailyLimit: +$('#uLim').value };
    const body = { role: $('#uRole').value, perms };
    if ($('#uPw').value) body.password = $('#uPw').value;
    if (isNew) { body.username = $('#uName').value; await tryApi('POST', '/api/users', body); }
    else { body.disabled = $('#uDis').checked; await tryApi('PUT', '/api/users/' + u.id, body); }
    toast('已保存'); viewUsers($('#main'));
  }, { okText: '保存' });
  m.querySelectorAll('[data-g]').forEach(cb => cb.onchange = () => {
    const g = cb.dataset.g; const boxes = [...m.querySelectorAll(`[data-g=${g}]`)];
    if (cb.value === '*') boxes.forEach(b => (b.checked = cb.checked));
    else if (!cb.checked) boxes.find(b => b.value === '*').checked = false;
  });
  $('#uDel')?.addEventListener('click', async () => {
    if (!confirm(`删除用户 ${u.username}？`)) return;
    await tryApi('DELETE', '/api/users/' + u.id); m.close(); viewUsers($('#main'));
  });
}

window.addEventListener('hashchange', () => {
  const h = location.hash.slice(1);
  if (S.me && h !== S.view && ['chat', 'tasks', 'agents', 'users'].includes(h)) { S.view = h; render(); }
});
boot();
