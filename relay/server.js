// 中继服务器（Relay）：网页平台 + 任务队列 + 实时状态同步
// 零依赖，Node 18+。职责相当于架构图里的「网页平台 + Firebase/Supabase」两层。
// Mac 上的 agent 主动连进来领任务（长轮询），所以 Mac 不需要公网 IP、不需要开端口。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exportConvs } = require('./export');

const ROOT = path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = process.env.RELAY_DATA || path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || process.argv[2] || 5227);
const HOST = process.env.HOST || '127.0.0.1';

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------- 存储
const files = {
  config: path.join(DATA_DIR, 'config.json'),
  users: path.join(DATA_DIR, 'users.json'),
  db: path.join(DATA_DIR, 'db.json'),
};
function readJSON(f, dflt) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; }
}
function writeJSONAtomic(f, obj) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, f);
}

const config = readJSON(files.config, {});
if (!config.agentToken) config.agentToken = crypto.randomBytes(24).toString('base64url');
if (!config.sessionDays) config.sessionDays = 14;
if (!config.taskOutputLimit) config.taskOutputLimit = 400000; // 单任务保存的输出事件字符上限
writeJSONAtomic(files.config, config);
// 部署到磁盘不持久的平台（例如 Render 免费版）时，用环境变量固定 agent token，重启后 Mac 不用重新配置
const ENV_AGENT_TOKEN = process.env.AGENT_TOKEN || '';
if (ENV_AGENT_TOKEN) {
  if (ENV_AGENT_TOKEN.length < 24) { console.error('[relay] 环境变量 AGENT_TOKEN 太短（至少 24 位）'); process.exit(1); }
  config.agentToken = ENV_AGENT_TOKEN; // 只放内存，不写进 config.json
}

let users = readJSON(files.users, []);
const db = readJSON(files.db, { convs: [], tasks: [] });
db.convs ||= []; db.tasks ||= []; db.uploads ||= [];

// ---------------------------------------------------------------- 文件（AI 产出 / 用户附件）
// 文件本体存 data/files/<id>，元数据挂在 task.outputs / task.inputs / db.uploads 上
const FILE_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILE_DIR, { recursive: true });
const MAX_FILE = 25 * 1024 * 1024;
const blobPath = id => path.join(FILE_DIR, id.replace(/[^\w-]/g, ''));
function findFile(id) {
  const up = db.uploads.find(f => f.id === id);
  if (up) return { meta: up, task: null };
  for (const t of db.tasks) {
    const f = (t.outputs || []).find(x => x.id === id) || (t.inputs || []).find(x => x.id === id);
    if (f) return { meta: f, task: t };
  }
  return null;
}
function removeBlobs(metas) { for (const f of metas || []) if (f.stored) fs.rm(blobPath(f.id), () => {}); }
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, '文件太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function sendFile(req, res, meta, download) {
  const f = blobPath(meta.id);
  fs.stat(f, (err, st) => {
    if (err) { res.writeHead(404); return res.end('file gone'); }
    const mime = meta.mime || 'application/octet-stream';
    const headers = {
      'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    };
    // HTML / SVG / XML 等可执行内容：放进沙盒（独立的不透明源），拿不到本站 cookie、调不了 API
    if (/html|svg|xml|javascript/i.test(mime)) headers['Content-Security-Policy'] = "sandbox allow-scripts allow-popups allow-modals";
    res.writeHead(200, headers);
    fs.createReadStream(f).pipe(res);
  });
}

let dbDirty = false, usersDirty = false;
function saveSoon() { dbDirty = true; }
setInterval(() => {
  if (dbDirty) { dbDirty = false; writeJSONAtomic(files.db, db); }
  if (usersDirty) { usersDirty = false; writeJSONAtomic(files.users, users); }
}, 1000);
function flushAll() {
  try { writeJSONAtomic(files.db, db); writeJSONAtomic(files.users, users); } catch {}
}
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });

// 重启后：还在跑的任务无法恢复，标记失败；排队的保留
for (const t of db.tasks) {
  if (t.status === 'running' || t.status === 'dispatched') {
    t.status = 'failed'; t.error = '中继重启，任务中断'; t.endedAt = Date.now();
  }
}

// ---------------------------------------------------------------- 用户与权限
const LEVELS = ['read', 'edit', 'full'];
const DEFAULT_PERMS = { clis: ['claude', 'codex'], maxLevel: 'edit', agents: ['*'], workspaces: ['*'], dailyLimit: 50 };

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return { salt, hash };
}
function checkPassword(user, pw) {
  const { hash } = hashPassword(pw, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
function newId(prefix) { return prefix + '_' + crypto.randomBytes(6).toString('hex'); }

if (!users.length) {
  // 没有任何账号时创建管理员；设了 ADMIN_PASSWORD 就用它（磁盘不持久的平台重启后仍是同一个密码）
  const envPw = process.env.ADMIN_PASSWORD || '';
  if (envPw && envPw.length < 8) { console.error('[relay] 环境变量 ADMIN_PASSWORD 太短（至少 8 位）'); process.exit(1); }
  const pw = envPw || crypto.randomBytes(6).toString('base64url');
  users.push({
    id: newId('u'), username: 'admin', role: 'admin', disabled: false, createdAt: Date.now(),
    perms: { clis: ['*'], maxLevel: 'full', agents: ['*'], workspaces: ['*'], dailyLimit: 0 },
    ...hashPassword(pw),
  });
  writeJSONAtomic(files.users, users);
  if (envPw) console.log('\n[relay] 已用环境变量 ADMIN_PASSWORD 创建管理员 admin\n');
  else {
    fs.writeFileSync(path.join(DATA_DIR, 'INITIAL_ADMIN.txt'), `用户名: admin\n初始密码: ${pw}\n登录后请到「用户权限」里改密码，然后删除本文件。\n`);
    console.log(`\n[relay] 已创建管理员 admin，初始密码：${pw}（也写在 data/INITIAL_ADMIN.txt）\n`);
  }
}

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, perms: u.perms, createdAt: u.createdAt, env: u.env || null };
}
const allow = (list, v) => !list || list.includes('*') || list.includes(v);
function levelAllowed(user, level) {
  return LEVELS.indexOf(level) >= 0 && LEVELS.indexOf(level) <= LEVELS.indexOf(user.perms.maxLevel || 'read');
}
function tasksToday(userId) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return db.tasks.filter(t => t.userId === userId && t.createdAt >= start.getTime()).length;
}

