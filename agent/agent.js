// 执行端（Agent）：跑在闲置的 Mac Air 上，主动连中继领任务，调用本机 claude / codex CLI。
// 零依赖，Node 18+。用法：node agent/agent.js [配置文件路径]
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');

const VERSION = '1.0.0';
const cfgPath = path.resolve(process.argv[2] || process.env.AGENT_CONFIG || path.join(__dirname, 'agent.config.json'));
if (!fs.existsSync(cfgPath)) {
  console.error(`[agent] 找不到配置 ${cfgPath}，请复制 agent.config.example.json 改一份`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfg.relayUrl = (process.env.RELAY_URL || cfg.relayUrl || 'http://127.0.0.1:5227').replace(/\/$/, '');
cfg.token = process.env.AGENT_TOKEN || cfg.token;
cfg.name ||= os.hostname();
cfg.maxConcurrent ||= 3;
cfg.taskTimeoutMin ||= 30;
const IS_WIN = process.platform === 'win32';
const expandHome = p => p && p.replace(/^~(?=$|[\\/])/, os.homedir());

if (!cfg.token || /粘贴|paste/i.test(cfg.token)) {
  cfg.token = '';
  // 中继和 agent 在同一台机器上时：直接从中继的数据目录读 token
  try { cfg.token = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8')).agentToken; } catch {}
}
if (!cfg.token) { console.error('[agent] 缺少 token'); process.exit(1); }

// ---------------------------------------------------------------- 找 CLI
function newestChild(dir, file) {
  // 在 dir/<版本或哈希>/.../file 里找最新的一个（Windows 上的 Claude/Codex 安装目录形态）
  try {
    const hits = [];
    const walk = (d, depth) => {
      if (depth < 0) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f, depth - 1);
        else if (e.name === file) hits.push({ f, t: fs.statSync(f).mtimeMs });
      }
    };
    walk(dir, 5);
    return hits.sort((a, b) => b.t - a.t)[0]?.f || null;
  } catch { return null; }
}
function which(cmd) {
  try {
    const out = execFileSync(IS_WIN ? 'where' : '/bin/sh', IS_WIN ? [cmd] : ['-lc', `command -v ${cmd}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // Windows 上只要 .exe，.cmd 需要 shell，容易出转义问题
    return (IS_WIN ? lines.find(l => l.toLowerCase().endsWith('.exe')) : lines[0]) || null;
  } catch { return null; }
}
function findBin(kind) {
  const home = os.homedir();
  const candidates = [];
  if (IS_WIN) {
    const la = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    if (kind === 'codex') candidates.push(newestChild(path.join(la, 'OpenAI', 'Codex', 'bin'), 'codex.exe'));
    if (kind === 'claude') {
      candidates.push(path.join(home, '.local', 'bin', 'claude.exe'));
      candidates.push(newestChild(path.join(la, 'Claude-Data'), 'claude.exe'));
    }
  } else {
    candidates.push(
      path.join(home, '.local', 'bin', kind),
      path.join(home, '.claude', 'local', kind),
      `/opt/homebrew/bin/${kind}`, `/usr/local/bin/${kind}`,
      path.join(home, '.npm-global', 'bin', kind),
      '/Applications/Codex.app/Contents/Resources/codex',
    );
  }
  candidates.unshift(which(kind));
  return candidates.find(f => f && fs.existsSync(f)) || null;
}
function versionOf(bin) {
  try { return execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n')[0]; }
  catch (e) { return null; }
}

// 是否已登录：claude auth status（JSON，loggedIn）/ codex login status（退出码 0 = 已登录）
// 返回 true / false；命令不支持、超时等判断不了的情况返回 null（当作「不知道」，不拦）
const AUTH_ARGS = { claude: ['auth', 'status'], codex: ['login', 'status'], mock: ['auth', 'status'] };
function parseAuth(kind, err, stdout, stderr) {
  const out = String(stdout || '') + '\n' + String(stderr || '');
  if (kind === 'claude' || kind === 'mock') {
    const m = String(stdout || '').match(/\{[\s\S]*\}/);
    if (m) { try { const j = JSON.parse(m[0]); if (typeof j.loggedIn === 'boolean') return { loggedIn: j.loggedIn, method: j.authMethod || null }; } catch {} }
  }
  if (/not logged in|not signed in|未登录|please (log|sign) ?in|login required/i.test(out)) return { loggedIn: false };
  if (!err) return { loggedIn: true };
  // 退出码非 0、但看不出原因（老版本没有这个子命令、超时……）：不下结论
  if (err.killed || err.code === 'ETIMEDOUT' || /unknown|unrecognized|unexpected argument|invalid/i.test(out)) return null;
  return kind === 'codex' && typeof err.code === 'number' ? { loggedIn: false } : null;
}
function authOf(kind, bin, prefixArgs = []) {
  const args = AUTH_ARGS[kind];
  if (!args || !bin) return Promise.resolve(null);
  return new Promise(resolve => execFile(bin, [...prefixArgs, ...args], { encoding: 'utf8', timeout: 20000, env: childEnv(), windowsHide: true },
    (err, stdout, stderr) => resolve(parseAuth(kind, err, stdout, stderr))));
}

// 子进程环境：去掉宿主 Claude Code 注入的变量，避免嵌套调用时继承宿主身份/配置
function childEnv() {
  const env = { ...process.env };
  const nested = !!env.CLAUDE_CODE_SESSION_ID || !!env.CLAUDECODE;
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK') || k === 'CLAUDE_PID') delete env[k];
    if (nested && k === 'ANTHROPIC_BASE_URL') delete env[k];
  }
  // launchd 启动时 PATH 很短，补上常见路径，CLI 内部调用 git/node 才找得到
  if (!IS_WIN) env.PATH = [env.PATH, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(os.homedir(), '.local', 'bin')].filter(Boolean).join(':');
  return env;
}

// ---------------------------------------------------------------- 文件：快照 / 对比 / 类型
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', '.cache', '.ai-bridge', '.DS_Store', '.idea', '.vscode', 'Pods', '.gradle', 'target']);
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', tsx: 'text/plain', jsx: 'text/plain',
  json: 'application/json', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values', xml: 'application/xml', yaml: 'text/plain', yml: 'text/plain', toml: 'text/plain',
  py: 'text/plain', sh: 'text/plain', go: 'text/plain', rs: 'text/plain', java: 'text/plain', kt: 'text/plain', swift: 'text/plain', c: 'text/plain', h: 'text/plain', cpp: 'text/plain', cs: 'text/plain', rb: 'text/plain', php: 'text/plain', sql: 'text/plain', vue: 'text/plain', svelte: 'text/plain', log: 'text/plain', ini: 'text/plain', env: 'text/plain',
  pdf: 'application/pdf', zip: 'application/zip', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const extOf = f => path.extname(f).slice(1).toLowerCase();
const mimeOf = f => MIME[extOf(f)] || 'application/octet-stream';
// 只认真正的文本类型：docx/xlsx/pptx 的 MIME 里也带 "xml"，但它们是 zip 二进制
const TEXT_MIME = /^text\/|^application\/(json|xml)$|\+(json|xml)$/;
const isTextFile = f => { const m = mimeOf(f); return TEXT_MIME.test(m) || ['gitignore', 'dockerfile', 'makefile'].includes(path.basename(f).toLowerCase()); };
const SNAP_MAX_FILES = 20000, SNAP_TEXT_MAX = 200 * 1024, SNAP_TEXT_TOTAL = 20 * 1024 * 1024;
const MAX_UPLOAD = 25 * 1024 * 1024, MAX_UPLOAD_FILES = 30, MAX_UPLOAD_TOTAL = 100 * 1024 * 1024;

function snapshot(root) {
  const files = new Map(); let textBytes = 0, partial = false;
  const walk = (dir, depth) => {
    if (depth > 12 || partial) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (files.size >= SNAP_MAX_FILES) { partial = true; return; }
      if (SKIP_DIRS.has(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f, depth + 1);
      else if (e.isFile()) {
        let st; try { st = fs.statSync(f); } catch { continue; }
        const rec = { mtime: st.mtimeMs, size: st.size };
        if (st.size <= SNAP_TEXT_MAX && textBytes + st.size <= SNAP_TEXT_TOTAL && isTextFile(f)) {
          try { rec.text = fs.readFileSync(f, 'utf8'); textBytes += st.size; } catch {}
        }
        files.set(f, rec);
      }
    }
  };
  walk(root, 0);
  return { files, partial };
}

// 行级 diff（去掉首尾相同部分后做 LCS），输出带 3 行上下文的统一格式
function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length; while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const a2 = A.slice(s, ea), b2 = B.slice(s, eb), n = a2.length, m = b2.length;
  let ops = [];
  if (n * m > 4e6) return { text: null, add: m, del: n };
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) { if (a2[i] === b2[j]) { ops.push([' ', a2[i], s + i, s + j]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['-', a2[i], s + i]); i++; } else { ops.push(['+', b2[j], null, s + j]); j++; } }
  while (i < n) { ops.push(['-', a2[i], s + i]); i++; }
  while (j < m) { ops.push(['+', b2[j], null, s + j]); j++; }
  // 加上前后各 3 行上下文
  const pre = A.slice(Math.max(0, s - 3), s).map((l, k) => [' ', l]);
  const post = A.slice(ea, ea + 3).map(l => [' ', l]);
  ops = [...pre, ...ops, ...post];
  // 中间连续超过 6 行的相同内容折叠
  const out = []; let run = [];
  const flushRun = last => {
    if (run.length > 6 && !last) { out.push(...run.slice(0, 3), ['@', `… 省略 ${run.length - 6} 行相同内容 …`], ...run.slice(-3)); }
    else out.push(...run);
    run = [];
  };
  for (const o of ops) { if (o[0] === ' ') run.push(o); else { flushRun(); out.push(o); } }
  flushRun(true);
  const add = ops.filter(o => o[0] === '+').length, del = ops.filter(o => o[0] === '-').length;
  let text = `@@ 第 ${Math.max(0, s - 3) + 1} 行起 @@\n` + out.map(o => o[0] === '@' ? '@@ ' + o[1] + ' @@' : o[0] + o[1]).join('\n');
  if (text.length > 60000) text = text.slice(0, 60000) + '\n…（对比过长，已截断）';
  return { text, add, del };
}

function diffSnapshots(before, after) {
  const changes = [];
  for (const [f, r] of after.files) {
    const old = before.files.get(f);
    if (!old) changes.push({ abs: f, change: 'add', rec: r });
    else if (old.mtime !== r.mtime || old.size !== r.size) {
      if (old.text != null && r.text != null && old.text === r.text) continue; // 只碰了时间戳
      changes.push({ abs: f, change: 'modify', rec: r, old });
    }
  }
  if (!before.partial && !after.partial) for (const f of before.files.keys()) if (!after.files.has(f)) changes.push({ abs: f, change: 'delete' });
  return changes;
}

async function uploadFile(taskId, abs) {
  const buf = fs.readFileSync(abs);
  const r = await fetch(cfg.relayUrl + '/api/agent/files', {
    method: 'POST', body: buf,
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/octet-stream', 'X-Task': taskId },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j.id;
}
async function downloadInput(f, dest) {
  const r = await fetch(cfg.relayUrl + '/api/agent/files/' + encodeURIComponent(f.id), { headers: { Authorization: 'Bearer ' + cfg.token } });
  if (!r.ok) throw new Error('附件下载失败：' + f.name);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
}

// 回答里用 Markdown 引用的本地文件：![](./chart.png) / [报告](/Users/x/out.pdf) / file:///...
function localLinks(text) {
  const out = new Set();
  const re = /!?\[[^\]\n]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g; let m;
  while ((m = re.exec(text))) {
    const raw = m[1];
    if (/^(https?:|data:|mailto:|#)/i.test(raw)) continue;
    out.add(raw);
  }
  return [...out];
}
function resolveLocal(raw, wsPath) {
  let p = raw;
  try { p = decodeURIComponent(p); } catch {}
  p = p.replace(/^file:\/\//i, '');
  if (IS_WIN && /^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  p = p.replace(/#.*$/, '').replace(/:\d+(:\d+)?$/, ''); // 去掉 #锚点 和 :行号
  p = expandHome(p);
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(wsPath, p);
}
const inside = (child, parent) => { const r = path.relative(parent, child); return r && !r.startsWith('..') && !path.isAbsolute(r); };
const extraOutputDirs = (cfg.extraOutputDirs || ['~/.codex/generated_images']).map(d => path.resolve(expandHome(d)));

const clis = {};
for (const [kind, c] of Object.entries(cfg.clis || { claude: {}, codex: {} })) {
  if (c.enabled === false) continue;
  if (kind === 'mock') {
    clis.mock = { ok: true, bin: process.execPath, prefixArgs: [path.join(__dirname, '..', 'scripts', 'mock-cli.js')], version: 'mock', auth: null };
    continue;
  }
  const bin = c.bin && c.bin !== 'auto' ? expandHome(c.bin) : findBin(kind);
  const version = bin ? versionOf(bin) : null;
  clis[kind] = { ok: !!(bin && version), bin, version, models: c.models || [], prefixArgs: [], auth: null };
}
// 登录状态：启动时查一次，之后每 5 分钟、以及任务失败后再查；变了就告诉中继（在 Mac 上登录后不用重启 agent）
const authLabel = c => c.auth?.loggedIn === false ? '未登录' : c.auth?.loggedIn ? '已登录' : '登录状态未知';
async function refreshAuth(log) {
  let changed = false;
  await Promise.all(Object.entries(clis).map(async ([kind, c]) => {
    if (!c.ok || !AUTH_ARGS[kind]) return;
    const a = await authOf(kind, c.bin, c.prefixArgs);
    if (a === null && c.auth) return; // 这次没查出来，保留上次的结果
    if (JSON.stringify(a) !== JSON.stringify(c.auth)) { c.auth = a; changed = true; if (log) console.log(`[agent]   ${kind}: ${authLabel(c)}`); }
  }));
  return changed;
}
let authTimer = null;
function scheduleAuthCheck(delay) {
  clearTimeout(authTimer);
  authTimer = setTimeout(async () => {
    try { if (await refreshAuth(true)) await api('POST', '/api/agent/clis', { agent: cfg.name, clis: publicClis() }); }
    catch (e) { /* 中继暂时连不上：下次 hello 会带上 */ }
    scheduleAuthCheck(5 * 60000);
  }, delay);
}
const publicClis = () => Object.fromEntries(Object.entries(clis).map(([k, c]) => [k, { ok: c.ok, version: c.version, models: c.models, loggedIn: c.auth ? c.auth.loggedIn : null }]));

// isolate: true → 每个对话在 <目录>/<用户名>/<对话id>/ 里运行，同一目录的多个任务可以同时跑、产出互不串
const workspaces = (cfg.workspaces || []).map(w => ({ name: w.name, path: path.resolve(expandHome(w.path)), maxLevel: w.maxLevel || 'full', note: w.note || '', isolate: !!w.isolate }));
for (const w of workspaces) if (!fs.existsSync(w.path)) { fs.mkdirSync(w.path, { recursive: true }); console.log(`[agent] 已创建工作目录 ${w.path}`); }
if (!workspaces.length) { console.error('[agent] 至少配置一个 workspaces'); process.exit(1); }

console.log(`[agent] ${cfg.name} → ${cfg.relayUrl}`);
for (const [k, c] of Object.entries(clis)) console.log(`[agent]   ${k}: ${c.ok ? '✓ ' + c.version : '✗ 未找到或无法运行'}  ${c.bin || ''}`);
const authReady = refreshAuth(false).then(() => {
  for (const [k, c] of Object.entries(clis)) if (c.ok && AUTH_ARGS[k]) console.log(`[agent]   ${k}: ${authLabel(c)}${c.auth?.loggedIn === false ? `（在这台电脑的终端里运行 ${k === 'codex' ? 'codex login' : 'claude 按提示登录'}）` : ''}`);
  scheduleAuthCheck(5 * 60000);
});

// ---------------------------------------------------------------- 与中继通信
async function api(method, p, body, signal) {
  const r = await fetch(cfg.relayUrl + p, {
    method, signal,
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.status = r.status; throw e; }
  return j;
}

const running = new Map(); // taskId -> job
const recentlyFinished = new Set(); // 刚结束的任务，结果可能还在上报途中
const pending = new Map(); // taskId -> { events:[], status, sessionId, usage, final }
let flushTimer = null;
function queueUpdate(taskId, patch) {
  const u = pending.get(taskId) || { taskId, events: [] };
  if (patch.events) u.events.push(...patch.events);
  for (const k of ['status', 'sessionId', 'usage', 'final', 'outputs', 'linkMap']) if (patch[k] !== undefined) u[k] = patch[k];
  pending.set(taskId, u);
  if (!flushTimer) flushTimer = setTimeout(flush, patch.final ? 0 : 150);
}
async function flush() {
  flushTimer = null;
  if (!pending.size) return;
  const updates = [...pending.values()]; pending.clear();
  for (let i = 0; i < 5; i++) {
    try { await api('POST', '/api/agent/events', { agent: cfg.name, updates }); return; }
    catch (e) { await sleep(1000 * (i + 1)); }
  }
  console.error('[agent] 上报失败，丢弃', updates.length, '条更新');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hello() {
  await api('POST', '/api/agent/hello', {
    name: cfg.name, platform: process.platform, hostname: os.hostname(), version: VERSION,
    maxConcurrent: cfg.maxConcurrent, running: [...running.keys()], confine: CONFINE,
    clis: publicClis(),
    workspaces: workspaces.map(({ name, maxLevel, note, isolate }) => ({ name, maxLevel, note, isolate })),
  });
}

let pollAbort = null;
async function loop() {
  await authReady;
  let backoff = 1000, greeted = false;
  for (;;) {
    try {
      if (!greeted) { await hello(); greeted = true; backoff = 1000; console.log('[agent] 已连上中继'); }
      pollAbort = new AbortController();
      const free = cfg.maxConcurrent - running.size;
      const r = await api('GET', `/api/agent/poll?name=${encodeURIComponent(cfg.name)}&free=${free}`, null, pollAbort.signal);
      for (const id of r.cancel || []) {
        const job = running.get(id);
        if (job) job.cancel();
        // 本机没在跑这个任务（例如 agent 重启过）：直接回报已取消，免得中继一直等
        else if (!recentlyFinished.has(id)) queueUpdate(id, { final: { status: 'cancelled', error: '已停止（执行端上没有在运行）' } });
      }
      for (const t of r.tasks || []) startTask(t);
      for (const pr of r.probes || []) runProbe(pr); // 网页要的即时查询（目前只有额度）
    } catch (e) {
      if (e.name === 'AbortError') continue; // 有空位了，立刻重新领任务
      if (e.status === 409 || e.status === 401) greeted = false;
      if (e.status === 401) console.error('[agent] token 被拒绝，检查配置');
      else console.error('[agent] 连接中继失败：', e.message);
      await sleep(backoff); backoff = Math.min(backoff * 2, 30000); greeted = false;
    }
  }
}

// ---------------------------------------------------------------- 订阅额度（5 小时 / 每周 / 恢复时间）
// 两个来源，统一成 { windows: [{ key, label, percent, resetsAt(毫秒时间戳), resetsText, status }], source }：
//   1. 任务运行时 Claude Code 输出的 rate_limit_event（数字准确、恢复时间是时间戳）
//   2. 网页点「额度」时，运行一次 `claude -p /usage`（不调用模型、不花额度），解析它的文字输出
const WINDOW_LABEL = { five_hour: '5 小时额度', seven_day: '本周（所有模型）' };
const windowLabel = key => WINDOW_LABEL[key] || (key.startsWith('seven_day_') ? `本周（${key.slice(10).replace(/^\w/, c => c.toUpperCase())}）` : key);
function quotaFromRateLimit(info) {
  const w = info?.unifiedWindows; if (!w) return null;
  const windows = Object.entries(w).map(([key, v]) => ({
    key, label: windowLabel(key), percent: Math.round((Number(v.utilization) || 0) * 100),
    resetsAt: v.resetsAt ? v.resetsAt * 1000 : null, status: v.status || null,
  })).sort((a, b) => (a.key === 'five_hour' ? -1 : b.key === 'five_hour' ? 1 : a.key.localeCompare(b.key)));
  return windows.length ? { windows, source: 'task' } : null;
}
// 某个时区里的「墙上时间」→ 时间戳（/usage 输出的是 "Nov 26 at 11:09pm (Asia/Tokyo)" 这种）
function zonedToEpoch(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo, d, h, mi);
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
      .formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const asTz = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
    return guess - (asTz - guess); // 减去该时区相对 UTC 的偏移
  } catch { return null; }
}
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseResets(text) {
  // 例：Nov 26 at 11:09pm (Asia/Tokyo)；也兼容只有时间的写法：11:09pm (Asia/Tokyo)
  const m = String(text || '').match(/(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i);
  if (!m) return null;
  const now = new Date(), tz = m[6] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let h = +m[3] % 12; if (m[5].toLowerCase() === 'pm') h += 12;
  const mo = m[1] ? MONTHS[m[1].toLowerCase()] : now.getMonth(), d = m[2] ? +m[2] : now.getDate();
  if (mo == null) return null;
  let t = zonedToEpoch(now.getFullYear(), mo, d, h, +(m[4] || 0), tz);
  if (t && t < Date.now() - 86400000) t = zonedToEpoch(now.getFullYear() + 1, mo, d, h, +(m[4] || 0), tz); // 跨年
  if (t && !m[1] && t < Date.now()) t += 86400000; // 只有时间：已经过了就是明天
  return t;
}
function quotaFromUsageText(text) {
  const windows = [];
  for (const line of String(text).split('\n')) {
    const s = line.trim();
    let m = s.match(/^Current session:\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+))?$/i);
    if (m) { windows.push({ key: 'five_hour', label: windowLabel('five_hour'), percent: +m[1], resetsText: m[2] || '', resetsAt: parseResets(m[2]) }); continue; }
    m = s.match(/^Current week\s*\(([^)]+)\):\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+))?$/i);
    if (m) {
      const key = /all/i.test(m[1]) ? 'seven_day' : 'seven_day_' + m[1].toLowerCase().replace(/[^a-z0-9]+/g, '_');
      windows.push({ key, label: windowLabel(key), percent: +m[2], resetsText: m[3] || '', resetsAt: parseResets(m[3]) });
    }
  }
  return windows.length ? { windows, source: 'usage' } : null;
}
let lastQuotaReport = 0;
function reportQuota(q, probeId, error) {
  if (!probeId && Date.now() - lastQuotaReport < 20000) return; // 任务里的额度事件很频繁，20 秒最多报一次
  lastQuotaReport = Date.now();
  api('POST', '/api/agent/quota', { agent: cfg.name, probeId, quota: q || null, error: error || null }).catch(e => console.error('[agent] 上报额度失败', e.message));
}
// ---------------------------------------------------------------- 文件浏览（网页上浏览 / 下载 Mac 上的文件）
// 范围和文件夹限制一样：普通用户只能看 <目录>/<用户名>/，管理员（pr.user 为空）看整个目录。
// 路径一律先解析成真实路径再检查是否还在范围内：.. 、隐藏文件（. 开头）、指到外面的快捷方式都不行。
function probeReply(id, result, error) {
  api('POST', '/api/agent/probe', { agent: cfg.name, probeId: id, result: result ?? null, error: error || null }).catch(e => console.error('[agent] 回报查询结果失败', e.message));
}
function fsResolve(pr) {
  const ws = workspaces.find(w => w.name === pr.workspace); if (!ws) throw new Error('目录不存在');
  if (pr.user && !ws.isolate) throw new Error('这个目录不是每人独立的，不能浏览');
  const root = pr.user ? path.join(ws.path, safeSeg(pr.user)) : ws.path;
  const parts = String(pr.path || '').split(/[\\/]+/).filter(Boolean);
  if (parts.some(x => x === '..' || x.startsWith('.'))) throw new Error('路径不合法');
  if (!fs.existsSync(root)) return { root, abs: null, parts }; // 还没用过：文件夹还没建
  const realRoot = fs.realpathSync(root);
  const abs = path.join(realRoot, ...parts);
  if (!fs.existsSync(abs)) throw new Error('文件或文件夹不存在');
  const real = fs.realpathSync(abs);
  if (real !== realRoot && !inside(real, realRoot)) throw new Error('路径不合法');
  return { root: realRoot, abs: real, parts };
}
function fsList(pr) {
  const { abs, parts } = fsResolve(pr);
  if (!abs) return { path: '', entries: [] };
  if (!fs.statSync(abs).isDirectory()) throw new Error('不是文件夹');
  const entries = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue; // 隐藏文件、快捷方式不显示
    if (!e.isDirectory() && !e.isFile()) continue;
    try { const st = fs.statSync(path.join(abs, e.name)); entries.push({ name: e.name, dir: e.isDirectory(), size: e.isFile() ? st.size : null, mtime: st.mtimeMs }); } catch {}
    if (entries.length >= 1000) break;
  }
  entries.sort((x, y) => (y.dir - x.dir) || y.mtime - x.mtime); // 文件夹在前，新的在前
  return { path: parts.join('/'), entries };
}
async function fsGet(pr) {
  const { abs } = fsResolve(pr);
  if (!abs || !fs.statSync(abs).isFile()) throw new Error('不是文件');
  const size = fs.statSync(abs).size;
  if (size > MAX_UPLOAD) throw new Error(`文件太大（${(size / 1048576).toFixed(1)}MB），网页上只能下载 25MB 以内的文件`);
  const r = await fetch(cfg.relayUrl + '/api/agent/probe-file', {
    method: 'POST', body: fs.readFileSync(abs),
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/octet-stream', 'X-Probe': pr.id, 'X-Name': encodeURIComponent(path.basename(abs)), 'X-Mime': mimeOf(abs) },
  });
  if (!r.ok) throw new Error('上传失败：' + r.status);
}
function runProbe(pr) {
  if (pr.kind === 'ls') { try { probeReply(pr.id, fsList(pr)); } catch (e) { probeReply(pr.id, null, e.message); } return; }
  if (pr.kind === 'get') { fsGet(pr).catch(e => probeReply(pr.id, null, e.message)); return; }
  // 网页发消息时发现 CLI 未登录：马上复查一次（可能刚在 Mac 上登录好）
  if (pr.kind === 'auth') { refreshAuth(true).then(() => probeReply(pr.id, { clis: publicClis() }), e => probeReply(pr.id, null, e.message)); return; }
  if (pr.kind !== 'usage') return reportQuota(null, pr.id, '不支持的查询');
  const c = clis.claude;
  if (!c?.ok) return reportQuota(null, pr.id, '这台设备没有可用的 Claude Code');
  // 固定命令、不带用户输入、不调用模型；要读本机所有会话的统计，所以不进文件夹沙盒
  const child = spawn(c.bin, [...c.prefixArgs, '-p', '--output-format', 'json'], { cwd: os.tmpdir(), env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '', done = false;
  const end = (q, err) => { if (done) return; done = true; clearTimeout(timer); reportQuota(q, pr.id, err); };
  const timer = setTimeout(() => { child.kill(); end(null, '查询超时'); }, 40000);
  child.stdout.setEncoding('utf8'); child.stdout.on('data', d => (out += d));
  child.on('error', e => end(null, '启动失败：' + e.message));
  child.on('close', () => {
    let text = out; try { text = JSON.parse(out).result || out; } catch {}
    const q = quotaFromUsageText(text);
    // 用 API Key 登录（按用量计费）时 /usage 只有费用，没有 5 小时 / 本周额度
    const api = !q && /Estimated cost|Total cost/i.test(text);
    end(q, q ? null : api ? '这台电脑上的 Claude Code 按 API 计费，没有 5 小时 / 本周额度' : '没能从 /usage 的输出里读出额度：' + short(text, 200));
  });
  child.stdin.on('error', () => {}); child.stdin.end('/usage');
}

// ---------------------------------------------------------------- 构造命令行
// 权限三档 read / edit / full 映射到各家 CLI 的参数
function buildCommand(t) {
  const c = clis[t.cli];
  if (!c || !c.ok) throw new Error(`本机 ${t.cli} 不可用`);
  const args = [...c.prefixArgs];
  if (t.cli === 'claude') {
    const mode = { read: 'default', edit: 'acceptEdits', full: 'bypassPermissions' }[t.level] || 'default';
    args.push('-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', mode);
    if (t.model) args.push('--model', t.model);
    if (t.resumeSessionId) args.push('--resume', t.resumeSessionId);
    // prompt 走 stdin，避免命令行转义和长度问题
  } else if (t.cli === 'codex') {
    const sandbox = { read: 'read-only', edit: 'workspace-write', full: null }[t.level];
    args.push('exec');
    if (t.resumeSessionId) args.push('resume');
    for (const img of t.imagePaths || []) args.push('-i', img); // 图片附件直接给模型看
    args.push('--json', '--skip-git-repo-check');
    if (sandbox) args.push('-c', `sandbox_mode="${sandbox}"`, '-c', 'approval_policy="never"');
    else args.push('--dangerously-bypass-approvals-and-sandbox');
    if (t.model) args.push('-m', t.model);
    if (t.resumeSessionId) args.push(t.resumeSessionId);
    args.push('-'); // 从 stdin 读 prompt
  } else if (t.cli === 'mock') {
    if (t.resumeSessionId) args.push('--resume', t.resumeSessionId);
  } else throw new Error('未知 CLI ' + t.cli);
  return { bin: c.bin, args };
}

// ---------------------------------------------------------------- 解析输出 → 统一事件
// 统一事件：{k:'text',d} 正文增量 / {k:'tool',name,d} 工具调用 / {k:'tool_out',d} 工具结果 / {k:'info',d} / {k:'err',d}
function short(s, n = 400) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + '…' : s; }
function toolDetail(name, input) {
  if (!input) return '';
  return input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description || short(JSON.stringify(input), 200);
}
function makeParser(kind, emit) {
  const st = { textFromDelta: false, result: '', sessionId: null, isError: false, errorMsg: null };
  if (kind === 'claude') {
    return {
      st,
      line(o) {
        if (o.type === 'system' && o.subtype === 'init') { st.sessionId = o.session_id; st.model = o.model || null; emit({ sessionId: o.session_id }); emit({ events: [{ k: 'info', dev: true, d: `模型 ${o.model || ''} · 目录 ${o.cwd}` }] }); }
        else if (o.type === 'stream_event') {
          const ev = o.event;
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') { st.textFromDelta = true; emit({ events: [{ k: 'text', d: ev.delta.text }] }); }
          if (ev?.type === 'message_start') st.textFromDelta = false;
        } else if (o.type === 'assistant') {
          for (const b of o.message?.content || []) {
            if (b.type === 'text' && !st.textFromDelta && b.text) emit({ events: [{ k: 'text', d: b.text }] });
            if (b.type === 'tool_use') emit({ events: [{ k: 'tool', name: b.name, d: short(toolDetail(b.name, b.input), 300) }] });
          }
          // 分隔多轮文本
          if (st.textFromDelta) emit({ events: [{ k: 'text', d: '\n\n' }] });
          st.textFromDelta = false;
        } else if (o.type === 'user') {
          for (const b of o.message?.content || []) {
            if (b.type === 'tool_result') {
              const txt = Array.isArray(b.content) ? b.content.map(x => x.text || '').join('') : b.content;
              emit({ events: [{ k: 'tool_out', d: short(txt, 600), err: !!b.is_error }] });
            }
          }
        } else if (o.type === 'rate_limit_event') {
          const q = quotaFromRateLimit(o.rate_limit_info); // 顺便记下订阅额度，网页「额度」面板用
          if (q) reportQuota(q);
        } else if (o.type === 'result') {
          st.result = o.result || '';
          st.isError = !!o.is_error;
          if (o.is_error) st.errorMsg = o.result || o.subtype;
          if (o.permission_denials?.length) emit({ events: [{ k: 'info', d: `有 ${o.permission_denials.length} 个操作因权限级别被拒绝（${[...new Set(o.permission_denials.map(x => x.tool_name))].join(', ')}）` }] });
          { const u = o.usage || {}; const cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0;
            emit({ usage: { cost: o.total_cost_usd, turns: o.num_turns, ms: o.duration_ms, in: u.input_tokens, out: u.output_tokens, cacheRead, cacheWrite,
              total: (u.input_tokens || 0) + cacheRead + cacheWrite + (u.output_tokens || 0), model: st.model } }); }
        }
      },
    };
  }
  if (kind === 'codex' || kind === 'mock') {
    return {
      st,
      line(o) {
        if (o.type === 'thread.started') { st.sessionId = o.thread_id; emit({ sessionId: o.thread_id }); }
        else if (o.type === 'item.started' && o.item?.type === 'command_execution') emit({ events: [{ k: 'tool', name: 'shell', d: short(o.item.command, 300) }] });
        else if (o.type === 'item.completed') {
          const it = o.item || {};
          if (it.type === 'agent_message') { st.result = it.text || ''; emit({ events: [{ k: 'text', d: (it.text || '') + '\n\n' }] }); }
          else if (it.type === 'reasoning') emit({ events: [{ k: 'think', d: short(it.text, 1000) }] });
          else if (it.type === 'command_execution') emit({ events: [{ k: 'tool_out', d: short(it.aggregated_output, 600), err: it.exit_code !== 0 && it.exit_code != null }] });
          else if (it.type === 'file_change') emit({ events: [{ k: 'tool', name: 'edit', d: (it.changes || []).map(c => `${c.kind} ${c.path}`).join('\n') }] });
          else if (it.type === 'mcp_tool_call') emit({ events: [{ k: 'tool', name: `${it.server}.${it.tool}`, d: '' }] });
          else if (it.type === 'web_search') emit({ events: [{ k: 'tool', name: 'web_search', d: it.query || '' }] });
          else if (it.type === 'error') emit({ events: [{ k: 'err', d: it.message }] });
        } else if (o.type === 'turn.completed') {
          emit({ usage: { in: o.usage?.input_tokens, out: o.usage?.output_tokens, cached: o.usage?.cached_input_tokens, total: (o.usage?.input_tokens || 0) + (o.usage?.output_tokens || 0) } }); // Codex 的 input_tokens 已经包含缓存部分
        } else if (o.type === 'turn.failed') { st.isError = true; st.errorMsg = o.error?.message || '执行失败'; }
        else if (o.type === 'error') { st.isError = true; st.errorMsg = o.message; }
      },
    };
  }
}

// ---------------------------------------------------------------- 执行任务
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) { try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} } setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000); }
}

// 准备附件：下载到 <工作目录>/.ai-bridge/uploads/<任务id>/，把路径告诉 CLI
async function prepareInputs(t, ws, emit) {
  if (!t.inputs?.length) return t.prompt;
  const dir = path.join(ws.path, '.ai-bridge', 'uploads', t.id);
  fs.mkdirSync(dir, { recursive: true });
  const rels = []; t.imagePaths = [];
  for (const f of t.inputs) {
    let name = path.basename(f.name).replace(/[\\/:*?"<>|]/g, '_') || 'file';
    while (fs.existsSync(path.join(dir, name))) name = '_' + name;
    const abs = path.join(dir, name);
    await downloadInput(f, abs);
    rels.push(path.relative(ws.path, abs).split(path.sep).join('/'));
    if (/^image\/(png|jpe?g|gif|webp)$/.test(f.mime || mimeOf(abs))) t.imagePaths.push(abs);
  }
  emit({ events: [{ k: 'info', d: `已接收 ${rels.length} 个附件` }] });
  return `${t.prompt || '请查看附件。'}\n\n[用户附件] 已保存在当前工作目录下：\n${rels.map(r => '- ' + r).join('\n')}`;
}

// 任务结束后：找出新增/修改/删除的文件 + 回答里引用的本地文件，上传给中继
async function collectOutputs(t, ws, before, answerText) {
  const outputs = [], linkMap = {}, byAbs = new Map();
  let uploadedCount = 0, uploadedBytes = 0;
  const tryUpload = async (abs, size) => {
    if (size > MAX_UPLOAD) return { note: '文件超过 25MB，未上传' };
    if (uploadedCount >= MAX_UPLOAD_FILES || uploadedBytes + size > MAX_UPLOAD_TOTAL) return { note: '本次产出文件太多，未上传' };
    try { const id = await uploadFile(t.id, abs); uploadedCount++; uploadedBytes += size; return { id }; }
    catch (e) { return { note: '上传失败：' + e.message }; }
  };
  const after = snapshot(ws.path);
  const changes = diffSnapshots(before, after);
  // 图片和网页优先，其次按大小
  const rank = c => (/^image\//.test(mimeOf(c.abs)) ? 0 : /html|pdf/.test(mimeOf(c.abs)) ? 1 : 2);
  changes.sort((a, b) => rank(a) - rank(b) || (a.rec?.size || 0) - (b.rec?.size || 0));
  for (const c of changes) {
    const rel = path.relative(ws.path, c.abs).split(path.sep).join('/');
    const meta = { path: rel, name: path.basename(c.abs), mime: mimeOf(c.abs), size: c.rec?.size || 0, change: c.change };
    if (c.change === 'modify' && c.old?.text != null && c.rec.text != null) {
      const d = lineDiff(c.old.text, c.rec.text);
      meta.diff = d.text || undefined; meta.diffStat = { add: d.add, del: d.del };
      if (!d.text) meta.note = '改动太大，不显示对比';
    } else if (c.change === 'add' && c.rec?.text != null) {
      meta.diffStat = { add: c.rec.text.split('\n').length, del: 0 };
    }
    if (c.change !== 'delete') Object.assign(meta, await tryUpload(c.abs, meta.size));
    outputs.push(meta); byAbs.set(c.abs, meta);
  }
  // 回答里引用的本地文件（可能没改动，或在允许的额外目录里，例如 Codex 生成的图片）
  for (const raw of localLinks(answerText)) {
    const abs = resolveLocal(raw, ws.path);
    if (!(inside(abs, ws.path) || extraOutputDirs.some(d => inside(abs, d)))) continue;
    let meta = byAbs.get(abs);
    if (!meta) {
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (!st.isFile()) continue;
      const rel = inside(abs, ws.path) ? path.relative(ws.path, abs).split(path.sep).join('/') : path.basename(abs);
      meta = { path: rel, name: path.basename(abs), mime: mimeOf(abs), size: st.size, change: 'ref', note: '回答中引用，本次未改动', ...(await tryUpload(abs, st.size)) };
      outputs.push(meta); byAbs.set(abs, meta);
    }
    if (meta.id) linkMap[raw] = meta.id;
  }
  return { outputs, linkMap, partial: after.partial };
}

// ---------------------------------------------------------------- 文件夹限制（macOS 沙盒）
// 所有级别（包括「完全放开」）的 CLI 都用 sandbox-exec 启动，由系统内核拒绝它读写允许范围以外的文件
// （Claude Code 自己的权限设置拦不住读取：Read 工具能读本机任何文件）。
// 允许范围：isolate 目录是 <目录>/<用户名>/（这个用户的所有对话），否则是目录本身。
const CONFINE = process.platform === 'darwin' && cfg.confine !== false && fs.existsSync('/usr/bin/sandbox-exec');
const CONFINE_CLIS = new Set(['claude', 'mock']); // Codex 自带沙盒，嵌套沙盒会失败：开启限制时改用它自带的沙盒（见 startTask）
console.log(CONFINE ? '[agent] 文件夹限制：开（所有任务只能访问自己的文件夹）' : '[agent] 文件夹限制：关（任务能访问本机其他文件）');
// 沙盒里的进程能借这些途径让「沙盒外」的程序替它干活，一律禁止：
// open（LaunchServices 启动 App）、osascript/AppleEvents（遥控其他 App）、launchctl/crontab/at（提交后台任务）、
// shortcuts/automator（快捷指令、自动操作）、defaults/写偏好设置（例如改终端的启动命令）
const SANDBOX_DENY_EXEC = ['/usr/bin/open', '/usr/bin/osascript', '/usr/bin/osacompile', '/bin/launchctl', '/usr/bin/crontab',
  '/usr/bin/at', '/usr/bin/batch', '/usr/bin/shortcuts', '/usr/bin/automator', '/usr/bin/defaults'];
const HOME = os.homedir();
const sbq = s => JSON.stringify(String(s)); // SBPL 字符串字面量
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function confineReadPaths(kind) {
  const c = clis[kind]; const out = [...(cfg.confineExtraRead || []).map(p => path.resolve(expandHome(p)))];
  if (!c?.bin) return out;
  out.push(c.bin);
  try { const real = fs.realpathSync(c.bin); out.push(real, path.dirname(real)); } catch {}
  for (const a of c.prefixArgs || []) if (fs.existsSync(a)) {
    out.push(a); // 模拟 CLI 的脚本；Node 启动脚本时会逐级找 package.json 判断模块类型
    for (let p = path.dirname(a); p !== path.dirname(p); p = path.dirname(p)) out.push(path.join(p, 'package.json'));
  }
  if (kind === 'claude') out.push(path.join(HOME, '.local', 'share', 'claude'));
  return out;
}
function sandboxProfile(root, wd, kind) {
  const readPaths = confineReadPaths(kind);
  // 放开的路径的每一级上级目录都要允许「看属性」（不能列内容）：程序解析路径时会逐级 lstat
  const ancestors = new Set();
  for (const p0 of [root, ...readPaths]) for (let p = path.dirname(p0); p !== path.dirname(p); p = path.dirname(p)) ancestors.add(p);
  // Claude Code 的会话记录按目录存在 ~/.claude/projects/<路径里非字母数字换成 -> 下，只放开这个对话自己的
  const proj = path.join(HOME, '.claude', 'projects', wd.replace(/[^a-zA-Z0-9]/g, '-'));
  const sub = list => list.map(p => `(subpath ${sbq(p)})`).join(' ');
  const lit = list => list.map(p => `(literal ${sbq(p)})`).join(' ');
  return `(version 1)
(allow default)
(deny file-read* file-write* ${sub([HOME, ...workspaces.map(w => w.path), path.resolve(__dirname, '..')])})
(allow file-read-metadata ${lit([...ancestors, HOME, path.join(HOME, '.claude'), path.join(HOME, '.claude', 'projects'), path.join(HOME, '.local'), path.join(HOME, '.local', 'bin')])})
(allow file-read* file-write* ${sub([root, proj, path.join(HOME, '.cache', 'claude'), path.join(HOME, '.local', 'state', 'claude'), path.join(HOME, 'Library', 'Caches', 'claude-cli-nodejs')])}
  (regex ${sbq('^' + reEsc(path.join(HOME, '.claude.json')))}))
(allow file-read* ${sub([path.join(HOME, 'Library', 'Keychains')])} ${lit([path.join(HOME, '.claude', 'settings.json')])}
  ${readPaths.map(p => fs.existsSync(p) && fs.statSync(p).isDirectory() ? `(subpath ${sbq(p)})` : `(literal ${sbq(p)})`).join(' ')})
(deny process-exec ${lit(SANDBOX_DENY_EXEC)})
(deny appleevent-send)
(deny user-preference-write)
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd") (global-name-prefix "com.apple.lsd."))
`;
}

// 任务实际运行的目录：普通目录就是它本身；isolate 目录是 <目录>/<用户名>/<对话id>
const safeSeg = s => String(s || '').replace(/[^\wÀ-￿.-]/g, '_').replace(/^\.+/, '_').slice(0, 60) || '_';
function taskDir(ws, t) {
  if (!ws.isolate) return ws.path;
  if (!t.convId) throw new Error('中继版本太旧，缺少对话 id，无法使用独立子文件夹');
  const d = path.join(ws.path, safeSeg(t.username), safeSeg(t.convId));
  if (!inside(d, ws.path)) throw new Error('子文件夹路径不合法');
  return d;
}

async function startTask(t) {
  const emit = patch => queueUpdate(t.id, patch);
  const ws = workspaces.find(w => w.name === t.workspace);
  let ended = false;
  const finish = final => {
    if (ended) return; ended = true; running.delete(t.id);
    recentlyFinished.add(t.id); setTimeout(() => recentlyFinished.delete(t.id), 120000);
    queueUpdate(t.id, { final }); pollAbort?.abort();
  };
  let cancelled = false, timedOut = false, child = null;
  const job = {
    cancel() {
      // 幂等：只提示一次；重复收到只是再补一刀
      if (!cancelled) { cancelled = true; console.log(`[agent] ✕ ${new Date().toISOString().slice(11, 23)} 收到停止 ${t.id}`); emit({ events: [{ k: 'info', d: '正在停止…' }] }); }
      if (child) killTree(child);
    },
  };
  running.set(t.id, job); // 先占位，保证并发计数准确
  emit({ status: 'running' });

  let cmd, prompt, before, ews; // ews：这次任务实际使用的目录（isolate 时是对话的子文件夹）
  try {
    if (!ws) throw new Error('工作目录不存在：' + t.workspace);
    const lv = ['read', 'edit', 'full'];
    if (lv.indexOf(t.level) > lv.indexOf(ws.maxLevel)) throw new Error('该目录不允许此权限级别');
    ews = { ...ws, path: taskDir(ws, t) };
    if (!fs.existsSync(ews.path)) {
      fs.mkdirSync(ews.path, { recursive: true });
      // Claude Code 的会话按目录保存：目录刚改成独立子文件夹时，旧会话在新目录里续接不上，只能重新开始
      if (ws.isolate && t.resumeSessionId) { t.resumeSessionId = null; emit({ events: [{ k: 'info', d: '这个目录改成了每个对话独立文件夹，之前的上下文接不上，这条消息开始新会话' }] }); }
    }
    prompt = await prepareInputs(t, ews, emit);
    // Codex 不能套我们的沙盒：开启限制时把「完全放开」降成它自带的 workspace-write 沙盒（只能改对话文件夹）
    if (CONFINE && t.cli === 'codex' && t.level === 'full') {
      t.level = 'edit';
      emit({ events: [{ k: 'info', d: 'Codex 改用它自带的沙盒：只能修改这个对话文件夹里的文件' }] });
    }
    cmd = buildCommand(t);
    if (CONFINE && CONFINE_CLIS.has(t.cli)) {
      const root = ws.isolate ? path.dirname(ews.path) : ws.path;
      cmd = { bin: '/usr/bin/sandbox-exec', args: ['-p', sandboxProfile(root, ews.path, t.cli), cmd.bin, ...cmd.args] };
      // dev: true 的提示只在「任务」详情里显示，聊天里不显示
      emit({ events: [{ k: 'info', dev: true, d: `文件访问限制在：${ws.name}${root === ws.path ? '' : '/' + path.relative(ws.path, root)}/` }] });
    }
    before = snapshot(ews.path);
  } catch (e) { return finish({ status: 'failed', error: e.message }); }
  if (cancelled) return finish({ status: 'cancelled', error: '已手动停止' });

  console.log(`[agent] ▶ ${t.id} ${t.cli}/${t.level} @${ws.name}${ws.isolate ? '/' + path.relative(ws.path, ews.path) : ''}${t.resumeSessionId ? ' (续接)' : ''}${t.inputs?.length ? ` +${t.inputs.length}附件` : ''}`);
  child = spawn(cmd.bin, cmd.args, { cwd: ews.path, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN, windowsHide: true });
  let answerText = '';
  const parser = makeParser(t.cli, patch => {
    for (const e of patch.events || []) if (e.k === 'text') answerText += e.d;
    emit(patch);
  });
  let stderr = '', buf = '';
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, cfg.taskTimeoutMin * 60000);

  child.stdin.on('error', () => {});
  child.stdin.end(prompt);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { emit({ events: [{ k: 'text', d: line + '\n' }] }); continue; }
      try { parser.line(o); } catch (e) { console.error('[agent] 解析出错', e); }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  child.on('error', e => { clearTimeout(timer); finish({ status: 'failed', error: '启动失败：' + e.message }); });
  let doneStarted = false;
  // 兜底：进程已退出，但残留子进程占着输出管道导致 close 迟迟不来
  child.on('exit', code => setTimeout(() => onDone(code), cancelled ? 800 : 5000));
  child.on('close', code => onDone(code));
  const onDone = async code => {
    clearTimeout(timer);
    if (ended || doneStarted) return;
    doneStarted = true;
    const st = parser.st;
    let status = 'done', error = null;
    if (cancelled) { status = 'cancelled'; error = '已手动停止'; }
    else if (timedOut) { status = 'failed'; error = `超过 ${cfg.taskTimeoutMin} 分钟，已终止`; }
    else if (st.isError || code !== 0) {
      status = 'failed';
      const tail = stderr.split('\n').filter(l => l.trim() && !/Reading (additional )?(input|prompt) from stdin/i.test(l)).slice(-6).join('\n');
      error = st.errorMsg || tail || `退出码 ${code}`;
    }
    try {
      const { outputs, linkMap, partial } = await collectOutputs(t, ews, before, answerText || st.result || '');
      if (outputs.length) emit({ outputs, linkMap });
      if (partial) emit({ events: [{ k: 'info', d: '工作目录文件太多，只检查了前 20000 个文件的变化' }] });
      if (outputs.length) console.log(`[agent]   产出 ${outputs.length} 个文件`);
    } catch (e) { console.error('[agent] 收集产出失败', e); }
    console.log(`[agent] ■ ${new Date().toISOString().slice(11, 23)} ${t.id} ${status}${error ? ' - ' + short(error, 120) : ''}`);
    finish({ status, result: st.result, error, exitCode: code });
    if (status === 'failed' && AUTH_ARGS[t.cli]) scheduleAuthCheck(2000); // 可能是登录过期了，马上复查
  };
}

process.on('SIGINT', () => { for (const j of running.values()) j.cancel(); setTimeout(() => process.exit(0), 800); });
process.on('SIGTERM', () => { for (const j of running.values()) j.cancel(); setTimeout(() => process.exit(0), 800); });
loop();