// ---------------------------------------------------------------- 会话 cookie
// 登录会话持久化到 data/sessions.json（只存 token 的哈希），中继重启不用重新登录
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');
const tokHash = t => crypto.createHash('sha256').update(t).digest('hex');
class SessionStore extends Map {
  get(tok) { return super.get(tokHash(tok)); }
  set(tok, v) { super.set(tokHash(tok), v); this.dirty = true; return this; }
  delete(tok) { const r = super.delete(tokHash(tok)) || super.delete(tok); this.dirty = true; return r; }
}
const sessions = new SessionStore();
for (const [h, v] of Object.entries(readJSON(SESS_FILE, {}))) if (v.exp > Date.now()) Map.prototype.set.call(sessions, h, v);
setInterval(() => {
  if (!sessions.dirty) return; sessions.dirty = false;
  const obj = {}; for (const [h, v] of Map.prototype.entries.call(sessions)) if (v.exp > Date.now()) obj[h] = v;
  writeJSONAtomic(SESS_FILE, obj);
}, 2000);

// ---------------------------------------------------------------- 环境变量管理的账号（admin + 最多 5 个 guest）
// 部署平台（Render 等）上设置：ADMIN_PASSWORD；GUEST1_PASSWORD … GUEST5_PASSWORD（可选 GUEST1_NAME … 改用户名，默认 guest1 …）。
// 每次启动都按环境变量同步：密码以环境变量为准（变了就更新，并让已登录的设备下线）；删掉某个 GUESTn_PASSWORD，对应账号停用。
// 这些账号的密码不能在网页上改、也不能删（会和环境变量打架），权限可以在「用户权限」页调整。
const GUEST_PERMS = () => ({
  clis: ['claude'], agents: ['*'], workspaces: ['*'],
  maxLevel: LEVELS.includes(process.env.GUEST_MAX_LEVEL) ? process.env.GUEST_MAX_LEVEL : 'edit', // 默认不给「完全放开」
  dailyLimit: Math.max(0, Number(process.env.GUEST_DAILY_LIMIT ?? 50) || 0),
});
function kickUser(id) { for (const [k, s] of sessions) if (s.userId === id) sessions.delete(k); }
// 环境变量账号的问题：除了写日志，也放在「用户权限」页顶部给管理员看（不用去部署平台翻日志）
const envWarnings = [];
function syncEnvAccounts() {
  let changed = false;
  const warn = msg => { envWarnings.push(msg); console.error('[relay] ' + msg); };
  // 常见的手误：值两边多了引号或空格（密码不会自动去掉空格，登录时也得输入）
  const checkValue = (key, v) => {
    if (/^\s|\s$/.test(v)) warn(`${key} 的值开头或结尾有空格；登录时也要带上这些空格，建议去掉`);
    if (/^(["'“”]).*\1$/.test(v.trim()) || /^["“].*["”]$/.test(v.trim())) warn(`${key} 的值两边有引号；引号会被当成密码的一部分，建议去掉`);
  };
  if (process.env.ADMIN_PASSWORD) checkValue('ADMIN_PASSWORD', process.env.ADMIN_PASSWORD);
  const setPw = (u, pw) => { if (checkPassword(u, pw)) return false; Object.assign(u, hashPassword(pw)); kickUser(u.id); changed = true; return true; };
  const adminPw = process.env.ADMIN_PASSWORD || '';
  if (adminPw) {
    const a = users.find(u => u.env === 'ADMIN') || users.find(u => u.username === 'admin' && u.role === 'admin');
    if (a) {
      if (a.env !== 'ADMIN' || a.disabled) { a.env = 'ADMIN'; a.disabled = false; changed = true; }
      if (setPw(a, adminPw)) console.log('[relay] 管理员 admin 的密码已按环境变量更新');
    }
  }
  for (let n = 1; n <= 5; n++) {
    const tag = 'GUEST' + n, pw = process.env[tag + '_PASSWORD'] || '';
    const name = String(process.env[tag + '_NAME'] || 'guest' + n).trim();
    let u = users.find(x => x.env === tag);
    if (!pw) {
      if (u && !u.disabled) { u.disabled = true; kickUser(u.id); changed = true; console.log(`[relay] 没有设置 ${tag}_PASSWORD，账号 ${u.username} 已停用`); }
      continue;
    }
    checkValue(tag + '_PASSWORD', pw);
    if (pw.length < 8) { warn(`${tag}_PASSWORD 太短（现在 ${pw.length} 位，至少 8 位），这个账号没有创建`); continue; }
    if (!/^[\w一-龥.-]{2,24}$/.test(name)) { warn(`${tag}_NAME「${name}」不合法：只能用字母、数字、中文和 _ . -，2～24 位（不能有空格），这个账号没有创建`); continue; }
    const clash = users.find(x => x.username === name && x !== u);
    if (clash) {
      if (!u && !clash.env) { u = clash; u.env = tag; changed = true; } // 网页上建过同名账号：接管它
      else { warn(`${tag}_NAME「${name}」和已有账号重名，这个账号没有创建`); continue; }
    }
    if (!u) {
      users.push({ id: newId('u'), username: name, role: 'user', disabled: false, createdAt: Date.now(), env: tag, perms: GUEST_PERMS(), ...hashPassword(pw) });
      changed = true; console.log(`[relay] 已按环境变量创建账号 ${name}`);
      continue;
    }
    if (u.username !== name || u.disabled) { u.username = name; u.disabled = false; changed = true; }
    if (setPw(u, pw)) console.log(`[relay] 账号 ${name} 的密码已按环境变量更新`);
  }
  if (changed) writeJSONAtomic(files.users, users);
}
syncEnvAccounts();
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function currentUser(req) {
  const tok = parseCookies(req).sid;
  const s = tok && sessions.get(tok);
  if (!s || s.exp < Date.now()) return null;
  const u = users.find(x => x.id === s.userId);
  return u && !u.disabled ? u : null;
}

// 简单登录限流：同 IP 10 分钟内失败 8 次即锁
const loginFails = new Map();
// 客户端 IP（登录限流用）。默认只认 TCP 连接的地址，完全不看 X-Forwarded-For —— 这个头谁都能伪造。
// 中继前面确实有反向代理（Render、Nginx…）时设 TRUST_PROXY=代理层数：每层代理会在末尾追加它看到的地址，
// 所以从右往左数第 N 个才是真实客户端；客户端自己伪造的内容永远在最左边，不会被采用。
const TRUST_PROXY = Math.max(0, parseInt(process.env.TRUST_PROXY || '0', 10) || 0);
function ipOf(req) {
  const sock = req.socket.remoteAddress || '';
  if (!TRUST_PROXY) return sock;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length >= TRUST_PROXY ? xff[xff.length - TRUST_PROXY] : sock;
}

// ---------------------------------------------------------------- agents（Mac 等执行端）
const agents = new Map(); // name -> { name, platform, clis, workspaces, lastSeen, running:Set, waiter }
function agentOnline(a) { return a && Date.now() - a.lastSeen < 45000; }
function publicAgent(a) {
  return {
    name: a.name, platform: a.platform, hostname: a.hostname, online: agentOnline(a),
    clis: a.clis, workspaces: a.workspaces, maxConcurrent: a.maxConcurrent, confine: !!a.confine, quota: a.quota || null,
    running: [...a.running], lastSeen: a.lastSeen, version: a.version,
  };
}

// ---------------------------------------------------------------- SSE 实时推送
const streams = new Set(); // { res, user }
function canSeeTask(user, t) { return user.role === 'admin' || t.userId === user.id; }
function push(event, data, filter) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const s of streams) {
    if (filter && !filter(s.user)) continue;
    s.res.write(line);
  }
}
function pushTask(t) { push('task', taskSummary(t), u => canSeeTask(u, t)); }
// 每个人只收到按自己权限筛过的设备信息（非管理员看不到额度、电脑名等，也看不到没权限的设备 / 目录 / CLI）
function pushAgents() { for (const s of streams) s.res.write(`event: agents\ndata: ${JSON.stringify(visibleAgents(s.user))}\n\n`); }
setInterval(() => { for (const s of streams) s.res.write(': ping\n\n'); }, 20000);

// 在线状态变化检测
const lastOnline = new Map();
setInterval(() => {
  let changed = false;
  for (const a of agents.values()) {
    const on = agentOnline(a);
    if (lastOnline.get(a.name) !== on) { lastOnline.set(a.name, on); changed = true; }
  }
  if (changed) pushAgents();
}, 5000);

// ---------------------------------------------------------------- 任务
function taskSummary(t) {
  const { events, ...rest } = t;
  return { ...rest, eventCount: events.length };
}
function convOf(t) { return db.convs.find(c => c.id === t.convId); }
function userName(id) { return users.find(u => u.id === id)?.username || '?'; }

function appendEvents(t, evs) {
  for (const e of evs) {
    // 连续文本合并，减少存储条数
    const last = t.events[t.events.length - 1];
    if (e.k === 'text' && last && last.k === 'text') last.d += e.d;
    else t.events.push({ ...e }); // 存副本：后续文本会合并进存储的这条，不能改到正要推给网页的原事件
    t.outputSize = (t.outputSize || 0) + (e.d ? e.d.length : 0);
  }
  if (t.outputSize > config.taskOutputLimit && !t.truncated) {
    t.truncated = true;
    t.events.push({ k: 'info', d: '（输出过长，后续内容不再保存，只显示最终结果）' });
  }
}

// 把排队任务派给某个 agent（每个对话串行，保证 resume 顺序）
function pickTasksFor(agent, free) {
  const out = [];
  if (free <= 0) return out;
  const active = db.tasks.filter(t => t.status === 'running' || t.status === 'dispatched');
  const busyConvs = new Set(active.map(t => t.convId));
  // 同一台设备的同一个工作目录一次只跑一个任务：agent 靠「任务前后目录对比」收集产出文件，
  // 并发时会把别的任务（可能是别的用户）写的文件也算成自己的产出
  // 开了 isolate（每个对话独立子文件夹）的目录不受这个限制，可以同时跑
  const isoWs = new Set((agent.workspaces || []).filter(w => w.isolate).map(w => w.name));
  const busyWs = new Set(active.filter(t => t.agent === agent.name && !isoWs.has(t.workspace)).map(t => t.workspace));
  for (const t of db.tasks) {
    if (out.length >= free) break;
    if (t.status !== 'queued' || t.agent !== agent.name || busyConvs.has(t.convId)) continue;
    // 目录被占用：这条继续排队，同时挡住同一对话后面的消息，保证对话内顺序
    if (busyWs.has(t.workspace)) {
      busyConvs.add(t.convId);
      if (t.waitingFor !== 'workspace') { t.waitingFor = 'workspace'; pushTask(t); } // 让网页显示在等什么
      continue;
    }
    const conv = convOf(t);
    if (!conv) { t.status = 'cancelled'; continue; }
    t.status = 'dispatched'; t.dispatchedAt = Date.now(); delete t.waitingFor;
    t.resumeSessionId = conv.sessionId || null;
    busyConvs.add(t.convId); if (!isoWs.has(t.workspace)) busyWs.add(t.workspace);
    out.push({
      id: t.id, convId: t.convId, username: userName(t.userId), cli: t.cli, prompt: t.prompt, workspace: t.workspace, level: t.level,
      model: t.model || null, resumeSessionId: t.resumeSessionId,
      inputs: (t.inputs || []).map(f => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })),
    });
    pushTask(t);
  }
  if (out.length) saveSoon();
  return out;
}
function wakeAgent(name) {
  const a = agents.get(name);
  if (a && a.waiter) a.waiter();
}

// 派出去却一直没回音的任务（agent 掉线）→ 失败
setInterval(() => {
  for (const t of db.tasks) {
    // 点了停止 30 秒还没停下：中继这边直接判为已取消，不让对话一直卡着
    if ((t.status === 'dispatched' || t.status === 'running') && t.cancelRequested && Date.now() - (t.cancelRequestedAt || 0) > 30000) {
      t.status = 'cancelled'; t.error = '执行端 30 秒内没有停下，已强制结束这条任务'; t.endedAt = Date.now();
      agents.get(t.agent)?.running.delete(t.id);
      saveSoon(); pushTask(t); wakeAgent(t.agent);
      continue;
    }
    if ((t.status === 'dispatched' || t.status === 'running') && !agentOnline(agents.get(t.agent))) {
      const since = t.lastEventAt || t.dispatchedAt || 0;
      if (Date.now() - since > 90000) {
        t.status = 'failed'; t.error = '执行端离线，任务中断'; t.endedAt = Date.now();
        saveSoon(); pushTask(t);
      }
    }
  }
}, 15000);

// ---------------------------------------------------------------- HTTP 工具
function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const fail = (code, msg) => { throw new HttpError(code, msg); };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const f = path.normalize(path.join(WEB_DIR, decodeURIComponent(p)));
  if (!f.startsWith(WEB_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function agentAuth(req) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = Buffer.from(tok), b = Buffer.from(config.agentToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail(401, 'agent token 不对');
}

// ---------------------------------------------------------------- 路由
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const m = req.method;
  let mm;

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);
  if (p === '/api/health') return send(res, 200, { ok: true }); // 部署平台的健康检查，不需要登录

  // 防 CSRF：写操作必须是 JSON，或带自定义头的上传（跨站表单两者都发不出来，必触发预检）
  const isUpload = p === '/api/uploads' && req.headers['x-upload'] === '1';
  if (m !== 'GET' && !p.startsWith('/api/agent/') && !isUpload && !(req.headers['content-type'] || '').includes('application/json')) fail(415, '需要 JSON');

  // ===== agent 接口 =====
  if (p.startsWith('/api/agent/')) {
    agentAuth(req);
    if (p === '/api/agent/hello' && m === 'POST') {
      const b = await readBody(req);
      if (!b.name) fail(400, '缺少 name');
      const old = agents.get(b.name);
      const a = {
        name: String(b.name).slice(0, 40), platform: b.platform, hostname: b.hostname, version: b.version,
        clis: b.clis || {}, workspaces: b.workspaces || [], maxConcurrent: b.maxConcurrent || 1, confine: !!b.confine,
        quota: old?.quota || null, probes: old?.probes || [], // 订阅额度（最近一次）、待执行的即时查询
        lastSeen: Date.now(), running: old?.running || new Set(), waiter: null,
      };
      agents.set(a.name, a);
      // agent 重启：它报告的正在跑的任务以外的 running 任务都已丢失
      const alive = new Set(b.running || []);
      for (const t of db.tasks) {
        if (t.agent === a.name && (t.status === 'running' || t.status === 'dispatched') && !alive.has(t.id)) {
          t.status = 'failed'; t.error = '执行端重启，任务中断'; t.endedAt = Date.now(); pushTask(t);
        }
      }
      a.running = new Set([...alive]);
      saveSoon(); pushAgents();
      return send(res, 200, { ok: true, serverTime: Date.now() });
    }
    if (p === '/api/agent/poll' && m === 'GET') {
      const name = url.searchParams.get('name');
      const a = agents.get(name);
      if (!a) fail(409, '请先 hello');
      const free = Number(url.searchParams.get('free') || 0);
      a.lastSeen = Date.now();
      const collect = () => {
        // 停止指令只发一次；10 秒后还没停才补发一次（防丢），否则会让 agent 空转
        const now = Date.now();
        const cancel = db.tasks.filter(t => t.agent === name && t.cancelRequested && (t.status === 'running' || t.status === 'dispatched')
          && (!t.cancelSentAt || now - t.cancelSentAt > 10000)).map(t => { t.cancelSentAt = now; return t.id; });
        const tasks = pickTasksFor(a, free);
        const probes = (a.probes || []).splice(0); // 即时查询（额度）不占任务名额
        return { tasks, cancel, probes };
      };
      let r = collect();
      if (r.tasks.length || r.cancel.length || r.probes.length) return send(res, 200, r);
      // 长轮询：最多挂 25 秒，有新任务立即返回
      let done = false;
      const finish = () => {
        if (done) return; done = true; clearTimeout(timer); a.waiter = null; a.lastSeen = Date.now();
        if (res.writableEnded) return;
        send(res, 200, collect());
      };
      const timer = setTimeout(finish, 25000);
      a.waiter = finish;
      req.on('close', () => { done = true; clearTimeout(timer); if (a.waiter === finish) a.waiter = null; });
      return;
    }
    // agent 上报订阅额度：任务里顺带看到的，或者回复网页的即时查询（probeId）
    if (p === '/api/agent/quota' && m === 'POST') {
      const b = await readBody(req);
      const a = agents.get(b.agent); if (!a) fail(409, '请先 hello');
      const q = sanitizeQuota(b.quota);
      if (q) { a.quota = { ...q, at: Date.now() }; pushAgents(); }
      if (b.probeId) probeWaiters.get(b.probeId)?.({ quota: a.quota, error: q ? null : String(b.error || '查询失败').slice(0, 300) });
      return send(res, 200, { ok: true });
    }
    // agent 上传 AI 产出的文件（原始字节），返回文件 id
    if (p === '/api/agent/files' && m === 'POST') {
      const t = db.tasks.find(x => x.id === req.headers['x-task']);
      if (!t) fail(404, '任务不存在');
      const buf = await readRaw(req, MAX_FILE);
      const id = newId('f');
      fs.writeFileSync(blobPath(id), buf);
      return send(res, 200, { id, size: buf.length });
    }
    // agent 下载用户附件
    if ((mm = p.match(/^\/api\/agent\/files\/([\w-]+)$/)) && m === 'GET') {
      const hit = findFile(mm[1]);
      if (!hit || !hit.meta.stored) fail(404, '文件不存在');
      return sendFile(req, res, hit.meta, true);
    }
    if (p === '/api/agent/events' && m === 'POST') {
      const b = await readBody(req, 5_000_000);
      const a = agents.get(b.agent);
      if (a) a.lastSeen = Date.now();
      for (const up of b.updates || []) {
        const t = db.tasks.find(x => x.id === up.taskId);
        if (!t || ['done', 'failed', 'cancelled'].includes(t.status)) continue;
        t.lastEventAt = Date.now();
        if (up.status === 'running' && t.status !== 'running') { t.status = 'running'; t.startedAt = Date.now(); a?.running.add(t.id); }
        if (up.events?.length) {
          const room = t.truncated ? [] : up.events;
          appendEvents(t, room);
          push('chunk', { taskId: t.id, events: room }, u => canSeeTask(u, t));
        }
        if (up.sessionId) {
          t.sessionId = up.sessionId;
          const c = convOf(t); if (c) c.sessionId = up.sessionId;
        }
        if (up.usage) t.usage = up.usage;
        if (up.outputs) t.outputs = sanitizeOutputs(up.outputs, t);
        if (up.linkMap) t.linkMap = up.linkMap;
        if (up.final) {
          t.status = up.final.status; // done | failed | cancelled
          t.result = up.final.result || '';
          t.error = up.final.error || null;
          t.exitCode = up.final.exitCode;
          t.endedAt = Date.now();
          a?.running.delete(t.id);
          const c = convOf(t); if (c) c.updatedAt = Date.now();
          // 这个对话还有排队的后续消息 → 叫醒 agent
          wakeAgent(t.agent);
        }
        saveSoon(); pushTask(t);
      }
      if (a) pushAgents();
      return send(res, 200, { ok: true });
    }
    fail(404, 'no route');
  }

  // ===== 登录 =====
  if (p === '/api/login' && m === 'POST') {
    // 两道限流，都是 10 分钟窗口：同一 IP 失败 8 次；同一账号失败 20 次（防换着 IP 猜同一个账号）
    const counter = key => {
      const c = loginFails.get(key) || { n: 0, t: Date.now() };
      if (Date.now() - c.t > 600000) { c.n = 0; c.t = Date.now(); }
      return c;
    };
    if (loginFails.size > 5000) for (const [k, c] of loginFails) if (Date.now() - c.t > 600000) loginFails.delete(k);
    const ip = ipOf(req), lf = counter('ip:' + ip);
    if (lf.n >= 8) fail(429, '失败次数过多，10 分钟后再试');
    const b = await readBody(req);
    const u = users.find(x => x.username === String(b.username || '').trim());
    const uf = u ? counter('user:' + u.id) : null; // 只给存在的账号计数，免得随便编的用户名把表撑大
    if (uf && uf.n >= 20) fail(429, '这个账号失败次数过多，10 分钟后再试');
    if (!u || u.disabled || !checkPassword(u, b.password || '')) {
      lf.n++; loginFails.set('ip:' + ip, lf);
      if (uf) { uf.n++; loginFails.set('user:' + u.id, uf); }
      fail(401, '用户名或密码错误');
    }
    loginFails.delete('ip:' + ip); loginFails.delete('user:' + u.id);
    const tok = crypto.randomBytes(32).toString('base64url');
    const maxAge = config.sessionDays * 86400;
    sessions.set(tok, { userId: u.id, exp: Date.now() + maxAge * 1000 });
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    return send(res, 200, { user: publicUser(u) }, {
      'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`,
    });
  }
  if (p === '/api/logout' && m === 'POST') {
    const tok = parseCookies(req).sid; if (tok) sessions.delete(tok);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }

  const user = currentUser(req);
  if (!user) fail(401, '未登录');
  const isAdmin = user.role === 'admin';

  if (p === '/api/me' && m === 'GET') return send(res, 200, { user: publicUser(user), today: tasksToday(user.id) });
  if (p === '/api/me/password' && m === 'POST') {
    const b = await readBody(req);
    if (user.env) fail(400, '这个账号的密码由部署平台的环境变量设置，请到那里修改');
    if (!checkPassword(user, b.old || '')) fail(400, '原密码不对');
    if (String(b.password || '').length < 6) fail(400, '新密码至少 6 位');
    Object.assign(user, hashPassword(b.password)); usersDirty = true;
    return send(res, 200, { ok: true });
  }

  // SSE
  if (p === '/api/stream' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    const s = { res, user };
    streams.add(s);
    res.write(`event: agents\ndata: ${JSON.stringify(visibleAgents(user))}\n\n`);
    req.on('close', () => streams.delete(s));
    return;
  }

  if (p === '/api/agents' && m === 'GET') {
    const out = { agents: visibleAgents(user) };
    if (isAdmin) out.agentToken = config.agentToken;
    return send(res, 200, out);
  }

  // ===== 备份导出（zip，边生成边下载）：一个对话，或我的全部对话（管理员加 ?all=1 导出所有人的）=====
  const exportMm = p.match(/^\/api\/convs\/([\w-]+)\/export$/);
  if (m === 'GET' && (exportMm || p === '/api/export')) {
    let convs, title;
    if (exportMm) {
      const c = db.convs.find(x => x.id === exportMm[1]);
      if (!c || (!isAdmin && c.userId !== user.id)) fail(404, '对话不存在');
      convs = [c]; title = c.title;
    } else {
      convs = db.convs.filter(c => (isAdmin && url.searchParams.get('all')) || c.userId === user.id).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (!convs.length) fail(404, '还没有对话');
      title = '全部对话';
    }
    try { await exportConvs(res, { convs, title, blobPath, tasksOf: c => db.tasks.filter(t => t.convId === c.id) }); }
    catch (e) { console.error('[relay] 导出失败', e); res.destroy(); } // 响应头已经发出，只能断开
    return;
  }

  // ===== 对话 =====
  if (p === '/api/convs' && m === 'GET') {
    const list = db.convs.filter(c => isAdmin && url.searchParams.get('all') ? true : c.userId === user.id)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(c => ({ ...c, username: userName(c.userId) }));
    return send(res, 200, { convs: list });
  }
  if (p === '/api/convs' && m === 'POST') {
    const b = await readBody(req);
    checkRunPerms(user, b);
    const c = {
      id: newId('c'), userId: user.id, title: String(b.title || '新对话').slice(0, 60),
      agent: b.agent, cli: b.cli, workspace: b.workspace, level: b.level, model: b.model ? String(b.model).slice(0, 100) : null,
      sessionId: null, createdAt: Date.now(), updatedAt: Date.now(),
    };
    db.convs.push(c); saveSoon();
    return send(res, 200, { conv: c });
  }
  if ((mm = p.match(/^\/api\/convs\/([\w-]+)$/))) {
    const c = db.convs.find(x => x.id === mm[1]);
    if (!c || (!isAdmin && c.userId !== user.id)) fail(404, '对话不存在');
    if (m === 'GET') {
      const tasks = db.tasks.filter(t => t.convId === c.id);
      return send(res, 200, { conv: c, tasks });
    }
    if (m === 'PATCH') {
      const b = await readBody(req);
      if (b.title) c.title = String(b.title).slice(0, 60);
      if ('model' in b) c.model = b.model ? String(b.model).slice(0, 100) : null; // 换模型不影响上下文续接
      if (b.level) { checkRunPerms(user, { ...c, level: b.level }); c.level = b.level; }
      if (b.resetSession) c.sessionId = null;
      saveSoon(); return send(res, 200, { conv: c });
    }
    if (m === 'DELETE') {
      for (const t of db.tasks) if (t.convId === c.id && ['running', 'dispatched'].includes(t.status) && !t.cancelRequested) { t.cancelRequested = true; t.cancelRequestedAt = Date.now(); wakeAgent(t.agent); }
      db.convs = db.convs.filter(x => x !== c);
      for (const t of db.tasks) if (t.convId === c.id && !['running', 'dispatched'].includes(t.status)) { removeBlobs(t.outputs); removeBlobs(t.inputs); }
      removeBlobs(db.uploads.filter(f => f.convId === c.id));
      db.uploads = db.uploads.filter(f => f.convId !== c.id);
      db.tasks = db.tasks.filter(t => t.convId !== c.id || ['running', 'dispatched'].includes(t.status));
      saveSoon(); return send(res, 200, { ok: true });
    }
  }
  if ((mm = p.match(/^\/api\/convs\/([\w-]+)\/send$/)) && m === 'POST') {
    const c = db.convs.find(x => x.id === mm[1]);
    if (!c || c.userId !== user.id) fail(404, '对话不存在');
    const b = await readBody(req);
    const prompt = String(b.prompt || '').trim();
    const attachIds = Array.isArray(b.attachments) ? b.attachments.slice(0, 10) : [];
    const inputs = attachIds.map(id => db.uploads.find(f => f.id === id && f.userId === user.id && f.convId === c.id)).filter(Boolean);
    if (inputs.length !== attachIds.length) fail(400, '附件已失效，请重新上传');
    if (!prompt && !inputs.length) fail(400, '内容为空');
    if (prompt.length > 100000) fail(400, '内容太长');
    checkRunPerms(user, c);
    const lim = user.perms.dailyLimit || 0;
    if (lim > 0 && tasksToday(user.id) >= lim) fail(429, `今日额度已用完（${lim} 次）`);
    if (c.title === '新对话' && prompt) c.title = prompt.replace(/\s+/g, ' ').slice(0, 30);
    const t = {
      id: newId('t'), convId: c.id, userId: user.id, agent: c.agent, cli: c.cli, workspace: c.workspace,
      level: c.level, model: c.model, prompt, status: 'queued', createdAt: Date.now(), events: [], inputs,
    };
    db.uploads = db.uploads.filter(f => !inputs.includes(f));
    db.tasks.push(t); c.updatedAt = Date.now(); saveSoon();
    pushTask(t); wakeAgent(c.agent);
    return send(res, 200, { task: taskSummary(t) });
  }

  // ===== 任务管理 =====
  if (p === '/api/tasks' && m === 'GET') {
    const st = url.searchParams.get('status');
    const uid = url.searchParams.get('user');
    let list = db.tasks.filter(t => canSeeTask(user, t));
    if (st) list = list.filter(t => t.status === st);
    if (uid && isAdmin) list = list.filter(t => t.userId === uid);
    list = list.sort((a, b) => b.createdAt - a.createdAt).slice(0, 300)
      .map(t => ({ ...taskSummary(t), username: userName(t.userId), convTitle: convOf(t)?.title }));
    return send(res, 200, { tasks: list });
  }
  if ((mm = p.match(/^\/api\/tasks\/([\w-]+)(\/cancel|\/retry)?$/))) {
    const t = db.tasks.find(x => x.id === mm[1]);
    if (!t || !canSeeTask(user, t)) fail(404, '任务不存在');
    if (!mm[2] && m === 'GET') return send(res, 200, { task: { ...t, username: userName(t.userId), convTitle: convOf(t)?.title } });
    if (mm[2] === '/cancel' && m === 'POST') {
      if (t.status === 'queued') { t.status = 'cancelled'; t.error = '已手动停止'; t.endedAt = Date.now(); }
      else if (['running', 'dispatched'].includes(t.status) && !t.cancelRequested) {
        t.cancelRequested = true; t.cancelRequestedAt = Date.now();
        console.log(`[relay] ✕ ${new Date().toISOString().slice(11, 23)} 请求停止 ${t.id}（agent ${agents.get(t.agent)?.waiter ? '在等待，立即通知' : '不在等待'}）`);
        wakeAgent(t.agent);
      }
      saveSoon(); pushTask(t); return send(res, 200, { ok: true });
    }
    if (mm[2] === '/retry' && m === 'POST') {
      const c = convOf(t); if (!c) fail(400, '对话已删除');
      if (t.userId !== user.id) fail(403, '只能重试自己的任务');
      checkRunPerms(user, c);
      const nt = { ...t, id: newId('t'), status: 'queued', createdAt: Date.now(), events: [], result: undefined, error: null,
        startedAt: undefined, endedAt: undefined, cancelRequested: false, outputSize: 0, truncated: false, sessionId: undefined,
        outputs: undefined, linkMap: undefined, usage: undefined, cancelRequestedAt: undefined, cancelSentAt: undefined, exitCode: undefined };
      db.tasks.push(nt); saveSoon(); pushTask(nt); wakeAgent(nt.agent);
      return send(res, 200, { task: taskSummary(nt) });
    }
  }
  // ===== 文件 =====
  // 用户上传附件：原始字节 + 头信息（X-Upload: 1 防 CSRF）
  if (p === '/api/uploads' && m === 'POST') {
    const c = db.convs.find(x => x.id === req.headers['x-conv']);
    if (!c || c.userId !== user.id) fail(404, '对话不存在');
    if (db.uploads.filter(f => f.userId === user.id).length > 50) fail(429, '未发送的附件太多');
    const name = decodeURIComponent(String(req.headers['x-name'] || 'file')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file';
    const buf = await readRaw(req, MAX_FILE);
    if (!buf.length) fail(400, '空文件');
    const meta = { id: newId('f'), kind: 'input', name, mime: String(req.headers['x-mime'] || 'application/octet-stream').slice(0, 100),
      size: buf.length, userId: user.id, convId: c.id, stored: true, createdAt: Date.now() };
    fs.writeFileSync(blobPath(meta.id), buf);
    db.uploads.push(meta); saveSoon();
    return send(res, 200, { file: meta });
  }
  if ((mm = p.match(/^\/api\/uploads\/([\w-]+)$/)) && m === 'DELETE') {
    const f = db.uploads.find(x => x.id === mm[1] && x.userId === user.id);
    if (f) { removeBlobs([f]); db.uploads = db.uploads.filter(x => x !== f); saveSoon(); }
    return send(res, 200, { ok: true });
  }
  if ((mm = p.match(/^\/api\/files\/([\w-]+)$/)) && m === 'GET') {
    const hit = findFile(mm[1]);
    const okUser = hit && (hit.task ? canSeeTask(user, hit.task) : hit.meta.userId === user.id || isAdmin);
    if (!okUser || !hit.meta.stored) fail(404, '文件不存在');
    return sendFile(req, res, hit.meta, url.searchParams.get('dl') === '1');
  }

  // 订阅额度：GET 拿最近一次的；POST 让 Mac 立刻查一次（相当于在 Mac 上运行 /usage）
  if (p === '/api/quota') {
    if (!isAdmin) fail(403, '只有管理员能看额度');
    const body = m === 'POST' ? await readBody(req) : {};
    const name = url.searchParams.get('agent') || body.agent || null;
    const list = visibleAgents(user);
    const pa = list.find(x => x.name === name) || list.find(x => x.online) || list[0];
    if (!pa) fail(404, '没有可用的设备');
    const a = agents.get(pa.name);
    if (m === 'GET') return send(res, 200, { agent: a.name, online: agentOnline(a), quota: a.quota });
    if (m === 'POST') {
      if (!agentOnline(a)) return send(res, 200, { agent: a.name, online: false, quota: a.quota, error: 'Mac 离线，显示的是上次的数据' });
      // 网页每 5 分钟自动查一次：带 maxAge，数据够新就直接返回，不让 Mac 重复跑（开着好几个网页时尤其重要）
      const maxAge = Math.max(0, Number(body.maxAge) || 0);
      if (maxAge && a.quota?.at && Date.now() - a.quota.at < maxAge) return send(res, 200, { agent: a.name, online: true, quota: a.quota, cached: true });
      // 同一时间只让 Mac 跑一次，其他请求等同一个结果
      a.probing ||= requestProbe(a, 'usage').finally(() => { a.probing = null; });
      const r = await a.probing;
      return send(res, 200, { agent: a.name, online: true, quota: r.quota, error: r.error || null });
    }
  }

  if (p === '/api/stats' && m === 'GET') {
    const mine = isAdmin ? db.tasks : db.tasks.filter(t => t.userId === user.id);
    const by = {}; for (const t of mine) by[t.status] = (by[t.status] || 0) + 1;
    return send(res, 200, { byStatus: by, today: tasksToday(user.id) });
  }

  // ===== 用户管理（仅管理员）=====
  if (p.startsWith('/api/users')) {
    if (!isAdmin) fail(403, '需要管理员');
    if (p === '/api/users' && m === 'GET') {
      return send(res, 200, { users: users.map(u => ({ ...publicUser(u), today: tasksToday(u.id), total: db.tasks.filter(t => t.userId === u.id).length })), envWarnings });
    }
    if (p === '/api/users' && m === 'POST') {
      const b = await readBody(req);
      const name = String(b.username || '').trim();
      if (!/^[\w一-龥.-]{2,24}$/.test(name)) fail(400, '用户名 2-24 位，字母数字中文');
      if (users.some(u => u.username === name)) fail(400, '用户名已存在');
      if (String(b.password || '').length < 6) fail(400, '密码至少 6 位');
      const u = { id: newId('u'), username: name, role: b.role === 'admin' ? 'admin' : 'user', disabled: false, createdAt: Date.now(),
        perms: sanitizePerms(b.perms || DEFAULT_PERMS), ...hashPassword(b.password) };
      users.push(u); usersDirty = true;
      return send(res, 200, { user: publicUser(u) });
    }
    if ((mm = p.match(/^\/api\/users\/([\w-]+)$/))) {
      const u = users.find(x => x.id === mm[1]); if (!u) fail(404, '用户不存在');
      if (m === 'PUT') {
        const b = await readBody(req);
        if (u.id === user.id && (b.role === 'user' || b.disabled)) fail(400, '不能降级或停用自己');
        if (b.role) u.role = b.role === 'admin' ? 'admin' : 'user';
        if (typeof b.disabled === 'boolean') u.disabled = b.disabled;
        if (b.perms) u.perms = sanitizePerms(b.perms);
        if (b.password) {
          if (u.env) fail(400, '这个账号的密码由部署平台的环境变量设置，请到那里修改');
          if (String(b.password).length < 6) fail(400, '密码至少 6 位');
          Object.assign(u, hashPassword(b.password));
        }
        if (u.disabled) for (const [k, s] of sessions) if (s.userId === u.id) sessions.delete(k);
        usersDirty = true; return send(res, 200, { user: publicUser(u) });
      }
      if (m === 'DELETE') {
        if (u.id === user.id) fail(400, '不能删除自己');
        if (u.env) fail(400, '这个账号由环境变量管理：删掉部署平台上的对应环境变量，重启后就会停用');
        users = users.filter(x => x !== u); usersDirty = true;
        for (const [k, s] of sessions) if (s.userId === u.id) sessions.delete(k);
        return send(res, 200, { ok: true });
      }
    }
  }
  if (p === '/api/agent-token/rotate' && m === 'POST') {
    if (!isAdmin) fail(403, '需要管理员');
    if (ENV_AGENT_TOKEN) fail(400, 'agent token 由环境变量 AGENT_TOKEN 固定，请到部署平台修改');
    config.agentToken = crypto.randomBytes(24).toString('base64url');
    writeJSONAtomic(files.config, config);
    return send(res, 200, { agentToken: config.agentToken });
  }

  fail(404, 'no route');
}

function visibleAgents(user) {
  return [...agents.values()].filter(a => allow(user.perms.agents, a.name)).map(a => {
    const pa = publicAgent(a);
    if (user.role !== 'admin') {
      pa.workspaces = pa.workspaces.filter(w => allow(user.perms.workspaces, w.name));
      pa.clis = Object.fromEntries(Object.entries(pa.clis).filter(([k]) => allow(user.perms.clis, k)));
      // 非管理员不需要知道这些：订阅额度（是管理员的 Claude 账号）、电脑名、并发、正在跑的任务、文件夹限制开关
      delete pa.quota; delete pa.hostname; delete pa.running; delete pa.maxConcurrent; delete pa.confine; delete pa.version;
    }
    return pa;
  });
}
function sanitizePerms(p) {
  const arr = v => Array.isArray(v) ? v.map(String).filter(Boolean).slice(0, 50) : ['*'];
  return {
    clis: arr(p.clis), agents: arr(p.agents), workspaces: arr(p.workspaces),
    maxLevel: LEVELS.includes(p.maxLevel) ? p.maxLevel : 'read',
    dailyLimit: Math.max(0, Math.min(100000, Number(p.dailyLimit) || 0)),
  };
}
// 订阅额度：只留网页要用的字段，防止 agent 传来奇怪的东西
function sanitizeQuota(q) {
  if (!q || !Array.isArray(q.windows)) return null;
  const windows = q.windows.slice(0, 8).map(w => ({
    key: String(w.key || '').slice(0, 40), label: String(w.label || '').slice(0, 40),
    percent: Math.max(0, Math.min(100, Math.round(Number(w.percent) || 0))),
    resetsAt: Number(w.resetsAt) || null, resetsText: w.resetsText ? String(w.resetsText).slice(0, 80) : undefined,
    status: w.status ? String(w.status).slice(0, 30) : undefined,
  })).filter(w => w.key);
  return windows.length ? { windows, source: q.source === 'usage' ? 'usage' : 'task' } : null;
}
// 网页点「额度」：让 agent 立刻跑一次 /usage，最多等 45 秒
const probeWaiters = new Map(); // probeId → resolve
function requestProbe(a, kind) {
  return new Promise(resolve => {
    const id = newId('p');
    const timer = setTimeout(() => { probeWaiters.delete(id); resolve({ quota: a.quota, error: '等待 Mac 回应超时' }); }, 45000);
    probeWaiters.set(id, r => { clearTimeout(timer); probeWaiters.delete(id); resolve(r); });
    (a.probes ||= []).push({ id, kind });
    wakeAgent(a.name);
  });
}
function sanitizeOutputs(list, t) {
  const str = (v, n) => String(v ?? '').slice(0, n);
  return (Array.isArray(list) ? list : []).slice(0, 200).map(f => {
    const stored = !!(f.id && /^f_[0-9a-f]{12}$/.test(f.id) && fs.existsSync(blobPath(f.id)));
    return {
      id: stored ? f.id : newId('f'), kind: 'output', stored, taskId: t.id,
      path: str(f.path, 500), name: str(f.name || path.basename(String(f.path || 'file')), 200),
      mime: str(f.mime || 'application/octet-stream', 100), size: Number(f.size) || 0,
      change: ['add', 'modify', 'delete', 'ref'].includes(f.change) ? f.change : 'add',
      diff: f.diff ? str(f.diff, 80000) : undefined, diffStat: f.diffStat || undefined,
      note: f.note ? str(f.note, 200) : undefined,
    };
  });
}
function checkRunPerms(user, b) {
  const a = agents.get(b.agent);
  if (!a) fail(400, '执行端不存在或从未上线');
  if (!allow(user.perms.agents, b.agent)) fail(403, '无权使用这台设备');
  if (!allow(user.perms.clis, b.cli)) fail(403, `无权使用 ${b.cli}`);
  if (!a.clis[b.cli]?.ok) fail(400, `这台设备上 ${b.cli} 不可用`);
  if (!a.workspaces.some(w => w.name === b.workspace)) fail(400, '工作目录不存在');
  if (!allow(user.perms.workspaces, b.workspace)) fail(403, '无权使用这个工作目录');
  if (!levelAllowed(user, b.level)) fail(403, `权限级别超出（你最高：${user.perms.maxLevel}）`);
  const ws = a.workspaces.find(w => w.name === b.workspace);
  if (ws.maxLevel && LEVELS.indexOf(b.level) > LEVELS.indexOf(ws.maxLevel)) fail(403, `这个目录最高只允许 ${ws.maxLevel}`);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    if (res.headersSent) return res.end();
    const code = err instanceof HttpError ? err.code : 500;
    if (code === 500) console.error(err);
    send(res, code, { error: err.message || '服务器错误' });
  });
});
server.requestTimeout = 0; // 长轮询/SSE 需要
server.listen(PORT, HOST, () => {
  console.log(`[relay] 已启动 http://${HOST}:${PORT}`);
  console.log(`[relay] agent token: ${ENV_AGENT_TOKEN ? '（来自环境变量 AGENT_TOKEN，不在日志里显示）' : config.agentToken}`);
  if (TRUST_PROXY) console.log(`[relay] 信任 ${TRUST_PROXY} 层反向代理的 X-Forwarded-For`);
});
module.exports = { server, config };
